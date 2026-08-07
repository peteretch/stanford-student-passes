# Stanford Student Passes — membership enrolment

Enrols vivenu customers into a membership program and puts their membership code
on an access list so it scans at the gate (Tap & Go).

Three entry points, one shared implementation in `lib/enroll.js`:

| Entry point | Trigger | Purpose |
|---|---|---|
| `api/webhook.js` | `customer.created` / `customer.updated` | Near-real-time enrolment |
| `api/reconcile.js` | Vercel Cron, daily 08:00 UTC | Safety net for dropped webhooks |
| `enrollment.js` | Manual CLI | Bulk enrolment from a CSV |

## Two platform behaviours worth knowing

**The API does not enforce the program's Customer Segment.** The dashboard blocks
enrolment for customers without the required tag; `POST /api/memberships` does
not. It returns 201 for anyone. `VIVENU_REQUIRED_TAGS` re-implements that gate
client-side, and every entry point checks it before enrolling. Leave it unset and
the CLI warns loudly; the cron sweep refuses to run at all.

**`POST /api/memberships` is not idempotent.** Each call creates a *new*
membership and silently deactivates the previous one — orphaning the old code,
which stays live on the access list. So `enrollCustomer` looks for an existing
active membership and reuses it. This is what makes the whole thing safe:
at-least-once webhook delivery, cron re-runs, and re-running the CLI over a
partly-processed CSV are all harmless.

That second point also closes a feedback loop. Enrolment writes an `MBS:` tag to
the customer, which is a customer update, which fires `customer.updated`, which
calls the webhook again. Without the reuse check that loops indefinitely,
creating a membership per iteration.

## Setup

```bash
npm install
cp .env.example .env   # fill in the values
```

### Deploying

1. Push to GitHub, then import the repo in Vercel.
2. Add every variable from `.env.example` under Settings → Environment Variables.
   `CRON_SECRET` is what authenticates cron calls to `/api/reconcile`.
3. Deploy. The cron in `vercel.json` registers automatically.
4. Register the webhook against the deployed URL — dashboard under
   Developer → Webhooks, or:

```bash
curl -X POST https://vivenu.dev/api/webhook \
  -H "Authorization: Bearer $VIVENU_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "student-pass-enrol",
    "url": "https://stanford-student-passes.vercel.app/api/webhook",
    "events": { "customer.created": true, "customer.updated": true },
    "hmacKey": "4f109b814641b3f73e5f5c672f9f178d573941a8ddb8405d851ff50e1ee0468e"
  }'
```

The endpoint must be public HTTPS — vivenu rejects internal and development
hostnames, so localhost and tunnels to a laptop will not register.

## Handler calling convention

Vercel's Node runtime may invoke a function as a Node handler `(req, res)` or as
a Web handler `(Request) -> Response`, depending on runtime version and project
settings. `lib/http.js` detects which at runtime and adapts, so the same code
works either way.

This is not a hypothetical. The first deployment used the Web signature only,
and Vercel invoked it as Node:

- `/api/reconcile` threw `TypeError: request.headers.get is not a function` —
  Node's `headers` is a plain object — surfacing as `FUNCTION_INVOCATION_FAILED`.
- `/api/webhook` returned a `Response` that nobody sent. `res.end()` was never
  called, so requests hung until vivenu's 10-second timeout returned **408**.

The second failure is the dangerous one: a hang looks like a network problem, not
a code bug. `test/handlers.test.mjs` runs every test under both conventions, and
the Node-mode shim asserts `res.end()` was actually called.

## Security

Both endpoints are authenticated and fail closed:

- `/api/webhook` verifies `x-vivenu-signature`, an HMAC-SHA256 of the raw body.
  A missing key is a 500, not a bypass. `config.api.bodyParser = false` keeps the
  raw bytes intact — re-serialising a parsed body produces different bytes and
  would never match. If some runtime parses it anyway, verification fails loudly
  rather than checking reconstructed bytes.
- `/api/reconcile` requires `Authorization: Bearer $CRON_SECRET`.

## Status codes the webhook returns

| Status | When | vivenu retries? |
|---|---|---|
| 200 | Enrolled, already enrolled, ineligible, or an event we ignore | No |
| 401 | Bad or missing signature | No |
| 500 | Enrolment failed against the vivenu API | Yes, 6 times over ~2h |

Ineligible customers return 200 deliberately — that is a correct outcome, not a
failure, and retrying will not change it.

## CLI

```bash
npm run enroll:dry    # reads only, reports what would happen
npm run enroll        # writes
```

Flags: `--file=`, `--out=`, `--limit=`, `--delay=`, `--dry-run`. Results are
written to `results.csv` with a per-row status so a partial failure is
recoverable.

## Tests

```bash
npm test
```

Runs the handlers against the `dev` environment — signature rejection, tampered
bodies, ineligible customers, and duplicate delivery.

## Open item

`VIVENU_EXTERNAL_CODE_FIELD` defaults to `_id`, but nothing confirms that the
Apple/Google member card pass encodes the membership `_id` rather than its
`secret`. The membership object has no barcode field, so it is one or the other.
Pull a pass for an enrolled customer and scan it in Scan Manager before running
this against production — if it turns out to be `secret`, every code loaded up to
that point is wrong.

## API notes

Behaviours found by probing that the docs do not cover:

- `GET /api/customers` 404s. The list endpoint is `GET /api/customers/rich`,
  which supports `tags` and `updatedAt[$gte]`.
- A duplicate access-list entry returns **400** with `"Entry already in list"`,
  not 409.
- Memberships cannot be deleted. `PATCH /api/memberships/{id}` with
  `{"status":"inactive"}` deactivates one; `GET` on that path returns 405.
- `GET /api/memberships` accepts `customerId` and `programId` filters.
