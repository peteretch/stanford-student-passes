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
    "hmacKey": "<same value as VIVENU_WEBHOOK_HMAC_KEY>"
  }'
```

The endpoint must be public HTTPS — vivenu rejects internal and development
hostnames, so localhost and tunnels to a laptop will not register.

## Security

Both endpoints are authenticated and fail closed:

- `/api/webhook` verifies `x-vivenu-signature`, an HMAC-SHA256 of the raw body.
  A missing key is a 500, not a bypass. The handler uses the Web request
  signature specifically so the raw bytes are available — re-serialising a parsed
  body produces different bytes and breaks verification.
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
