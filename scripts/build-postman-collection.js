/**
 * ⚠️  STALE — DO NOT RUN. See the warning below before touching this file.
 *
 * Generates the Postman collection for the customer-facing store.
 *
 * Only what the storefront (website or app) integrates is in it — nothing
 * admin-only. A script rather than hand-maintained JSON, so the collection
 * cannot drift silently from the routes it claims to exercise — regenerate it
 * whenever the API changes:
 *
 *   node scripts/build-postman-collection.js
 *
 * It is also a runnable smoke suite: the folders run top to bottom and hand ids
 * to each other through collection variables, with no admin calls — so the shop
 * needs at least one published, in-stock product.
 */
/**
 * ⚠️  THIS GENERATOR IS OUT OF DATE AND MUST NOT BE RUN AS-IS.
 *
 * Two separate problems, and the second is what hid the first:
 *
 * 1. Its output path is wrong. `join(__dirname, '..', '..', …)` resolves to the
 *    directory *above* the repository, so running this writes a stray file
 *    outside the project and never updates `store.postman_collection.json`.
 *
 * 2. Because of (1) nobody noticed it drifting, and the committed collection has
 *    been maintained by hand ever since. The collection is now the accurate
 *    document and this script is ~31 hunks behind it. Regenerating would
 *    replace correct docs with a description of an API that no longer exists:
 *
 *      - guest identity via a `guest_token` httpOnly cookie, replaced by
 *        order-number lookup through `GET /orders/lookup`
 *      - `facebookVideoUrl` on a product, replaced by `videoUrl` +
 *        `videoPlatform`
 *      - a `BANK_TRANSFER` payment method that is not in `PaymentMethod`
 *      - the `REFUNDED` order status, replaced by `RETURNED`
 *
 * Fixing the path without first closing that gap would arm this script to
 * destroy the only accurate copy. So the path is left broken on purpose: it is
 * the thing currently making this file harmless.
 *
 * To revive it: bring every description below in line with
 * `store.postman_collection.json`, change the target to
 * `join(__dirname, '..')`, regenerate, and confirm `git diff` on the collection
 * is empty. Until then, edit the JSON directly. If nobody intends to do that,
 * delete this file rather than leaving a generator that cannot be trusted.
 */
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

/** A description, as markdown. */
const md = (text) => text.trim();

/** A script, as the list of lines Postman stores. */
const code = (text) => text.replace(/^\n+|\n+$/g, '').split('\n');

/** A query parameter. `disabled` ones show in Postman's Params tab without being sent. */
const q = (key, value, description, disabled = false) => ({
  key,
  value,
  ...(description ? { description } : {}),
  ...(disabled ? { disabled: true } : {}),
});

const url = (path, query = []) => {
  const sent = query.filter((param) => !param.disabled);
  return {
    raw: `{{baseUrl}}${path}${sent.length ? `?${sent.map((p) => `${p.key}=${p.value}`).join('&')}` : ''}`,
    host: ['{{baseUrl}}'],
    path: path.replace(/^\//, '').split('/'),
    ...(query.length ? { query } : {}),
  };
};

/**
 * One request. `test` captures ids into collection variables, so requests chain
 * end to end; `body` is an object, or a string when it must hold a variable that
 * is not a JSON string (`{{checkoutItems}}`).
 */
const req = (name, method, path, description, options = {}) => {
  const { auth = false, body, query, idempotent = false, test, prerequest } = options;
  const event = [
    ...(prerequest
      ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: code(prerequest) } }]
      : []),
    ...(test ? [{ listen: 'test', script: { type: 'text/javascript', exec: code(test) } }] : []),
  ];

  return {
    name,
    request: {
      method,
      header: [
        ...(body !== undefined ? [{ key: 'Content-Type', value: 'application/json' }] : []),
        ...(auth ? [{ key: 'Authorization', value: 'Bearer {{accessToken}}' }] : []),
        ...(idempotent ? [{ key: 'Idempotency-Key', value: '{{$guid}}' }] : []),
      ],
      url: url(path, query),
      description: md(description),
      ...(body !== undefined
        ? {
            body: {
              mode: 'raw',
              raw: typeof body === 'string' ? body : JSON.stringify(body, null, 2),
              options: { raw: { language: 'json' } },
            },
          }
        : {}),
    },
    ...(event.length ? { event } : {}),
  };
};

const folder = (name, description, item) => ({ name, description: md(description), item });

const ADDRESS = {
  fullName: 'Ayesha Khan',
  line1: 'House 12, Street 4, F-7/2',
  city: 'Islamabad',
  postalCode: '44000',
  country: 'PK',
  phone: '+92 300 1234567',
};

