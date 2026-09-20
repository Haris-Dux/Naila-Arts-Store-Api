# Store — modular monolith

Replaces the 9-service stack at the repo root. Built in phases; the old services
stay in place until cutover (Phase 11).

## Running locally

```bash
cp .env.example .env               # then set the three secrets
docker compose up -d mongo redis
npm ci
npm run start:dev
```

Or run the whole stack, app included, from the production image:

```bash
docker compose up -d
```

**A fresh database needs no setup.** Point `MONGO_URI` at an empty database and
start the app: Mongoose creates the collections and builds every index the
schemas declare, and the first administrator is created from `SEED_ADMIN_EMAIL`
/ `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_NAME`.

- API: `http://localhost:4000/api/v1`
- Swagger (non-production only): `http://localhost:4000/docs`
- Health: `http://localhost:4000/health` — unversioned and unprefixed on purpose

**Email** goes out through the shop's Hostinger mailbox (`smtp.hostinger.com`,
port 465 with SSL). Fill in the `CHANGE_ME` values in `.env`: `SMTP_USER` and
`SMTP_PASS` are the mailbox address and its password, `MAIL_FROM` must use that
same address (Hostinger only lets a mailbox send as itself), and
`STORE_SUPPORT_EMAIL` is where customer replies go. At startup the app checks
the connection and logs `SMTP ready` or the reason it failed. So that mail is
not filtered as spam, make sure SPF and DKIM are enabled for the domain in
Hostinger's DNS settings.

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## Why Mongo runs as a replica set

Checkout wraps repricing, the stock decrement and order creation
in one transaction, and MongoDB only offers multi-document transactions on a
replica set. A standalone `mongod` will connect but every transaction will fail.
The compose file initiates a single-node set (`rs0`) from its healthcheck.

Note the image is pinned to `mongo:8.2`. MongoDB 8.0 refuses to start on Linux
kernels >= 6.19 ([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)),
which this machine runs.

## Layout

| Path | Purpose |
| --- | --- |
| `src/config/` | Typed config, Joi schema. Boot fails on a missing var. |
| `src/database/` | Mongoose connection; collections and indexes are built from the schemas at startup. |
| `src/common/` | Filters, interceptors, `Money`, pagination, base schema. One copy of each. |
| `src/jobs/` | BullMQ queue definitions and default retry policy. |
| `src/modules/` | Domain modules, added per phase. |
| `src/health/` | Liveness and readiness probes. |

## Conventions

**Uploaded images are referenced by id, never by URL.** `Product.images[]` holds
a `mediaId` into the `media` collection; the response resolves it to a URL plus
the dimensions. That makes two things checkable that a URL string cannot: a
product is refused if it names an image that does not exist, and deleting an
image is refused while a product still uses it.

**A filename is the SHA-256 of its own bytes.** Re-uploading the same photograph
deduplicates, and — the point — the bytes behind a URL can never change, so every
file is served `immutable` with a one-year max-age. That promise is what lets a
CDN in front stop revalidating, and it is where the read speed comes from; the
disk underneath is a distant second.

**Images are served by static middleware mounted before the global prefix**, so a
hit never enters the Nest router. The throttler is a global guard backed by
Redis: route images through Nest and every thumbnail on every product grid pays a
Redis round trip. Misses do fall through, so a missing file returns the same JSON
404 as anything else.

**Format is proved from the bytes, not the headers.** `readWebpDimensions` parses
the RIFF container; a `Content-Type` of `image/webp` and a `.webp` extension are
both just strings the caller chose. The same parse yields the dimensions, so
there is no image library in the dependency tree and nothing resizes.

**`MEDIA_ROOT` must be a mounted volume, and must be backed up separately.** A
rebuild discards the container filesystem, and a Mongo dump restores everything
except the pictures.

**Products, categories and sizes are three modules, not one.** They were a
single `catalog` module; the dependency runs one way — products need a real
branch and real sizes, neither needs products — so the split is clean.

**The catalogue cache is private to the products module, and nothing else may
touch it.** Two modules legitimately write the products collection behind
`ProductsService`'s back: inventory, whose conditional stock update is the
overselling guard and must stay one atomic operation, and categories, which
re-points a branch's products when the branch moves. Both emit
`catalog.products-changed` with the ids they touched; `ProductCacheListener`
decides what that retires.

