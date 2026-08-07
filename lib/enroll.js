import {
  config,
  getCustomer,
  findActiveMembership,
  createMembership,
  deactivateMembership,
  externalCodeFor,
  findAccessListEntry,
  createAccessListEntry,
  deleteAccessListEntry,
} from './vivenu.js';

/**
 * Brings one customer's membership in line with their eligibility.
 *
 *   eligible,   no active membership  -> enrol            (status: enrolled)
 *   eligible,   active membership     -> ensure listed    (already-enrolled)
 *   ineligible, active membership     -> revoke           (revoked)
 *   ineligible, no active membership  -> nothing          (not-eligible)
 *
 * Revocation only happens when `allowRevoke` is set. The webhook and the
 * nightly sweep pass it; the CSV CLI does not, because a file of customers to
 * enrol should never silently revoke the rows that turn out to be ineligible.
 *
 * Idempotent in both directions — safe under at-least-once webhook delivery,
 * repeated cron runs, and re-runs over a partly-processed CSV. This is load
 * bearing, not merely tidy:
 *
 *   - POST /api/memberships is NOT idempotent. Each call mints a new membership
 *     and silently deactivates the previous one, orphaning its code on the
 *     access list. Reusing an existing active membership prevents that.
 *   - Enrolment writes an MBS: tag to the customer, which is itself a customer
 *     update, which fires customer.updated, which calls this again. Without the
 *     reuse check that is an unbounded enrol loop.
 *
 * With { dryRun: true } every read runs but nothing is written.
 *
 * Returns { customerId, status, membershipId, externalCode, reason }.
 */
export async function syncCustomer(customerId, { log = () => {}, dryRun = false, allowRevoke = false } = {}) {
  const result = (status, extra = {}) => ({
    customerId,
    status,
    membershipId: '',
    externalCode: '',
    reason: '',
    ...extra,
  });

  // 1. Eligibility. The API does not enforce the program's Customer Segment,
  //    so an ineligible customer would otherwise be enrolled successfully.
  let eligible = true;
  let reason = '';
  if (config.requiredTags.length) {
    const customer = await getCustomer(customerId);
    const tags = customer?.tags ?? [];
    const missing = config.requiredTags.filter((t) => !tags.includes(t));
    if (missing.length) {
      eligible = false;
      reason = `missing required tag(s): ${missing.join(', ')}`;
    }
  }

  const membership = await findActiveMembership(customerId);

  // 2. Ineligible: revoke if they still hold an active membership.
  if (!eligible) {
    if (!membership) {
      log(`  skipped — ${reason}`);
      return result('not-eligible', { reason });
    }

    if (!allowRevoke) {
      // Surfaced rather than silently ignored: an ineligible customer with a
      // live gate credential is exactly what revocation exists to catch.
      log(`  ${reason} — has active membership ${membership._id}, revocation not enabled here`);
      return result('not-eligible', { membershipId: membership._id, reason });
    }

    const code = externalCodeFor(membership);
    if (dryRun) {
      log(`  would revoke ${membership._id} — ${reason}`);
      return result('would-revoke', { membershipId: membership._id, externalCode: code, reason });
    }

    // Remove the gate credential first. If the second call fails, a customer
    // who cannot scan but is still flagged as a member is the safer failure
    // than one who can scan but is not.
    const entry = await findAccessListEntry(code);
    if (entry) {
      await deleteAccessListEntry(entry._id);
      log(`  removed access list entry ${entry._id}`);
    }
    await deactivateMembership(membership._id);
    log(`  revoked membership ${membership._id} — ${reason}`);

    return result('revoked', { membershipId: membership._id, externalCode: code, reason });
  }

  // 3. Eligible: reuse an existing active membership rather than minting another.
  if (dryRun) {
    // Report only genuine changes. A customer who already has an active
    // membership and a listed code is a no-op, and calling that "would enrol"
    // buries the real changes in noise.
    const code = membership ? externalCodeFor(membership) : null;
    const listed = code ? await findAccessListEntry(code) : null;
    if (membership && listed) {
      log(`  eligible — already enrolled as ${membership._id}, no change`);
      return result('already-enrolled', { membershipId: membership._id, externalCode: code });
    }
    log(
      membership
        ? `  eligible — would add ${code} to the access list`
        : '  eligible — would create a new membership',
    );
    return result('would-enrol', { membershipId: membership?._id ?? '', externalCode: code ?? '' });
  }

  let active = membership;
  if (!active) {
    active = await createMembership(customerId);
    log(`  membership created: ${active._id}`);
  } else {
    log(`  reusing active membership: ${active._id}`);
  }

  // 4. Ensure the code is on the access list.
  const externalCode = externalCodeFor(active);
  const existing = await findAccessListEntry(externalCode);
  if (existing) {
    log(`  already on access list as ${existing._id}`);
  } else {
    await createAccessListEntry({
      externalCode,
      customerId,
      meta: { programId: config.programId, source: 'stanford-student-passes' },
    });
    log(`  added to access list as ${externalCode}`);
  }

  return result(membership && existing ? 'already-enrolled' : 'enrolled', {
    membershipId: active._id,
    externalCode,
  });
}

/** Enrol-only wrapper, for callers that must never revoke. */
export const enrollCustomer = (customerId, opts = {}) =>
  syncCustomer(customerId, { ...opts, allowRevoke: false });