const CHECKOUT_BODY_FIELDS = `
**Body:**
- \`items\` *(required, 1–100 lines)* — each \`{ "productId", "quantity", "sizeId" }\`. \`quantity\` is 1–999. \`sizeId\` is needed only for a product sold by size (\`sizing: "SIZED"\`); use one of that product's \`sizes\`.
- \`shippingAddress\` *(required)* — \`fullName\`, \`line1\`, \`city\`, \`postalCode\`, \`country\` (two-letter code, e.g. \`PK\`). Optional: \`line2\`, \`state\`, \`phone\`.
- \`billingAddress\` *(optional)* — same shape; defaults to the shipping address.
- \`customerNote\` *(optional)* — up to 500 characters.
`;

/** Sets both tokens from a Register or Log in response. */
const KEEP_TOKENS = `
const d = pm.response.json().data;
pm.collectionVariables.set('accessToken', d.tokens.accessToken);
pm.collectionVariables.set('refreshToken', d.tokens.refreshToken);
`;

// --------------------------------------------------------------- 1. Store setup

const storeSetup = folder(
  '1. Store setup',
  `
Call these when the app starts: currency settings, the site-wide content, and the navigation data. All public.
`,
  [
    req('Store config', 'GET', '/store/config', `
Currency and store settings, needed to show and send prices.

**Auth:** none.
**Returns:** \`currency\` (e.g. \`PKR\`), \`minorUnitExponent\`, \`name\`, \`timezone\`.

Every amount in this API is an integer in the currency's smallest unit. Divide by 10^\`minorUnitExponent\` to display it — PKR is \`0\`, so amounts are already whole rupees. Never assume 100. Money objects also carry a ready-made \`formatted\` string.
`, {
      test: `
pm.test('200', () => pm.response.to.have.status(200));
const d = pm.response.json().data;
pm.collectionVariables.set('currency', d.currency);
pm.collectionVariables.set('minorUnitExponent', d.minorUnitExponent);
`,
    }),
    req('Content sections', 'GET', '/content/sections', `
All the shop-managed content for the storefront chrome, in one call.

**Auth:** none.
**Returns:** a list of sections, each with a \`key\` and its \`data\`:
- \`announcement_bar\` — \`data.items[]\`, each with \`text\` (up to 10 messages for the top bar).
- \`home_banner_slider\` — \`data.items[]\`, each with \`url\` and optional \`alt\` (up to 5 homepage slides).

Only live items are returned, so render whatever comes back.
`, {
      test: `
pm.test('200', () => pm.response.to.have.status(200));
const sections = pm.response.json().data;
pm.test('announcement bar and banners in one call', () => {
  const keys = sections.map((s) => s.key);
  pm.expect(keys).to.include('announcement_bar');
  pm.expect(keys).to.include('home_banner_slider');
});
pm.test('each section carries its data', () => sections.forEach((s) => pm.expect(s).to.have.property('data')));
`,
    }),
    req('Content section by key', 'GET', '/content/sections/announcement_bar', `
One section on its own — \`announcement_bar\` or \`home_banner_slider\`. Same shape as an entry in **Content sections**.

**Auth:** none. An unknown key is a 404.
`, {
      test: `
pm.test('200', () => pm.response.to.have.status(200));
pm.test('the requested section', () => pm.expect(pm.response.json().data.key).to.eql('announcement_bar'));
`,
    }),
    req('Category tree', 'GET', '/categories/tree', `
The navigation menu: top-level categories, each with its \`children\` (subcategories — the tree is at most two levels deep), in the shop's display order.

**Auth:** none.
**Returns:** a list of categories, each with \`id\`, \`name\`, \`slug\`, \`children\`. Use a category's \`id\` as \`categoryId\` (or a child's as \`subcategoryId\`) to filter products.
`, {
      test: `
pm.test('200', () => pm.response.to.have.status(200));
const roots = pm.response.json().data;
pm.test('siblings in display order', () => {
  const orders = roots.map((c) => c.order);
  pm.expect(orders).to.eql(orders.slice().sort((a, b) => a - b));
});
if (roots.length) pm.collectionVariables.set('categoryId', roots[0].id);
`,
    }),
    req('Sizes', 'GET', '/sizes', `
Every size the shop uses (e.g. S, M, L), in display order — for a size filter. A product's own sizes come with the product.

**Auth:** none.
**Returns:** a list of sizes, each with \`id\`, \`name\`, \`code\`.
`, {
      test: `
pm.test('200', () => pm.response.to.have.status(200));
const sizes = pm.response.json().data;
pm.test('in display order', () => {
  const orders = sizes.map((s) => s.order);
  pm.expect(orders).to.eql(orders.slice().sort((a, b) => a - b));
});
`,
    }),
  ],
);

// ----------------------------------------------------------------- 2. Catalogue