Announce, never invalidate. When the rule lived at each call site it had already
drifted — categories bumped the list version but not the per-product entries, and
since a branch move rewrites `categoryId` and `subcategoryId`, a product detail
page served the old placement until its TTL ran out. Emit *after* the commit:
retiring a view before the write is visible lets a concurrent read repopulate it
from the pre-commit state, which is worse than not invalidating at all.

**A product is `SIZED` or `UNSTITCHED`, and that is not a size.** Unstitched is a
garment form, so it lives on the product rather than as a row in the size list —
otherwise it would sit in the size picker beside S/M/L, show up in a filter that
means "will this fit me", and vanish the day an administrator tidies the size
list. `sizing` is inferred from `sizes` when the client does not state it, so the
two can never disagree. Note there is no per-size stock: a size is a choice the
customer records, and `stock` stays one count per product.

**`price` is the regular price; `promotionalPrice` is the offer.** Ending a
promotion is nulling one field, not remembering what the price used to be. There
is no schedule — the merchant sets it and clears it. `effectivePrice` is
denormalised on every write and is what every sort and price filter runs on,
because sorting on `price` while a promotion is running orders the storefront by
a number nobody is being charged. Checkout charges `effectivePrice`.

**`sellCount` moves only when something is actually sold.** A cancellation or a
return brings it back down — those units never left. A supplier delivery does
not: replenishment belongs to the ERP, which books it when a branch receives the
goods, so it never passes through `InventoryService` at all. Refunding a payment
moves neither stock nor `sellCount` — only the order reaching a terminal status
does.

**Money is always an integer of minor units.** Use `Money` from
`src/common/money.ts`; nothing else may do arithmetic on a price.

**Side effects go through a queue, not a direct call.** A state change emits a
domain event; emails, ERP pushes and stock warnings are BullMQ jobs so they
survive a restart and retry with backoff.

**Every list endpoint validates its sort field against an allow-list.** Extend
`PaginationDto` and override `sort` with `@IsIn(...)`.

**Reads exclude soft-deleted documents.** Filter with `notDeleted` from
`src/common/schemas/base.schema.ts`.

**Routes are authenticated unless marked `@Public()`.** `JwtAuthGuard`,
`RolesGuard` and `OwnershipGuard` are global. Add `@MinRole(...)` for a rank
requirement and `@OwnerOr({ param, fallbackRole })` for owner-or-admin access.

**Indexes come from the schemas.** There are no migrations: Mongoose's
`autoIndex` builds every index a schema declares when the app starts. Adding a
field that needs an index means declaring it on the schema, with an explicit
`name` for anything that must be stable. On a large live collection a new index
is built at startup, so index a very big collection ahead of the deploy.

**Take the acting user from `@CurrentUser()`, never from the request body.**

**There are two roles: `ADMIN` and `USER`.** ADMIN operates the dashboard —
catalogue, inventory, orders, fulfilment, payments. USER is a customer.
Administrators are peers: one can manage another, which is what lets a departed
admin be deactivated. `assertNotLastAdmin` prevents that becoming a lockout.

**An order can belong to a guest.** `Order.userId` is nullable; a guest order
carries only its own `contactEmail`/`contactName`. Check ownership with
`ownsRecord(actor.id, record)` from `common/ownership.ts` — one predicate for
orders, payments and shipments, so the rule cannot drift between them — paired
with the service's own `roleAtLeast(actor.role, ADMIN)` for staff.

**A guest is never identified.** Nothing is minted for them: no cookie, no
token, no server-side session. Their handle on the order is its **order number**,
and `GET /orders/lookup?orderNumber=…` is the whole of their access — a public,
rate-limited, read-only tracking view. Their idempotency key is scoped by the
request body, since there is no identity to scope it by.

That lookup returns a **reduced** view (`OrderTrackingDto`): status, items,
totals, payment status and parcel tracking, with the recipient shortened to
`Jane D.` and the destination to city and country. No email, phone, street
address or customer note. An order number is printed on parcels and quoted in
emails, so it identifies an order without proving who is asking — which is also
why nothing in that path can *change* an order. A guest order is cancelled by
staff.

