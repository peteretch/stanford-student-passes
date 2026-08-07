// Exercises the deployed handlers against the dev environment.
//   node --env-file=.env test/handlers.test.mjs
import crypto from 'node:crypto';
import assert from 'node:assert';
import webhook from '../api/webhook.js';
import reconcile from '../api/reconcile.js';

const HMAC_KEY = process.env.VIVENU_WEBHOOK_HMAC_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ELIGIBLE = '6387894d96588a10f7927336'; // has PETER
const INELIGIBLE = '685172f06dbf2f5c06f8f088'; // does not

let passed = 0;
let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    failed++;
  }
};

const sign = (body) => crypto.createHmac('sha256', HMAC_KEY).update(body).digest('hex');

const postWebhook = (payload, { signature, raw } = {}) => {
  const body = raw ?? JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  const sig = signature === undefined ? sign(body) : signature;
  if (sig !== null) headers['x-vivenu-signature'] = sig;
  return webhook(new Request('https://example.com/api/webhook', { method: 'POST', headers, body }));
};

const event = (type, customerId) => ({
  id: `test-${Math.random().toString(36).slice(2)}`,
  type,
  data: { customer: { _id: customerId } },
});

console.log('webhook');

await check('rejects a request with no signature', async () => {
  const res = await postWebhook(event('customer.updated', ELIGIBLE), { signature: null });
  assert.strictEqual(res.status, 401);
});

await check('rejects a bad signature', async () => {
  const res = await postWebhook(event('customer.updated', ELIGIBLE), { signature: 'deadbeef' });
  assert.strictEqual(res.status, 401);
});

await check('rejects a tampered body', async () => {
  const good = JSON.stringify(event('customer.updated', ELIGIBLE));
  const tampered = JSON.stringify(event('customer.updated', INELIGIBLE));
  const res = await postWebhook(null, { raw: tampered, signature: sign(good) });
  assert.strictEqual(res.status, 401);
});

await check('rejects GET', async () => {
  const res = await webhook(new Request('https://example.com/api/webhook', { method: 'GET' }));
  assert.strictEqual(res.status, 405);
});

await check('ignores unrelated event types', async () => {
  const res = await postWebhook(event('ticket.created', ELIGIBLE));
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).ignored, true);
});

await check('does not enrol an ineligible customer', async () => {
  const res = await postWebhook(event('customer.updated', INELIGIBLE));
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'not-eligible', `got ${body.status}`);
});

await check('is idempotent for an already-enrolled customer', async () => {
  const res = await postWebhook(event('customer.updated', ELIGIBLE));
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'already-enrolled', `got ${body.status}`);
});

await check('survives duplicate delivery of the same event', async () => {
  const e = event('customer.updated', ELIGIBLE);
  const a = await postWebhook(e);
  const b = await postWebhook(e);
  assert.strictEqual((await a.json()).membershipId, (await b.json()).membershipId);
});

await check('handles a payload with no customer id without retrying', async () => {
  const res = await postWebhook({ id: 'x', type: 'customer.updated', data: {} });
  assert.strictEqual(res.status, 200);
});

console.log('\nreconcile');

await check('rejects an unauthenticated call', async () => {
  const res = await reconcile(new Request('https://example.com/api/reconcile'));
  assert.strictEqual(res.status, 401);
});

await check('rejects a wrong secret', async () => {
  const res = await reconcile(
    new Request('https://example.com/api/reconcile', { headers: { authorization: 'Bearer nope' } }),
  );
  assert.strictEqual(res.status, 401);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
