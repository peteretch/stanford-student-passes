import {
  config,
  getCustomer,
  findActiveMembership,
  createMembership,
  externalCodeFor,
  findAccessListEntry,
  createAccessListEntry,
} from './vivenu.js';

/**
 * Enrol one customer and put their code on the access list.
 *
 * Idempotent by design — safe to call repeatedly for the same customer. This
 * matters more than it looks:
 *
 *   - POST /api/memberships is NOT idempotent. Each call mints a new membership
 *     and silently deactivates the previous one, orphaning its code on the
 *     access list. Reusing an existing active membership is what prevents that.
 *   - Enrolment writes an MBS: tag to the customer, which is itself a customer
 *     update, which fires customer.updated, which calls this again. Without the
 *     reuse check that is an infinite enrol loop.
 *   - Webhook delivery is at-least-once, so duplicates arrive normally.
 *
 * With { dryRun: true } it performs every read — eligibility and the existing
 * membership lookup — but no writes, and reports what it would have done.
 *
 * Returns { customerId, status, membershipId, externalCode, reason }.
 * Status is one of: enrolled | already-enrolled | not-eligible | would-enrol.
 */
export async function enrollCustomer(customerId, { log = () => {}, dryRun = false } = {}) {
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
  if (config.requiredTags.length) {
    const customer = await getCustomer(customerId);
    const tags = customer?.tags ?? [];
    const missing = config.requiredTags.filter((t) => !tags.includes(t));
    if (missing.length) {
      const reason = `missing required tag(s): ${missing.join(', ')}`;
      log(`  skipped — ${reason}`);
      return result('not-eligible', { reason });
    }
  }

  // 2. Reuse an existing active membership rather than minting a second one.
  let membership = await findActiveMembership(customerId);
  const reused = Boolean(membership);

  if (dryRun) {
    log(
      membership
        ? `  eligible — would reuse active membership ${membership._id}`
        : '  eligible — would create a new membership',
    );
    return result('would-enrol', { membershipId: membership?._id ?? '' });
  }

  if (!membership) {
    membership = await createMembership(customerId);
    log(`  membership created: ${membership._id}`);
  } else {
    log(`  reusing active membership: ${membership._id}`);
  }

  // 3. Ensure the code is on the access list.
  const externalCode = externalCodeFor(membership);
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

  return result(reused && existing ? 'already-enrolled' : 'enrolled', {
    membershipId: membership._id,
    externalCode,
  });
}
