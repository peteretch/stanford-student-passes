import crypto from 'node:crypto';
import { assertConfigured } from '../lib/vivenu.js';
import { enrollCustomer } from '../lib/enroll.js';
import { adapt } from '../lib/http.js';

// Keeps the raw body intact for HMAC verification under the Node runtime.
export const config = { api: { bodyParser: false } };

const HANDLED_EVENTS = new Set(['customer.created', 'customer.updated']);

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

export default async function handler(req, res) {
  const http = adapt(req, res);

  if (http.method !== 'POST') return http.send(405, { error: 'Method Not Allowed' });

  let rawBody;
  try {
    assertConfigured();
    rawBody = await http.rawBody();
  } catch (err) {
    console.error('config/read error:', err.message);
    return http.send(500, { error: err.message });
  }

  const hmacKey = process.env.VIVENU_WEBHOOK_HMAC_KEY;
  if (!hmacKey) {
    // Fail closed. An unauthenticated enrolment endpoint is worse than a
    // broken one — anyone could POST a customer id at it.
    console.error('VIVENU_WEBHOOK_HMAC_KEY is not set; rejecting.');
    return http.send(500, { error: 'Webhook signing key not configured' });
  }
  if (!verifySignature(rawBody, http.header('x-vivenu-signature'), hmacKey)) {
    console.warn('rejected webhook: bad signature');
    return http.send(401, { error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return http.send(400, { error: 'Malformed JSON' });
  }

  const type = payload?.type;
  if (!HANDLED_EVENTS.has(type)) {
    return http.send(200, { ignored: true, type });
  }

  const customerId = extractCustomerId(payload);
  if (!customerId) {
    console.error('no customer id in payload:', JSON.stringify(payload).slice(0, 500));
    // 200 on purpose: retrying will not make an id appear.
    return http.send(200, { ignored: true, reason: 'no customer id in payload' });
  }

  try {
    // enrollCustomer is idempotent, which is also what makes at-least-once
    // delivery safe — no separate dedupe store on the event id is needed.
    const result = await enrollCustomer(customerId, { log: (m) => console.log(m.trim()) });
    console.log(`${type} ${customerId} -> ${result.status}`);
    return http.send(200, { ...result, event: payload.id, type });
  } catch (err) {
    // 5xx so vivenu retries (6 attempts, backing off up to ~2h).
    console.error(`enrolment failed for ${customerId}:`, err.message);
    return http.send(500, { error: err.message, customerId });
  }
}
