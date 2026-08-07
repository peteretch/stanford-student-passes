// Adapter so a handler works under either calling convention.
//
// Vercel's Node runtime may invoke a function as a Node handler (req, res) or
// as a Web handler (Request) -> Response, depending on runtime version and
// project settings. Guessing wrong is not a loud failure: returning a Response
// to a (req, res) invocation means res.end() is never called, so the request
// hangs until the caller times out. Detecting at runtime removes the guess.

export const isWebRequest = (req) =>
  typeof req?.headers?.get === 'function' && typeof req?.text === 'function';

/**
 * Normalises either calling convention into { method, header(name), rawBody(),
 * send(status, body) }. `send` returns a value the handler must return: a
 * Response in Web mode, undefined in Node mode after writing to res.
 */
export function adapt(req, res) {
  // Node gives a path ("/api/x?y=1"), Web gives an absolute URL. Parsing with a
  // dummy base handles both — an absolute input ignores the base.
  const query = (name) => new URL(req.url ?? '/', 'https://placeholder.local').searchParams.get(name);

  if (isWebRequest(req)) {
    return {
      mode: 'web',
      method: req.method,
      header: (name) => req.headers.get(name),
      query,
      rawBody: () => req.text(),
      send: (status, body) =>
        new Response(JSON.stringify(body, null, 2), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    };
  }

  return {
    mode: 'node',
    method: req.method,
    header: (name) => req.headers?.[name.toLowerCase()],
    query,
    rawBody: () => readNodeRawBody(req),
    send: (status, body) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body, null, 2));
    },
  };
}

/**
 * Recovers the raw request bytes, which HMAC verification needs — a parsed body
 * re-serialised with JSON.stringify produces different bytes (key order,
 * whitespace) and would never match the signature.
 *
 * `export const config = { api: { bodyParser: false } }` on the route keeps the
 * stream unconsumed. If some runtime parses it anyway we fail loudly rather
 * than verifying against reconstructed bytes.
 */
async function readNodeRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body;

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length) return Buffer.concat(chunks).toString('utf8');

  if (req.body && typeof req.body === 'object') {
    throw new Error(
      'Request body was pre-parsed and the raw bytes are gone, so the signature ' +
        'cannot be verified. Ensure `export const config = { api: { bodyParser: false } }` ' +
        'is set on this route.',
    );
  }
  return '';
}