const catalogue = folder(
  '2. Catalogue',
  `
Product listing, search, filters and product pages. All public — no token needed.

A product's \`effectivePrice\` is what the customer pays. When \`isOnPromotion\` is true, show \`price\` struck through next to it.
`,
  [
    req('Browse products', 'GET', '/products', `
A page of published products — a category or "all products" page with numbered pages.

**Auth:** none.
**Query (all optional):**
- \`page\` — from 1. \`limit\` — 1–100, default 20.
- \`sort\` — \`createdAt\` (newest), \`effectivePrice\`, \`name\`, \`sellCount\` (best sellers), \`rating.average\`; \`relevance\` together with \`search\`.
- \`order\` — \`asc\` or \`desc\` (default \`desc\`).

**Returns:** \`items\` (products) and \`meta\` with \`total\`, \`page\`, \`limit\`, \`pages\`, \`hasNext\`, \`hasPrevious\`.
`, {
      query: [q('page', '1'), q('limit', '20'), q('sort', 'createdAt'), q('order', 'desc')],
      test: `
pm.test('200', () => pm.response.to.have.status(200));
const body = pm.response.json().data;
pm.test('page meta', () => pm.expect(body.meta).to.include.keys('total', 'page', 'pages', 'hasNext'));
const first = body.items[0];
const word = first && (first.name.match(/[A-Za-z]{3,}/) || [])[0];
pm.collectionVariables.set('searchTerm', word || 'suit');
`,
    }),
    req('Infinite scroll — first batch', 'GET', '/products', `
For an endless-scroll feed, use \`paginate=cursor\` instead of page numbers.

**Auth:** none.
**Query:** \`paginate=cursor\`, plus optional \`limit\`, \`sort\`, \`order\` and any filter from **Filter products**. \`sort=relevance\` is not available in this mode.
**Returns:** \`items\` and \`meta.nextCursor\`. Pass that value as \`cursor\` to load the next batch. A \`null\` cursor means there is nothing more.

Unlike page numbers, a cursor never shows a product twice or skips one when products are added while the customer scrolls.
`, {
      query: [q('paginate', 'cursor'), q('limit', '12'), q('sort', 'createdAt'), q('order', 'desc')],
      test: `
pm.test('200', () => pm.response.to.have.status(200));
const body = pm.response.json().data;
pm.test('cursor meta, not page meta', () => {
  pm.expect(body.meta).to.have.property('nextCursor');
  pm.expect(body.meta).to.not.have.property('total');
});
pm.collectionVariables.set('productCursor', body.meta.nextCursor || '');
`,
    }),
    req('Infinite scroll — next batch', 'GET', '/products', `
The next batch of the feed: the same query as the first request, plus \`cursor\` set to the previous response's \`meta.nextCursor\`. Keep every other parameter the same.

**Auth:** none.
`, {
      query: [
        q('paginate', 'cursor'),
        q('limit', '12'),
        q('sort', 'createdAt'),
        q('order', 'desc'),
        q('cursor', '{{productCursor}}'),
      ],
      test: `
pm.test('200', () => pm.response.to.have.status(200));
const body = pm.response.json().data;
pm.test('a list of products', () => pm.expect(body.items).to.be.an('array'));
pm.collectionVariables.set('productCursor', body.meta.nextCursor || '');
`,
    }),
    req('Search', 'GET', '/products', `
Full-text search over product names and descriptions. Add \`sort=relevance\` to put the best matches first (numbered pages only).

**Auth:** none.
**Query:** \`search\` *(required here)*, plus any option from **Browse products** and **Filter products**.
`, {
      query: [q('search', '{{searchTerm}}'), q('sort', 'relevance')],
      test: `
pm.test('200', () => pm.response.to.have.status(200));
pm.test('a list of products', () => pm.expect(pm.response.json().data.items).to.be.an('array'));
`,
    }),
    req('Filter products', 'GET', '/products', `
Listing filters. Combine any of them with each other and with the browse options. The disabled parameters in the Params tab show the rest — tick one to try it.

**Auth:** none.
**Query (all optional):**
- \`categoryId\` — everything under a top-level category, subcategories included.
- \`subcategoryId\` — one subcategory only.
- \`sizeId\` — only products offered in that size.
- \`sizing\` — \`SIZED\` (choose a size) or \`UNSTITCHED\`.
- \`onPromotion=true\` — only discounted products.
- \`minPrice\`, \`maxPrice\` — in minor units, on the price actually charged.
- \`inStock=true\` — hide sold-out products.
`, {
      query: [
        q('inStock', 'true'),
        q('limit', '50'),
        q('categoryId', '{{categoryId}}', 'Top-level category id from Category tree', true),
        q('subcategoryId', '', 'A subcategory id', true),
        q('sizeId', '', 'A size id from Sizes', true),
        q('sizing', 'SIZED', 'SIZED or UNSTITCHED', true),
        q('onPromotion', 'true', 'Only discounted products', true),
        q('minPrice', '1000', 'Minor units', true),
        q('maxPrice', '10000', 'Minor units', true),
      ],
      test: `
pm.test('200', () => pm.response.to.have.status(200));
const product = pm.response.json().data.items.find((p) => p.inStock);
pm.test('an in-stock product to buy (publish one if this fails)', () => pm.expect(product).to.be.an('object'));
if (product) {
  // Hand a real product to the product-page and checkout requests below.
  pm.collectionVariables.set('productId', product.id);
  pm.collectionVariables.set('productSlug', product.slug);
  const line = { productId: product.id, quantity: 1 };
  if (product.sizing === 'SIZED' && product.sizes.length) line.sizeId = product.sizes[0].id;
  pm.collectionVariables.set('checkoutItems', JSON.stringify([line]));
}
`,
    }),
    req('Get product', 'GET', '/products/{{productId}}', `
One product by \`id\`, with its images, sizes, prices and stock.

**Auth:** none. An unpublished or deleted product is a 404.
`, {
      test: `
pm.test('200', () => pm.response.to.have.status(200));
pm.test('the product asked for', () => pm.expect(pm.response.json().data.id).to.eql(pm.collectionVariables.get('productId')));
`,
    }),
    req('Get product by slug', 'GET', '/products/slug/{{productSlug}}', `
The same product, looked up by the \`slug\` in its page URL — what a product page loads.

**Auth:** none.
**Notable fields:**
- \`description\` is rich text (HTML, already sanitised by the server) — render it as HTML.
- \`facebookVideoUrl\` links the product's video on the shop's Facebook page, when set.
- \`sizes\` lists the sizes to choose from when \`sizing\` is \`SIZED\`; \`inStock\` and \`stock\` say whether it can be bought.
`, {
      test: `
pm.test('200', () => pm.response.to.have.status(200));
pm.test('the same product', () => pm.expect(pm.response.json().data.id).to.eql(pm.collectionVariables.get('productId')));
`,
    }),
  ],
);