Customer-facing order, payment and shipment routes therefore **require a token**.
The two exceptions are checkout and `POST /payments`: a guest confirming how they
will pay holds nothing but the order id checkout just returned, so a guest order
(`userId: null`) is accepted on that id alone. An order that belongs to an
account still needs that account's token, and every read returns 404 rather than
403 for somebody else's record.

**Editable storefront regions are declared, not built.** A region — the
announcement bar, the homepage banner slider — is a `defineSection(...)` in
`src/modules/content/sections/` plus a line in that folder's registry. Storage is
one collection of opaque documents keyed by section, and the API is one pair of
routes over the whole registry, so **adding a region is adding a file**: no
migration, no schema change, no new endpoint, no new module. Building a
collection and a module per region instead is what turns every "can we also edit
the footer?" into an architectural change.

The consequence is that `ContentService` never names a section. What one holds,
what it falls back to, and what a shopper may see all come from its definition.
Content is validated against that definition's DTO with the same settings as the
global pipe — an unknown key inside `data` is a 400 — because a generic route
must not become the one endpoint on the API that accepts anything.

**A section serves its defaults until somebody edits it**, so nothing is seeded
and the storefront has no blank state to handle. Order within a section is array
order: the whole region is one document replaced whole, so it needs none of the
explicit `order` field that separate documents do.

**Only `InventoryService` writes `Product.stock`**, and only through a conditional
update (`stock: { $gte: qty }` in the filter) so the check and the write are one
atomic operation. `UpdateProductDto` has no `stock` key, so a catalogue edit
cannot clobber a concurrent sale.

**Any catalogue write calls `CatalogCacheService.invalidate()`.** Individual
products are dropped by key; list pages are namespaced by a version counter that
the write bumps, retiring every cached page at once.

**The category tree is exactly two levels deep**, and the service enforces it —
a parent must itself be top-level, and a category with subcategories cannot be
nested under another. The bound is not cosmetic: a product stores its placement
as an explicit `(categoryId, subcategoryId)` pair, so a third level would have
nowhere to live.

**Every product has a category**, and `categoryId` is always the top-level half
of that pair, even when `subcategoryId` is set. Required on create and
un-clearable on update — an unfiled product is one no storefront filter reaches
and no ERP row maps to. Denormalising the parent onto every product is what makes
"everything under Electronics" one indexed equality match instead of a lookup of
the branch followed by an `$in`. The cost is that re-parenting a category has to
re-point its products, which `CategoriesService.update` does in the same
transaction.

**Validate a placement through `CategoriesService.assertPlacement`, never by
casting two ids.** It is the single point that rejects a subcategory without its
parent, a subcategory belonging to a different parent, and a subcategory passed
where a parent belongs. On update the *merged* state is validated, not the patch
— so moving a product to a new parent while leaving a stale subcategory behind is
reported rather than silently resolved.

**Sibling order is `{ order: 1, name: 1 }`.** Name is the tiebreaker, so a
catalogue that never sets `order` keeps the alphabetical listing it had before
the field existed. `order` is deliberately not unique — inserting one category
should not mean renumbering a branch.

**Side effects of authentication go through `user.authenticated`.** Auth awaits
the emit so listeners finish before the response is written, and a listener
failure is logged rather than failing the login.

**The basket lives in the browser; the server stores only the order.** Checkout
takes `items` — product ids, quantities and the chosen size, nothing else — and prices them from
the catalogue inside the transaction. A price, total or `userId` in the body is
an unknown key and a 400, which is what stops the client dictating what it pays.
Repeated products are folded into one line — keyed by product *and* size, so the
same shirt in M and in L stays two lines a picker can see — and the per-line cap
applies to the folded total so splitting a line is not a way around it.

**An order stores a snapshot.** The catalogue shows current prices; the order is
the record of what was charged, so name, SKU, size and unit price are frozen at
checkout — a picking slip printed next year must still say what shipped.

**Announcements of a state change go in the outbox, inside the transaction.**
`OutboxService.record()` requires a session. A row written outside the
transaction it describes gives none of the guarantee the pattern exists for.

**Invalidate the catalogue cache *after* the transaction commits**, never inside
it — invalidating early lets a concurrent read repopulate the cache from the
pre-commit state. Stock writes bypass `ProductsService`, so inventory owns this
via `InventoryService.invalidateCache()`.

