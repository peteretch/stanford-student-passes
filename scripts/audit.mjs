// Health check for the enrolment pipeline. Read-only.
//   node --env-file=.env scripts/audit.mjs
import { config, hosts, listCustomersByTag } from '../lib/vivenu.js';

const h = { Authorization: `Bearer ${config.apiKey}` };
const get = async (url) => {
  const res = await fetch(url, { headers: h });
  const body = await res.json();
  // Fail loudly. Silently treating an error body as "no results" turns a broken
  // query into a clean bill of health.
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
};

// Every membership in the program. The memberships endpoint caps `top` well
// below the 1000 the customers endpoint allows, so page through it.
const PAGE = 100;
const memberships = [];
for (let skip = 0; ; skip += PAGE) {
  const page = await get(
    `${hosts().memberships}/api/memberships?programId=${config.programId}&top=${PAGE}&skip=${skip}`,
  );
  memberships.push(...(page.docs ?? []));
  if (memberships.length >= (page.total ?? 0) || !page.docs?.length) break;
}

// Every code on the access list.
const entriesRes = await get(`${hosts().core}/api/access-lists/${config.accessListId}/entries?top=1000`);
const entries = entriesRes.docs ?? entriesRes;

// Everyone currently holding the gating tag.
const tagged = await listCustomersByTag(config.requiredTags[0], { top: 1000 });
const taggedIds = new Set(tagged.docs.map((c) => c._id));

const byCustomer = new Map();
for (const m of memberships) {
  if (!byCustomer.has(m.customerId)) byCustomer.set(m.customerId, []);
  byCustomer.get(m.customerId).push(m);
}

const activeById = new Map(memberships.filter((m) => m.status === 'active').map((m) => [m._id, m]));
const membershipById = new Map(memberships.map((m) => [m._id, m]));

console.log(`Program ${config.programId}`);
console.log(`  memberships:            ${memberships.length} (${activeById.size} active)`);
console.log(`  customers with the tag: ${taggedIds.size}`);
console.log(`  access list entries:    ${entries.length}\n`);

// 1. Runaway loop: a customer accumulating memberships.
const multi = [...byCustomer].filter(([, ms]) => ms.length > 1);
console.log(`1. Customers with more than one membership: ${multi.length}`);
for (const [customerId, ms] of multi) {
  const active = ms.filter((m) => m.status === 'active').length;
  console.log(`   ${customerId}: ${ms.length} total, ${active} active`);
}

// 2. More than one ACTIVE membership would mean the reuse check failed.
const doubleActive = [...byCustomer].filter(([, ms]) => ms.filter((m) => m.status === 'active').length > 1);
console.log(`\n2. Customers with more than one ACTIVE membership: ${doubleActive.length}` +
  (doubleActive.length ? '  <-- reuse check is broken' : '  (expected 0)'));

// 3. Orphaned codes: live on the access list, but the membership is not active.
const orphans = entries.filter((e) => {
  const m = membershipById.get(e.externalCode);
  return m && m.status !== 'active';
});
console.log(`\n3. Access list codes whose membership is inactive: ${orphans.length}`);
for (const e of orphans) console.log(`   ${e._id} -> ${e.externalCode} (customer ${e.customerId})`);

// 4. Codes on the list for customers who no longer hold the gating tag.
const revoked = entries.filter((e) => e.customerId && !taggedIds.has(e.customerId));
console.log(`\n4. Access list codes for customers without the "${config.requiredTags[0]}" tag: ${revoked.length}`);
for (const e of revoked) console.log(`   ${e._id} -> ${e.externalCode} (customer ${e.customerId})`);

// 5. Tagged customers with no active membership — the webhook missed them.
const missing = [...taggedIds].filter(
  (id) => !(byCustomer.get(id) ?? []).some((m) => m.status === 'active'),
);
console.log(`\n5. Tagged customers with no active membership: ${missing.length}`);
for (const id of missing) console.log(`   ${id}`);

// 6. Active memberships whose code is not on the access list — enrolled but cannot scan.
const codes = new Set(entries.map((e) => e.externalCode));
const notListed = [...activeById.values()].filter((m) => !codes.has(m[config.externalCodeField]));
console.log(`\n6. Active memberships missing from the access list: ${notListed.length}`);
for (const m of notListed) console.log(`   ${m._id} (customer ${m.customerId})`);
