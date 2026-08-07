# Stanford Student Passes — membership enrolment

Keeps vivenu membership enrolment in sync with customer eligibility, and keeps
the matching codes on an access list so they scan at the gate (Tap & Go).

| Entry point | Trigger | Purpose |
|---|---|---|
| `api/webhook.js` | `customer.created` / `customer.updated` | Near-real-time enrol **and revoke** |
| `api/reconcile.js` | Vercel Cron, daily 08:00 UTC | Safety net for dropped webhooks |
| `enrollment.js` | Manual CLI | Bulk enrolment from a CSV |
| `scripts/audit.mjs` | Manual, read-only | Health check |

## Eligibility drives membership, in both directions

`syncCustomer` in `lib/enroll.js` is the single implementation:

| Eligible? | Active membership? | Action | Status |
|---|---|---|---|
| yes | no | create membership, add code to list | `enrolled` |
| yes | yes | ensure the code is listed | `already-enrolled` |
| no | yes | delete code, deactivate membership | `revoked` |
| no | no | nothing | `not-eligible` |

Revocation only runs when the caller passes `allowRevoke`. The webhook and the
nightly sweep do; the CSV CLI does not, because a file of customers to enrol
should never silently revoke the rows that turn out to be ineligible.

Losing the gating tag is a `customer.updated` event like any other. Without the
revoke path, an ineligible customer keeps a working gate credential
indefinitely — graduations, withdrawals, revoked eligibility. On revoke the
access-list entry is deleted **before** the membership is deactivated: if the
second call fails, someone who cannot scan but is still flagged as a member is a
safer failure than someone who can still scan.

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
    "hmacKey": "<placeholder>"
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
| 200 | Enrolled, already enrolled, revoked, ineligible, or an event we ignore | No |
| 401 | Bad or missing signature | No |
| 500 | The call against the vivenu API failed | Yes, 6 times over ~2h |

Ineligible customers return 200 deliberately — that is a correct outcome, not a
failure, and retrying will not change it.

## Reconcile

Three passes:

1. Enrol every tagged customer that is not already enrolled.
2. Revoke every active membership whose customer no longer holds the tag. Driven
   from the membership side, because a customer who lost the tag no longer
   appears in the pass 1 query at all — nothing else would ever look at them.
3. Delete access-list codes whose membership is no longer active.

A missed enrolment is an inconvenience; a missed revocation leaves a working
credential with someone ineligible, so pass 2 matters more than pass 1.

```
GET /api/reconcile?dryRun=1
Authorization: Bearer $CRON_SECRET
```

`dryRun` performs every read and no writes. It reports only genuine changes —
customers already in the right state come back as `already-enrolled`, not as
pending work.

## Audit

```bash
node --env-file=.env scripts/audit.mjs
```

Read-only. Six checks, all of them things that otherwise fail silently: customers
accumulating memberships, more than one active membership per customer, codes
whose membership is inactive, codes for customers without the tag, tagged
customers with no membership, and active memberships missing from the list.

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
bodies, ineligible customers, duplicate delivery, and a revocation round trip
that provisions a credential for an ineligible customer and asserts the webhook
tears both halves of it down.

These are live calls, not mocks, so each run leaves two more inactive
memberships on the round-trip test customer. Harmless — memberships cannot be
deleted, only deactivated, and `scripts/audit.mjs` check 1 will show the count
climbing on that one customer. Nothing to fix; just do not mistake it for the
runaway-enrolment bug it superficially resembles.

## The access list code

`VIVENU_EXTERNAL_CODE_FIELD=_id`. The membership object exposes no barcode field,
so the code written to the access list is either the membership `_id` or its
`secret`. **Confirmed as `_id`** — verified against a real member card pass at the
gate, not inferred from the docs.

Do not change this without re-verifying the same way. Every code written under the
wrong setting is a credential that will not scan.

## API notes

Behaviours found by probing that the docs do not cover:

- `GET /api/customers` 404s. The list endpoint is `GET /api/customers/rich`,
  which supports `tags` and `updatedAt[$gte]`.
- A duplicate access-list entry returns **400** with `"Entry already in list"`,
  not 409.
- Memberships cannot be deleted. `PATCH /api/memberships/{id}` with
  `{"status":"inactive"}` deactivates one; `GET` on that path returns 405.
- `GET /api/memberships` accepts `customerId` and `programId` filters.