// ------------------------------------------------------------------- 3. Account

const account = folder(
  '3. Account',
  `
Sign-up, sign-in and the customer's profile. Signed-in requests send \`Authorization: Bearer <accessToken>\`.
`,
  [
    req('Register', 'POST', '/auth/register', `
Creates a customer account and signs it in.

**Auth:** none.
**Body:**
- \`name\` *(required)*
- \`email\` *(required, must not be registered already)*
- \`password\` *(required)* — at least 10 characters, with upper and lower case letters, a number and a symbol.
- \`birthdate\` *(optional)* — \`YYYY-MM-DD\`.

**Returns:** \`user\` and \`tokens\` (\`accessToken\`, \`refreshToken\`). An email that is already registered is a 409. Limited to 10 attempts a minute.
`, {
      body: { name: 'Ayesha Khan', email: '{{customerEmail}}', password: '{{customerPassword}}' },
      prerequest: `
// A fresh address each run, so the collection can be run again and again.
pm.collectionVariables.set('customerEmail', \`ayesha+\${Date.now()}@example.com\`);
`,
      test: `
pm.test('201', () => pm.response.to.have.status(201));${KEEP_TOKENS}`,
    }),
    req('Log in', 'POST', '/auth/login', `
Signs in with email and password.

**Auth:** none.
**Body:** \`email\`, \`password\`.
**Returns:** \`user\` and \`tokens\` (\`accessToken\`, \`refreshToken\`). Wrong credentials, or a deactivated account, is a 401. Limited to 10 attempts a minute.
`, {
      body: { email: '{{customerEmail}}', password: '{{customerPassword}}' },
      test: `
pm.test('200', () => pm.response.to.have.status(200));${KEEP_TOKENS}`,
    }),
    req('Me', 'GET', '/auth/me', `
The signed-in customer's account — use it to restore a session when the app opens.

**Auth:** Bearer token.
**Returns:** \`id\`, \`name\`, \`email\`, \`birthdate\`, \`role\`, and account dates.
`, {
      auth: true,
      test: `
pm.test('200', () => pm.response.to.have.status(200));
pm.test('the registered customer', () => pm.expect(pm.response.json().data.email).to.eql(pm.collectionVariables.get('customerEmail')));
`,
    }),
    req('Refresh tokens', 'POST', '/auth/refresh', `
Access tokens expire after 15 minutes. When a request comes back 401, exchange the refresh token for a new pair here, then retry the request.

**Auth:** none.
**Body:** \`refreshToken\`.
**Returns:** a new \`accessToken\` and \`refreshToken\`. Each refresh token works only once — always keep the new one. Refresh tokens last 30 days; after that the customer signs in again.
`, {
      body: { refreshToken: '{{refreshToken}}' },
      test: `
pm.test('200', () => pm.response.to.have.status(200));
const d = pm.response.json().data;
pm.collectionVariables.set('accessToken', d.accessToken);
pm.collectionVariables.set('refreshToken', d.refreshToken);
`,
    }),
    req('Update my profile', 'PATCH', '/users/me', `
Changes the signed-in customer's own details.

**Auth:** Bearer token.
**Body (all optional):** \`name\`, \`email\`, \`birthdate\` (\`YYYY-MM-DD\`).
**Returns:** the updated account. Any other field is a 400 — the password changes through **Change password**.
`, {
      auth: true,
      body: { name: 'Ayesha K.', birthdate: '1995-04-18' },
      test: `
pm.test('200', () => pm.response.to.have.status(200));
pm.test('saved', () => pm.expect(pm.response.json().data.name).to.eql('Ayesha K.'));
`,
    }),
  ],
);