**Webhooks verify a signature over the raw body**, never over re-serialised
JSON — a signature covers the exact bytes sent. Every accepted event is recorded
in `webhook_events` under a unique `(provider, eventId)` index, so a redelivery
is a no-op. Gateways guarantee at-least-once delivery; assume every event arrives
twice and out of order.

**Reference fields must use `MongooseSchema.Types.ObjectId`**, not
`Types.ObjectId`. The latter is the BSON *value* constructor; passing it to
`@Prop({ type })` silently registers the path as `Mixed`, so Mongoose stops
casting query strings and `populate` cannot work. Queries then return nothing,
with no error.

## Adding or changing an email

Templates live in `src/modules/notifications/templates/*.hbs` and strings in
`src/modules/notifications/i18n/<locale>.json` — copy is a file change, not a
code change. Both are copied into `dist/` by the `assets` entry in
`nest-cli.json`; without it they never reach a built image.

Never hardcode branding, a currency symbol, or a support address in a template.
They come from `STORE_NAME`, `STORE_CURRENCY` and `STORE_SUPPORT_EMAIL`. Format
money with `Money.format()` before it reaches the template, so there is one place
that converts out of minor units.

Every notification carries a `dedupeKey` (`<kind>:<aggregateId>`) with a unique
index behind it. Two at-least-once hops sit in front of delivery — the outbox
dispatcher and BullMQ's retries — so duplicates are expected, not exceptional.

## Operating it

Two places work can fail without any request failing, so both are inspectable —
admin-only, under `/api/v1/ops`:

| Endpoint | Shows |
| --- | --- |
| `GET /ops/queues` | Job counts per queue |
| `GET /ops/queues/failed` | Jobs that exhausted their retries — the dead-letter view |
| `POST /ops/queues/failed/retry` | Requeue them all, once the cause is fixed |
| `GET /ops/outbox` | Depth, plus `oldestPendingAgeSeconds` |
| `GET /ops/outbox/failed` | Messages abandoned after the attempt ceiling |
| `POST /ops/outbox/:id/retry` | Requeue one |

**`oldestPendingAgeSeconds` is the number to alert on.** A rising value means the
dispatcher has stopped draining, and nothing user-facing fails when that happens —
orders still succeed, customers just silently stop receiving email.

