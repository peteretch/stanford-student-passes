import {
  assertConfigured,
  config,
  listCustomersByTag,
  listMembershipsByProgram,
  listAccessListEntries,
  deleteAccessListEntry,
} from '../lib/vivenu.js';
import { syncCustomer } from '../lib/enroll.js';
import { adapt } from '../lib/http.js';

const PAGE_SIZE = 1000;

/**
 * Nightly safety net for the webhook, in three passes:
 *
 *   1. Enrol every tagged customer that is not already enrolled.
 *   2. Revoke every active membership whose customer no longer holds the tag.
 *   3. Delete access list codes whose membership is no longer active.
 *
 * Webhook delivery is at-least-once but not guaranteed: a call that exhausts
 * its six retries is dropped, and vivenu cannot replay a range of events. A
 * missed enrolment is an inconvenience; a missed revocation leaves a working
 * gate credential with someone who is no longer eligible, so pass 2 matters
 * more than pass 1.
 *
 * Because syncCustomer is idempotent, re-running is free — already-correct
 * customers cost one lookup each and change nothing.
 *
 * Add ?dryRun=1 to report what would change without writing.
 */
export default async function handler(req, res) {
  const http = adapt(req, res);

  try {
    assertConfigured();
  } catch (err) {
    return http.send(500, { error: err.message });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) return http.send(500, { error: 'CRON_SECRET is not configured' });
  if (http.header('authorization') !== `Bearer ${secret}`) {
    return http.send(401, { error: 'Unauthorized' });
  }

  if (!config.requiredTags.length) {
    return http.send(500, { error: 'VIVENU_REQUIRED_TAGS is empty — refusing to sweep every customer' });
  }

  const dryRun = ['1', 'true'].includes(http.query('dryRun') ?? '');

  const [tag] = config.requiredTags;
  const started = Date.now();
  const counts = {
    enrolled: 0,
    'already-enrolled': 0,
    'not-eligible': 0,
    revoked: 0,
    'would-enrol': 0,
    'would-revoke': 0,
    orphansDeleted: 0,
    failed: 0,
  };
  const changes = [];
  const failures = [];

  const record = (result) => {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    if (['enrolled', 'revoked', 'would-enrol', 'would-revoke'].includes(result.status)) {
      changes.push({ customerId: result.customerId, action: result.status, membershipId: result.membershipId });
      console.log(`reconcile: ${result.status} ${result.customerId} ${result.membershipId}`);
    }
  };

  // --- Pass 1: enrol tagged customers -------------------------------------
  const taggedIds = new Set();
  let skip = 0;
  let total = 0;
  do {
    const page = await listCustomersByTag(tag, { top: PAGE_SIZE, skip });
    total = page.total;
    if (!page.docs.length) break;

    for (const customer of page.docs) {
      taggedIds.add(customer._id);
      try {
        record(await syncCustomer(customer._id, { dryRun, allowRevoke: true }));
      } catch (err) {
        counts.failed++;
        failures.push({ customerId: customer._id, phase: 'enrol', error: err.message });
        console.error(`reconcile: failed ${customer._id}: ${err.message}`);
      }
    }
    skip += page.docs.length;
  } while (skip < total);

  // --- Pass 2: revoke members who lost the tag ----------------------------
  // Driven from the membership side: a customer who lost the tag no longer
  // appears in the pass 1 query at all, so nothing else would ever look at them.
  const active = await listMembershipsByProgram({ status: 'active' });
  for (const membership of active) {
    if (taggedIds.has(membership.customerId)) continue;
    try {
      record(await syncCustomer(membership.customerId, { dryRun, allowRevoke: true }));
    } catch (err) {
      counts.failed++;
      failures.push({ customerId: membership.customerId, phase: 'revoke', error: err.message });
      console.error(`reconcile: revoke failed ${membership.customerId}: ${err.message}`);
    }
  }

  // --- Pass 3: delete orphaned codes --------------------------------------
  // Codes whose membership is no longer active — left behind by the
  // non-idempotent create, or by a revocation that failed midway.
  const byId = new Map((await listMembershipsByProgram()).map((m) => [m._id, m]));
  const entries = await listAccessListEntries();
  for (const entry of entries) {
    const membership = byId.get(entry.externalCode);
    if (!membership || membership.status === 'active') continue;
    try {
      if (!dryRun) await deleteAccessListEntry(entry._id);
      counts.orphansDeleted++;
      changes.push({ action: dryRun ? 'would-delete-orphan' : 'deleted-orphan', entryId: entry._id, externalCode: entry.externalCode });
      console.log(`reconcile: orphan ${entry._id} -> ${entry.externalCode}`);
    } catch (err) {
      counts.failed++;
      failures.push({ entryId: entry._id, phase: 'orphan', error: err.message });
    }
  }

  const summary = {
    tag,
    dryRun,
    scannedTagged: taggedIds.size,
    activeMemberships: active.length,
    accessListEntries: entries.length,
    ...counts,
    changes,
    failures,
    ms: Date.now() - started,
  };
  console.log('reconcile summary:', JSON.stringify(summary));

  // Non-2xx on failures so it surfaces in Vercel's cron log instead of
  // looking like a clean run.
  return http.send(counts.failed ? 500 : 200, summary);
}
