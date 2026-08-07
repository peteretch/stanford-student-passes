import crypto from 'node:crypto';
import { assertConfigured } from '../lib/vivenu.js';
import { enrollCustomer } from '../lib/enroll.js';

const HANDLED_EVENTS = new Set(['customer.created', 'customer.updated']);

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function verifySignature(rawBody, header, key) {
  const expected = crypto.createHmac('sha256', key).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(header ?? ''), 'utf8');
  // timingSafeEqual throws on length mismatch, so guard first.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The customer id sits in a different place depending on the event, so check
// the shapes we know about rather than assuming one.
function extractCustomerId(payload) {
  const d = payload?.data ?? {};
  return d.customer?._id ?? d.object?._id ?? d._id ?? payload?.customerId ?? null;
}

// Uses the Web handler signature so the raw body is available for HMAC —
// the (req, res) signature has the body pre-parsed, and re-stringifying it
// would produce a different byte sequence and break verification.
export default async function handler(request) {
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let rawBody;
  try {
    assertConfigured();
    rawBody = await request.text();
  } catch (err) {
    console.error('config/read error:', err.message);
    return json(500, { error: err.message });
  }

  const hmacKey = process.env.VIVENU_WEBHOOK_HMAC_KEY;
  if (!hmacKey) {
    // Fail closed. An unauthenticated enrolment endpoint is worse than a
    // broken one — anyone could POST a customer id at it.
    console.error('VIVENU_WEBHOOK_HMAC_KEY is not set; rejecting.');
    return json(500, { error: 'Webhook signing key not configured' });
  }
  if (!verifySignature(rawBody, request.headers.get('x-vivenu-signature'), hmacKey)) {
    console.warn('rejected webhook: bad signature');
    return json(401, { error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json(400, { error: 'Malformed JSON' });
  }

  const type = payload?.type;
  if (!HANDLED_EVENTS.has(type)) {
    return json(200, { ignored: true, type });
  }

  const customerId = extractCustomerId(payload);
  if (!customerId) {
    console.error('no customer id in payload:', JSON.stringify(payload).slice(0, 500));
    // 200 on purpose: retrying will not make an id appear.
    return json(200, { ignored: true, reason: 'no customer id in payload' });
  }

  try {
    // enrollCustomer is idempotent, which is also what makes at-least-once
    // delivery safe — no separate dedupe store on the event id is needed.
    const result = await enrollCustomer(customerId, { log: (m) => console.log(m.trim()) });
    console.log(`${type} ${customerId} -> ${result.status}`);
    return json(200, { ...result, event: payload.id, type });
  } catch (err) {
    // 5xx so vivenu retries (6 attempts, backing off up to ~2h).
    console.error(`enrolment failed for ${customerId}:`, err.message);
    return json(500, { error: err.message, customerId });
  }
}