// -------------------------------------------------------- 4. Checkout & orders

/**
 * `items` is interpolated as raw JSON, not a string: Filter products stores a
 * real in-stock product there, with a size only when the product needs one.
 */
const checkoutBody =
  '{\n  "items": {{checkoutItems}},\n  "shippingAddress": ' +
  JSON.stringify(ADDRESS, null, 4).replace('\n}', '\n  }') +
  ',\n  "customerNote": "Please call before delivery"\n}';

const orders = folder(
  '4. Checkout & orders',
  `
The basket lives in the app; checkout sends it in one request. Prices, totals and stock are always decided by the server, never taken from the request.
`,
  [
    req('Checkout', 'POST', '/orders/checkout', `
Places an order for the signed-in customer.

**Auth:** Bearer token.
**Headers:** \`Idempotency-Key\` *(required)* — a new random value (e.g. a UUID) for each order attempt, at least 8 characters. Send the same value again when retrying the same attempt after a timeout, so the customer can never be charged for two orders.
${CHECKOUT_BODY_FIELDS}
**Returns:** the order, with status \`PENDING\` (awaiting payment). Not enough stock is a 409. Limited to 20 a minute.
`, {
      auth: true,
      idempotent: true,
      body: checkoutBody,
      test: `
pm.test('201', () => pm.response.to.have.status(201));
const d = pm.response.json().data;
pm.collectionVariables.set('orderId', d.id);
pm.collectionVariables.set('orderTotal', d.grandTotal.amount);
pm.test('starts unpaid', () => pm.expect(d.status).to.eql('PENDING'));
pm.test('priced by the server', () =>
  pm.expect(d.subtotal.amount).to.eql(d.items.reduce((sum, item) => sum + item.lineTotal.amount, 0)));
`,
    }),
    req('My orders', 'GET', '/orders', `
The customer's orders, newest first.

**Auth:** Bearer token (a guest's \`guest_token\` cookie lists the guest's orders).
**Query (all optional):** \`page\`, \`limit\`, \`status\` (e.g. \`PENDING\`), \`sort\` — \`createdAt\`, \`placedAt\`, \`grandTotal\` or \`status\` — and \`order\`.
**Returns:** \`items\` and page \`meta\`.
`, {
      auth: true,
      query: [q('page', '1'), q('limit', '10')],
      test: `
pm.test('200', () => pm.response.to.have.status(200));
pm.test('includes the new order', () =>
  pm.expect(pm.response.json().data.items.map((o) => o.id)).to.include(pm.collectionVariables.get('orderId')));
`,
    }),
    req('Get order', 'GET', '/orders/{{orderId}}', `
One order with its items, totals, addresses and \`statusHistory\`.

**Auth:** Bearer token, or the guest cookie for a guest order. Someone else's order is a 404.
**Order statuses:** \`PENDING\` (awaiting payment) → \`PAID\` → \`FULFILLING\` → \`SHIPPED\` → \`DELIVERED\`; or \`CANCELLED\` (before dispatch) / \`RETURNED\` (after it). A cash-on-delivery order goes from \`PENDING\` straight to \`FULFILLING\`.
`, {
      auth: true,
      test: `
pm.test('200', () => pm.response.to.have.status(200));
pm.test('the order', () => pm.expect(pm.response.json().data.id).to.eql(pm.collectionVariables.get('orderId')));
`,
    }),
  ],
);

// ------------------------------------------------------------------- 5. Payment

