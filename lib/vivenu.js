// Thin vivenu API client: config, retries, and the handful of calls this
// integration needs.

export const config = {
  apiKey: process.env.VIVENU_API_KEY,
  env: process.env.VIVENU_ENV ?? 'dev',
  programId: process.env.VIVENU_PROGRAM_ID,
  accessListId: process.env.VIVENU_ACCESS_LIST_ID,
  externalCodeField: process.env.VIVENU_EXTERNAL_CODE_FIELD ?? '_id',
  requiredTags: (process.env.VIVENU_REQUIRED_TAGS ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),
};

const HOSTS = {
  dev: { core: 'https://vivenu.dev', memberships: 'https://memberships.vivenu.dev' },
  prod: { core: 'https://vivenu.com', memberships: 'https://memberships.vivenu.com' },
};

export function hosts() {
  const h = HOSTS[config.env];
  if (!h) throw new Error(`VIVENU_ENV must be "dev" or "prod", got "${config.env}"`);
  return h;
}

export function assertConfigured() {
  const missing = ['apiKey', 'programId', 'accessListId'].filter((k) => !config[k]);
  if (missing.length) {
    const names = missing.map((k) => `VIVENU_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`);
    throw new Error(`Missing required environment variables: ${names.join(', ')}`);
  }
  hosts();
}

export class ApiError extends Error {
  constructor(status, body, url) {
    super(`${url} -> ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, url, payload, { attempts = 4 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });

    const raw = await res.text();
    let body;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }

    if (res.ok) return body;

    lastError = new ApiError(res.status, body, url);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === attempts) throw lastError;

    const retryAfter = Number(res.headers.get('retry-after')) * 1000;
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 500 * 2 ** (attempt - 1);
    await delay(backoff);
  }
  throw lastError;
}

const get = (url) => request('GET', url, undefined);
const post = (url, payload) => request('POST', url, payload);
const patch = (url, payload) => request('PATCH', url, payload);

// --- Customers -------------------------------------------------------------

export const getCustomer = (customerId) => get(`${hosts().core}/api/customers/${customerId}`);

// Note: the list endpoint is /api/customers/rich — plain /api/customers 404s.
export async function listCustomersByTag(tag, { top = 1000, skip = 0 } = {}) {
  const url = `${hosts().core}/api/customers/rich?tags=${encodeURIComponent(tag)}&top=${top}&skip=${skip}`;
  const res = await get(url);
  return { docs: res?.docs ?? [], total: res?.total ?? 0 };
}

// --- Memberships -----------------------------------------------------------

export async function findActiveMembership(customerId) {
  const url =
    `${hosts().memberships}/api/memberships` +
    `?customerId=${encodeURIComponent(customerId)}&programId=${encodeURIComponent(config.programId)}`;
  const res = await get(url);
  return (res?.docs ?? []).find((m) => m.status === 'active') ?? null;
}

export async function createMembership(customerId) {
  const res = await post(`${hosts().memberships}/api/memberships`, {
    customerId,
    programId: config.programId,
  });
  const doc = res?.membership ?? res?.data ?? res;
  if (!doc?._id) throw new Error(`No membership id in response: ${JSON.stringify(res)}`);
  return doc;
}

// Memberships cannot be deleted, only deactivated. Undocumented but confirmed:
// GET on this path 405s, PATCH with a status works.
export const deactivateMembership = (membershipId) =>
  patch(`${hosts().memberships}/api/memberships/${membershipId}`, { status: 'inactive' });

export function externalCodeFor(membership) {
  const code = membership?.[config.externalCodeField];
  if (!code) {
    throw new Error(
      `Field "${config.externalCodeField}" missing from membership ${membership?._id}. ` +
        `Available fields: ${Object.keys(membership ?? {}).join(', ')}`,
    );
  }
  return code;
}

// --- Access list -----------------------------------------------------------

export async function findAccessListEntry(externalCode) {
  const url =
    `${hosts().core}/api/access-lists/${config.accessListId}/entries` +
    `?externalCode=${encodeURIComponent(externalCode)}`;
  const res = await get(url);
  const docs = res?.docs ?? (Array.isArray(res) ? res : []);
  return docs.find((e) => e.externalCode === externalCode) ?? null;
}

export async function createAccessListEntry(entry) {
  try {
    return await post(`${hosts().core}/api/access-lists/${config.accessListId}/entries`, entry);
  } catch (err) {
    // A duplicate externalCode comes back as 400 (not 409) with this message.
    // Treat it as success so concurrent deliveries don't fail each other.
    const message = err?.body?.message ?? '';
    if (err instanceof ApiError && err.status === 400 && /already in list/i.test(message)) {
      return null;
    }
    throw err;
  }
}

export const deleteAccessListEntry = (entryId) =>
  request('DELETE', `${hosts().core}/api/access-lists/${config.accessListId}/entries/${entryId}`);