Probes: `/health` (readiness — checks Mongo and Redis) and `/health/liveness`
(process only, so a database blip doesn't get a healthy process killed). Both are
unversioned and outside the `/api` prefix, because probe URLs are a contract with
the orchestrator.

## Subscribing to a domain event

Implement `OutboxHandler` and mark the class `@OutboxSubscriber()`
(`src/modules/outbox/outbox-handler.interface.ts`). `OutboxDispatcher` discovers
it at bootstrap — there is no central list to update.

Handlers must be **idempotent**: delivery is at-least-once, so a crash between
running a handler and marking the row dispatched causes a redelivery. Let errors
propagate; the dispatcher records them and retries with exponential backoff.

Do not use `@OnEvent` for outbox work. `@nestjs/event-emitter` returns
`undefined` to `emitAsync` rather than the handler's promise, so the dispatcher
would mark messages delivered before handlers finished and a rejection would
surface as an unhandled promise instead of a retry.

## Payment methods

`CASH_ON_DELIVERY` is the only method the shop settles, and how it works is
load-bearing. The courier collects at the door, so fulfilment cannot wait for a
capture — the payment opens as `AUTHORIZED` and emits `order.confirmed`, which
shipping subscribes to alongside `order.paid`. The capture is recorded
afterwards, when the cash is handed in.

`CARD` is declared for the gateway that will come later; no provider supports it,
so it is a 400 today. Adding one means writing a class against
`PaymentProvider` and registering it — the webhook route, signature verification
and replay handling are already built and exercised by the manual provider.

That means **a COD order never reaches `PAID`**, and that is deliberate: by
capture time it is already `DELIVERED`, and moving it to `PAID` would be a
backwards transition. The order's status tracks fulfilment; the payment record
tracks money. Query payments, not order status, to answer "what has been paid
for".

## Adding a payment gateway

Write one class implementing `PaymentProvider`
(`src/modules/payments/provider/payment-provider.interface.ts`) and add it to the
`PAYMENT_PROVIDERS` factory in `payments.module.ts`. Nothing in orders, checkout,
or the webhook route changes — `POST /payments/webhooks/:provider` resolves the
adapter by name.

Providers talk to the gateway and report what happened. They never touch the
database and never transition an order; `PaymentsService` owns all persistence,
so there is exactly one place where an order becomes `PAID`.

## First administrator

There is no privileged email address. When the app starts and no administrator
exists, `AdminSeedService` creates one from `SEED_ADMIN_EMAIL` /
`SEED_ADMIN_PASSWORD` / `SEED_ADMIN_NAME`; once any administrator exists it does
nothing. It refuses a weak password, will not promote a customer who registered
with the same address, and stops a production start that has no administrator
and no credentials. Change that password after first login — it revokes every
existing session.

## Scripts

| Command | Does |
| --- | --- |
| `npm run start:dev` | Watch mode |
| `npm run build` | Compile to `dist/` |
| `npm test` | Unit tests |
| `npm run test:e2e` | Integration tests (in-memory Mongo) |
| `npm run lint` | ESLint with `--fix` |
| `node scripts/build-postman-collection.js` | Regenerate the Postman collection |

## The Postman collection

`store.postman_collection.json` at the repo root is **generated** — edit
`scripts/build-postman-collection.js` and regenerate, so the collection cannot
drift from the routes it claims to exercise.

It holds only the APIs the customer-facing store integrates — nothing
admin-only — in the order a shopper meets them: store setup, catalogue,
account, checkout, payment, cancelling, guest checkout, delivery tracking,
password and signing out. Every request carries a short description of what it
does and what it requires.

```bash
npx newman run ../store.postman_collection.json
```

Requests chain: run the folders in order and ids are captured into collection
variables automatically. No admin call seeds anything, so the shop needs at
least one published, in-stock product — the catalogue folder picks it and hands
it to checkout.

The delivery-tracking folder retries its first request. That is not flakiness:
the shipment is created by the outbox dispatcher reacting to the order's
confirmation, which polls every two seconds, so a 404 immediately after a
cash-on-delivery order is the design working.

## Progress

- [x] **Phase 0** — Scaffold: strict TS, ESLint, Prettier, Jest
- [x] **Phase 1** — Platform: config validation, Mongo + migrations, Redis cache,
      BullMQ, Pino with correlation IDs, health probes, global validation and
      error handling, helmet/CORS/compression, Redis-backed throttling
- [x] **Phase 2** — Users + Auth: registration, login, refresh-token rotation with
      reuse detection, revocation, rank-based authorization, admin user management
- [x] **Phase 3** — Catalog + Inventory: products, categories, search, Redis cache
      with versioned invalidation, and atomic stock that cannot oversell
- [x] **Phase 4** — Cart. Since removed: the basket is held by the storefront and
      submitted at checkout, so the server keeps no cart state
- [x] **Phase 5** — Orders + checkout: one transaction covering repricing, stock,
      order and outbox; `Idempotency-Key`; explicit order state machine
- [x] **Phase 6** — Payments: `PaymentProvider` port with a manual/offline
      adapter, signed webhooks with replay protection, capture and refund
- [x] **Phase 7** — Shipping: idempotent shipment creation driven by `order.paid`,
      carrier dispatch and tracking, plus the outbox dispatcher
- [x] **Phase 8** — Notifications: file-based templates with i18n, BullMQ delivery
      with retry and a dead-letter set, and a send log that prevents duplicates
- [x] **Phase 9** — ERP seam. The store shares a database with the ERP: a product
      is built on an ERP `suits` document via `Product.erpId`, and `suits.quantity`
      is the source of truth. Checkout decrements it directly; a change stream
      plus a reconciliation sweep keep `Product.stock` mirroring it. Products
      without an `erpId` keep their own stock.
- [x] **Phase 10** — Ops and tests: production image, single compose stack, CI,
      state-machine unit tests, and admin queue/outbox visibility
- [x] **Phase 11** — Cutover: the nine legacy services removed, Postman collection
      regenerated and passing against the monolith