const payment = folder(
  '5. Payment',
  `
After checkout, the customer chooses how to pay. The amount always comes from the order.
`,
  [
    req('Pay by bank transfer', 'POST', '/payments', `
Starts payment for an order.

**Auth:** Bearer token (the guest cookie for a guest order).
**Body:** \`orderId\`, \`method\` — \`BANK_TRANSFER\` or \`CASH_ON_DELIVERY\`.
**Returns:** the payment, with its \`status\` and \`instructions\`:
- **Bank transfer** — \`instructions\` holds \`bankName\`, \`accountName\`, \`accountNumber\` and the \`paymentReference\` the customer must quote. Show these. The payment stays \`PENDING\` until the shop confirms the money arrived; the order then becomes \`PAID\`.
- **Cash on delivery** — the payment is \`AUTHORIZED\` at once and the order moves to fulfilment; the courier collects the money.

An order that is not awaiting payment is a 409.
`, {
      auth: true,
      body: { orderId: '{{orderId}}', method: 'BANK_TRANSFER' },
      test: `
pm.test('201', () => pm.response.to.have.status(201));
const d = pm.response.json().data;
pm.collectionVariables.set('paymentId', d.id);
pm.test('amount comes from the order', () => pm.expect(d.amount.amount).to.eql(Number(pm.collectionVariables.get('orderTotal'))));
pm.test('bank details to show the customer', () => pm.expect(d.instructions.paymentReference).to.be.a('string'));
pm.test('pending until the transfer clears', () => pm.expect(d.status).to.eql('PENDING'));
`,
    }),
    req('Get payment', 'GET', '/payments/{{paymentId}}', `
One payment's current state — poll it on an order-confirmation page.

**Auth:** Bearer token, or the guest cookie.
**Payment statuses:** \`PENDING\`, \`AUTHORIZED\`, \`CAPTURED\` (money received), \`FAILED\`, \`CANCELLED\`, \`REFUNDED\`, \`PARTIALLY_REFUNDED\`.
`, {
      auth: true,
      test: `
pm.test('200', () => pm.response.to.have.status(200));
pm.test('the payment', () => pm.expect(pm.response.json().data.id).to.eql(pm.collectionVariables.get('paymentId')));
`,
    }),
    req('Payments for an order', 'GET', '/payments/orders/{{orderId}}', `
Every payment attempt made for one order, e.g. to show the bank details again later.

**Auth:** Bearer token, or the guest cookie.
`, {
      auth: true,
      test: `
pm.test('200', () => pm.response.to.have.status(200));
pm.test('includes the payment', () =>
  pm.expect(pm.response.json().data.map((p) => p.id)).to.include(pm.collectionVariables.get('paymentId')));
`,
    }),
  ],
);

// ---------------------------------------------------------------- 6. Cancelling

const cancelling = folder(
  '6. Cancelling',
  `
A customer can cancel their own order until the shop starts fulfilling it.
`,
  [
    req('Cancel order', 'POST', '/orders/{{orderId}}/cancel', `
Cancels the order and returns its items to stock.

**Auth:** Bearer token, or the guest cookie for a guest order.
**Body (optional):** \`reason\` — up to 500 characters.
**Returns:** the order, now \`CANCELLED\`. Only \`PENDING\` or \`PAID\` orders can be cancelled here; after that it is a 403 and the customer has to contact the shop.
`, {
      auth: true,
      body: { reason: 'Ordered the wrong colour' },
      test: `
pm.test('201', () => pm.response.to.have.status(201));
pm.test('cancelled', () => pm.expect(pm.response.json().data.status).to.eql('CANCELLED'));
`,
    }),
  ],
);

// ------------------------------------------------------------ 7. Guest checkout

const guestBody = JSON.stringify(
  {
    items: '__ITEMS__',
    email: 'guest+{{$timestamp}}@example.com',
    name: 'Bilal Ahmed',
    shippingAddress: {
      ...ADDRESS,
      fullName: 'Bilal Ahmed',
      line1: 'Flat 3, Block B, Gulberg III',
      city: 'Lahore',
      postalCode: '54660',
    },
  },
  null,
  2,
).replace('"__ITEMS__"', '{{checkoutItems}}');

const guest = folder(
  '7. Guest checkout',
  `
Buying without an account. The guest is identified by a cookie the server sets at checkout, so web clients must send cookies: \`fetch(url, { credentials: "include" })\`.
`,
  [
    req('Checkout as a guest', 'POST', '/orders/checkout', `
The same checkout without signing in.

**Auth:** none.
**Headers:** \`Idempotency-Key\` *(required)* — as for **Checkout**.
**Body:** the same as **Checkout**, plus \`email\` and \`name\` *(both required for a guest)* — the order confirmation is emailed there.

**Returns:** the order (\`isGuestOrder: true\`). The response also sets an httpOnly \`guest_token\` cookie, valid for 30 days. It is how this guest reads, pays for, cancels and tracks the order — keep sending it.
`, {
      idempotent: true,
      body: guestBody,
      test: `
pm.test('201', () => pm.response.to.have.status(201));
const d = pm.response.json().data;
pm.collectionVariables.set('guestOrderId', d.id);
pm.test('placed without an account', () => pm.expect(d.isGuestOrder).to.be.true);
pm.test('guest cookie set', () => pm.expect(pm.cookies.has('guest_token')).to.be.true);
`,
    }),
    req('View guest order', 'GET', '/orders/{{guestOrderId}}', `
The guest reads their order back — the same endpoint as **Get order**.

**Auth:** the \`guest_token\` cookie from checkout; no token. Without the cookie it is a 404.
`, {
      test: `
pm.test('200', () => pm.response.to.have.status(200));
pm.test('the guest order', () => pm.expect(pm.response.json().data.id).to.eql(pm.collectionVariables.get('guestOrderId')));
`,
    }),
    req('Pay cash on delivery', 'POST', '/payments', `
Cash on delivery for the guest order — the same endpoint as **Pay by bank transfer**, with \`method: "CASH_ON_DELIVERY"\`.

**Auth:** the guest cookie.
**Returns:** the payment, \`AUTHORIZED\` — the order goes to fulfilment and the courier collects the money.
`, {
      body: { orderId: '{{guestOrderId}}', method: 'CASH_ON_DELIVERY' },
      test: `
pm.test('201', () => pm.response.to.have.status(201));
pm.test('authorized, not pending', () => pm.expect(pm.response.json().data.status).to.eql('AUTHORIZED'));
`,
    }),
  ],
);

