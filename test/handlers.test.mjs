// Exercises the deployed handlers against the dev environment, under BOTH
// calling conventions Vercel may use.
//
// This matters: the first deployment used the Web signature only. Vercel
// invoked the functions as Node (req, res) handlers, so reconcile threw on
// request.headers.get and the webhook returned a Response nobody sent — the
// request hung until vivenu's 10s timeout produced a 408. Web-mode-only tests
// passed the whole time. Every test here runs twice.
//
//   node --env-file=.env test/handlers.test.mjs
import crypto from 'node:crypto';
import assert from 'node:assert';
import { Readable } from 'node:stream';
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

// --- invocation shims ------------------------------------------------------

function nodeReq({ method = 'POST', headers = {}, body = '' }) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return req;
}

function nodeRes() {
  const res = {
    statusCode: 0,
    body: '',
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(chunk) {
      this.body = chunk ?? '';
      this.done = true;
    },
  };
  return res;
}

// Calls a handler and normalises the outcome to { status, json }, failing
// loudly if a Node-mode invocation never wrote a response — the exact bug that
// caused the 408s.
async function call(handler, mode, { method = 'POST', headers = {}, body = '' }) {
  if (mode === 'web') {
    const init = { method, headers };
    if (method !== 'GET' && method !== 'HEAD') init.body = body;
    const res = await handler(new Request('https://example.com/x', init));
    assert.ok(res instanceof Response, 'web mode must return a Response');
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  const res = nodeRes();
  await handler(nodeReq({ method, headers, body }), res);
  assert.ok(res.done, 'node mode never called res.end() — the request would hang');
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

const event = (type, customerId) => ({
  id: `test-${crypto.randomUUID()}`,
  type,
  data: { customer: { _id: customerId } },
});

const postWebhook = (mode, payload, { signature, raw } = {}) => {
  const body = raw ?? JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  const sig = signature === undefined ? sign(body) : signature;
  if (sig !== null) headers['x-vivenu-signature'] = sig;
  return call(webhook, mode, { method: 'POST', headers, body });
};

// --- suite -----------------------------------------------------------------

for (const mode of ['web', 'node']) {
  console.log(`\n=== ${mode} invocation ===`);
  console.log('webhook');

  await check(`[${mode}] rejects a request with no signature`, async () => {
    const r = await postWebhook(mode, event('customer.updated', ELIGIBLE), { signature: null });
    assert.strictEqual(r.status, 401);
  });

  await check(`[${mode}] rejects a bad signature`, async () => {
    const r = await postWebhook(mode, event('customer.updated', ELIGIBLE), { signature: 'deadbeef' });
    assert.strictEqual(r.status, 401);
  });

  await check(`[${mode}] rejects a tampered body`, async () => {
    const good = JSON.stringify(event('customer.updated', ELIGIBLE));
    const tampered = JSON.stringify(event('customer.updated', INELIGIBLE));
    const r = await postWebhook(mode, null, { raw: tampered, signature: sign(good) });
    assert.strictEqual(r.status, 401);
  });

  await check(`[${mode}] rejects GET without hanging`, async () => {
    const r = await call(webhook, mode, { method: 'GET' });
    assert.strictEqual(r.status, 405);
  });

  await check(`[${mode}] ignores unrelated event types`, async () => {
    const r = await postWebhook(mode, event('ticket.created', ELIGIBLE));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ignored, true);
  });

  await check(`[${mode}] does not enrol an ineligible customer`, async () => {
    const r = await postWebhook(mode, event('customer.updated', INELIGIBLE));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.status, 'not-eligible', `got ${r.json.status}`);
  });

  await check(`[${mode}] is idempotent for an already-enrolled customer`, async () => {
    const r = await postWebhook(mode, event('customer.updated', ELIGIBLE));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.status, 'already-enrolled', `got ${r.json.status}`);
  });

  await check(`[${mode}] survives duplicate delivery of the same event`, async () => {
    const e = event('customer.updated', ELIGIBLE);
    const a = await postWebhook(mode, e);
    const b = await postWebhook(mode, e);
    assert.strictEqual(a.json.membershipId, b.json.membershipId);
  });

  await check(`[${mode}] handles a payload with no customer id`, async () => {
    const r = await postWebhook(mode, { id: 'x', type: 'customer.updated', data: {} });
    assert.strictEqual(r.status, 200);
  });

  await check(`[${mode}] rejects malformed JSON`, async () => {
    const r = await postWebhook(mode, null, { raw: '{not json' });
    assert.strictEqual(r.status, 400);
  });

  console.log('reconcile');

  await check(`[${mode}] rejects an unauthenticated call`, async () => {
    const r = await call(reconcile, mode, { method: 'GET' });
    assert.strictEqual(r.status, 401);
  });

  await check(`[${mode}] rejects a wrong secret`, async () => {
    const r = await call(reconcile, mode, { method: 'GET', headers: { authorization: 'Bearer nope' } });
    assert.strictEqual(r.status, 401);
  });

  await check(`[${mode}] accepts the cron secret`, async () => {
    const r = await call(reconcile, mode, {
      method: 'GET',
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.ok(typeof r.json.scanned === 'number');
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
