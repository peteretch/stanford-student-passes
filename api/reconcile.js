import { assertConfigured, config, listCustomersByTag } from '../lib/vivenu.js';
import { enrollCustomer } from '../lib/enroll.js';

const json = (status, body) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

const PAGE_SIZE = 1000;

/**
 * Nightly safety net for the webhook.
 *
 * Webhook delivery is at-least-once but not guaranteed: a call that exhausts
 * its six retries is dropped, and vivenu cannot replay a range of events. This
 * sweeps every customer holding the gating tag and enrols any that slipped
 * through. Because enrollCustomer is idempotent, re-running is free — already
 * enrolled customers cost one lookup each and change nothing.
 *
 * No cursor is kept: the tag-filtered population is small and a full sweep is
 * more robust than a timestamp window, which can miss records if a run fails.
 */
export default async function handler(request) {
  try {
    assertConfigured();
  } catch (err) {
    return json(500, { error: err.message });
  }

  // Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Without this the
  // endpoint is world-callable.
  const secret = process.env.CRON_SECRET;
  if (!secret) return json(500, { error: 'CRON_SECRET is not configured' });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return json(401, { error: 'Unauthorized' });
  }

  if (!config.requiredTags.length) {
    return json(500, { error: 'VIVENU_REQUIRED_TAGS is empty — refusing to sweep every customer' });
  }

  // The first required tag drives the query; any others are re-checked
  // per-customer inside enrollCustomer.
  const [tag] = config.requiredTags;
  const started = Date.now();
  const counts = { enrolled: 0, 'already-enrolled': 0, 'not-eligible': 0, failed: 0 };
  const enrolled = [];
  const failures = [];

  let skip = 0;
  let total = 0;
  do {
    const page = await listCustomersByTag(tag, { top: PAGE_SIZE, skip });
    total = page.total;
    if (!page.docs.length) break;

    for (const customer of page.docs) {
      try {
        const result = await enrollCustomer(customer._id);
        counts[result.status] = (counts[result.status] ?? 0) + 1;
        if (result.status === 'enrolled') {
          enrolled.push({ customerId: customer._id, membershipId: result.membershipId });
          console.log(`reconcile: enrolled ${customer._id} (${result.membershipId})`);
        }
      } catch (err) {
        counts.failed++;
        failures.push({ customerId: customer._id, error: err.message });
        console.error(`reconcile: failed ${customer._id}: ${err.message}`);
      }
    }
    skip += page.docs.length;
  } while (skip < total);

  const summary = { tag, scanned: skip, ...counts, enrolled, failures, ms: Date.now() - started };
  console.log('reconcile summary:', JSON.stringify(summary));

  // Non-2xx on failures so it surfaces in Vercel's cron log instead of
  // looking like a clean run.
  return json(counts.failed ? 500 : 200, summary);
}