// -------------------------------------------------------- 8. Delivery tracking

const tracking = folder(
  '8. Delivery tracking',
  `
A shipment is created automatically a few seconds after an order is confirmed (paid, or cash on delivery). Before that, tracking returns 404.
`,
  [
    req("Track an order's shipment", 'GET', '/shipments/orders/{{guestOrderId}}', `
The shipment for one order — its \`status\`, plus the carrier and tracking details once the shop dispatches it.

**Auth:** Bearer token, or the guest cookie.
**Shipment statuses:** \`PENDING\`, \`PREPARING\`, \`IN_TRANSIT\`, \`DELIVERED\`, \`FAILED\` (delivery attempt failed), \`RETURNED\`, \`CANCELLED\`.

A 404 just after payment means the shipment has not been created yet — try again shortly.
`, {
      test: `
// The shipment is created asynchronously just after the order is confirmed, so
// a 404 on the first try is expected; retry a few times before failing.
const attempts = Number(pm.collectionVariables.get('shipmentAttempts') || 0);
if (pm.response.code === 404 && attempts < 10) {
  pm.collectionVariables.set('shipmentAttempts', attempts + 1);
  const until = Date.now() + 700;
  while (Date.now() < until) { /* wait for the shipment to be created */ }
  pm.execution.setNextRequest("Track an order's shipment");
} else {
  pm.collectionVariables.set('shipmentAttempts', 0);
  pm.test('200', () => pm.response.to.have.status(200));
  pm.collectionVariables.set('shipmentId', pm.response.json().data.id);
}
`,
    }),
    req('Get shipment', 'GET', '/shipments/{{shipmentId}}', `
One shipment by \`id\`.

**Auth:** Bearer token, or the guest cookie.
`, {
      test: `
pm.test('200', () => pm.response.to.have.status(200));
pm.test('the shipment', () => pm.expect(pm.response.json().data.id).to.eql(pm.collectionVariables.get('shipmentId')));
`,
    }),
    req('My shipments', 'GET', '/shipments', `
All of the customer's shipments, newest first.

**Auth:** Bearer token, or the guest cookie (this request sends only the cookie, so it lists the guest's).
**Query (all optional):** \`page\`, \`limit\`, \`status\`, \`order\`.
`, {
      query: [q('page', '1'), q('limit', '10')],
      test: `
pm.test('200', () => pm.response.to.have.status(200));
pm.test('includes the shipment', () =>
  pm.expect(pm.response.json().data.items.map((s) => s.id)).to.include(pm.collectionVariables.get('shipmentId')));
`,
    }),
  ],
);

// ---------------------------------------------------- 9. Password & signing out

const sessions = folder(
  '9. Password & signing out',
  `
Changing the password, resetting a forgotten one, and ending sessions.
`,
  [
    req('Change password', 'POST', '/auth/change-password', `
Changes the customer's password.

**Auth:** Bearer token.
**Body:** \`currentPassword\`, \`newPassword\` (same rules as at registration).
**Returns:** 204, no body. Every session on every device is signed out, so sign in again with the new password. A wrong current password is a 401. Limited to 10 attempts a minute.
`, {
      auth: true,
      body: { currentPassword: '{{customerPassword}}', newPassword: '{{newPassword}}' },
      test: `
pm.test('204', () => pm.response.to.have.status(204));
`,
    }),
    req('Log in with the new password', 'POST', '/auth/login', `
**Log in** again, now with the new password.
`, {
      body: { email: '{{customerEmail}}', password: '{{newPassword}}' },
      test: `
pm.test('200', () => pm.response.to.have.status(200));${KEEP_TOKENS}`,
    }),
    req('Log out', 'POST', '/auth/logout', `
Signs out of this device: the refresh token stops working. Delete both tokens from the app afterwards.

**Auth:** Bearer token.
**Body:** \`refreshToken\`.
**Returns:** 204, no body.
`, {
      auth: true,
      body: { refreshToken: '{{refreshToken}}' },
      test: `
pm.test('204', () => pm.response.to.have.status(204));
`,
    }),
    req('Log out everywhere', 'POST', '/auth/logout-all', `
Signs the customer out on every device at once — e.g. after losing a phone.

**Auth:** Bearer token.
**Returns:** 200.
`, {
      auth: true,
      test: `
pm.test('200', () => pm.response.to.have.status(200));
`,
    }),
    req('Forgot password', 'POST', '/auth/forgot-password', `
Starts a reset for a customer who has forgotten their password: a 6-digit code is emailed to them.

**Auth:** none.
**Body:** \`email\`.
**Returns:** 202 with a \`message\`. The answer is always the same, whether or not the email has an account, so the app cannot be used to find out who is registered — show something like "If an account exists, we've emailed you a code".

The code expires after 10 minutes and works once. Asking again within a minute sends nothing (the earlier code still works), and at most 5 codes are sent an hour. Only customer accounts can reset this way. Limited to 10 attempts a minute.
`, {
      body: { email: '{{customerEmail}}' },
      test: `
pm.test('202', () => pm.response.to.have.status(202));
pm.test('the same answer for everyone', () => pm.expect(pm.response.json().data.message).to.be.a('string'));
`,
    }),
    req('Reset password', 'POST', '/auth/reset-password', `
Sets a new password using the code from the email.

**Auth:** none.
**Body:** \`email\`, \`code\` (the 6 digits from the email), \`newPassword\` (same rules as at registration).
**Returns:** 204, no body. The customer is signed out on every device and signs in with the new password; a confirmation email follows.

Every failure — a wrong, expired or already-used code — is the same 400 with code \`INVALID_RESET_CODE\`: "The code is invalid or has expired". After 5 wrong tries the code stops working and the customer asks for a new one. A weak \`newPassword\` is an ordinary validation 400 and does not use up a try. Limited to 10 attempts a minute.

*In this collection:* set the \`resetCode\` variable to the code from the email to see a 204; left at \`000000\` it shows the 400.
`, {
      body: { email: '{{customerEmail}}', code: '{{resetCode}}', newPassword: '{{resetNewPassword}}' },
      test: `
// Newman cannot read the inbox: with the placeholder code the API answers with
// the generic 400; with the real code from the email, 204.
const placeholder = pm.collectionVariables.get('resetCode') === '000000';
pm.test(placeholder ? '400 without the emailed code' : '204', () =>
  pm.response.to.have.status(placeholder ? 400 : 204));
if (placeholder) pm.test('the one generic error', () => pm.expect(pm.response.json().code).to.eql('INVALID_RESET_CODE'));
`,
    }),
  ],
);

// ---------------------------------------------------------------- the collection

const collection = {
  info: {
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    name: 'Store — customer API',
    description: md(`
Every API the customer-facing store (website or app) integrates — nothing admin-only.

**Base URL:** \`{{baseUrl}}\`, e.g. \`https://api.yourshop.pk/api/v1\`.

**Responses** are wrapped: \`{ "success": true, "data": ... }\`. Lists put their rows in \`data.items\` and paging in \`data.meta\`.
**Errors** look like \`{ "success": false, "code": "...", "message": "...", "details": ... }\` with the matching HTTP status.

**Signing in:** Register or Log in returns an \`accessToken\` (15 minutes) and a \`refreshToken\` (30 days). Send \`Authorization: Bearer <accessToken>\`; on a 401, call Refresh tokens and retry.
**Guests** can check out without an account. The server then identifies them with an httpOnly \`guest_token\` cookie, so web clients must send requests with \`credentials: "include"\`.
**Money:** every amount is an integer in the currency's smallest unit — see Store config. Display the \`formatted\` string or divide by 10^\`minorUnitExponent\`.
**Rate limits:** 300 requests a minute per client; sign-in, registration, token refresh and password change 10 a minute; checkout 20 a minute. Over the limit is a 429.

**Running this collection:** run the folders top to bottom — each request hands ids to the next through collection variables. The shop needs at least one published, in-stock product.
`),
  },
  item: [storeSetup, catalogue, account, orders, payment, cancelling, guest, tracking, sessions],
  variable: [
    ['baseUrl', 'http://localhost:4000/api/v1'],
    ['customerEmail', ''],
    ['customerPassword', 'StrongP@ssw0rd!'],
    ['newPassword', 'N3w-StrongP@ss!'],
    ['accessToken', ''],
    ['refreshToken', ''],
    ['currency', ''],
    ['minorUnitExponent', ''],
    ['categoryId', ''],
    ['searchTerm', ''],
    ['productCursor', ''],
    ['productId', ''],
    ['productSlug', ''],
    ['checkoutItems', '[]'],
    ['orderId', ''],
    ['orderTotal', ''],
    ['paymentId', ''],
    ['guestOrderId', ''],
    ['shipmentId', ''],
    ['shipmentAttempts', '0'],
    ['resetCode', '000000'],
    ['resetNewPassword', 'R3set-StrongP@ss!'],
  ].map(([key, value]) => ({ key, value })),
};

const target = join(__dirname, '..', '..', 'store.postman_collection.json');
writeFileSync(target, JSON.stringify(collection, null, 2) + '\n');

const count = collection.item.reduce((n, section) => n + section.item.length, 0);
console.log(`Wrote ${count} requests across ${collection.item.length} folders`);
console.log(`  → ${target}`);
