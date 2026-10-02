# Specs against a real bench

`tests/e2e/specs` run against the Vite dev server with a stubbed backend.
The specs here drive XPOS on a **real** Frappe bench instead. They log in,
sell, and read back the Sales Invoices the server made. Use them for stories
that only mean something end to end, such as offline selling and sync.

```bash
yarn test:e2e:bench                     # every bench spec, headless Chrome
yarn test:e2e:bench --spec tests/e2e/bench/offline-selling.cy.ts
```

Chrome is required: going offline uses the Chrome DevTools Protocol
(`Network.emulateNetworkConditions`), which cuts the page's network for
real. The browser then fires `offline` and `navigator.onLine` turns false.
Chrome is started with `--unsafely-treat-insecure-origin-as-secure` for the
bench origin (cypress.bench.config.ts), so a plain-http bench such as erp2's
slots gets the service worker it would have on https. Cypress's
`document.domain` injection is skipped for the bench host
(`experimentalSkipDomainInjection`): a page the service worker serves from its
cache never passes Cypress's proxy, and without this Cypress waits forever for
its load event.

## Settings (`frontend/.env.local`, never committed)

| Variable | Meaning |
|---|---|
| `XPOS_BENCH_URL` | The site, e.g. `http://localhost:8080` |
| `XPOS_BENCH_USER`, `XPOS_BENCH_PASSWORD` | A user on the POS Profile, with a POS Role that may sell |
| `XPOS_BENCH_SHARED_LOGIN` | Optional: the bench user is the profile's Shared Login (Mule City's cashier-only pos@; erp2's `offline_fixtures.py` makes it and sets this, MuleCity-g4gj). Pay must then ask for cashier initials, and a story fails if it does not |
| `XPOS_BENCH_INITIALS` | Listed cashier initials typed at Pay on a Shared Login (default `LE`) |
| `XPOS_BENCH_IMPERSONATE` | Optional: log in as an administrator above, then continue as this cashier (Frappe Impersonate) |
| `XPOS_BENCH_PROFILE`, `XPOS_BENCH_COMPANY` | The POS Profile (with **Use Offline Mode** on) and its company |
| `XPOS_BENCH_ITEM` | An item in stock with a price, shown in the item list |
| `XPOS_BENCH_CUSTOMER` | The customer the tickets are rung up for |
| `XPOS_BENCH_SECOND_MODE` | The second ticket's tender (default `Cash`) |
| `XPOS_BENCH_EXEMPT_CATEGORY` | A Tax Category whose Tax Rule charges no tax (default `Mule City Exempt`), for `offline-tax.cy.ts` |
| `XPOS_BENCH_FARM_CUSTOMER` | An exempt customer (in that category, in a customer group the profile syncs) made by an administrator before the run, for `offline-tax.cy.ts` (default `Offline Test Farm`, which the erp2 slot's `offline_fixtures.py` seeds). The counter cashier may only read customers; `offline-delivery.cy.ts` makes its customer through the counter's own Create New Customer call (`xpos.api.customers.create_customer`) |

The profile's discount cap (`max_discount_percentage_allowed`) must be under
30% for the refused-sale story.

## The offline suite (Mule City, MuleCity-ispl)

```bash
yarn test:offline:unit   # the offline unit specs (tests/offline*.spec.ts), no bench needed
yarn test:offline        # those, then every tests/e2e/bench/offline-*.cy.ts story on the bench
```

One story file per concern, named `offline-<concern>.cy.ts`, each story "who does
what offline, and what the server shows after sync":

| File | Story |
|---|---|
| `offline-selling.cy.ts` | two tickets sold offline both post; one over the discount cap waits for a manager |
| `offline-tax.cy.ts` | a farm customer this till never saw online is rung up untaxed; the synced invoice is untaxed |
| `offline-delivery.cy.ts` | a delivery to an address typed offline (with its miles) is priced at the till; the synced sale ships there, keeps that price and is flagged (MuleCity-6nb1); a customer with three addresses: the picker opens offline on the primary shipping one, a searched address with no miles is priced from typed miles, and the synced sale keeps the address, day and miles (MuleCity-qajl.3/.4) |
| `offline-reload.cy.ts` | with the internet down, a reload (F5) and a cold start of another till page open the till from the service worker's app shell with the boot saved at the last online start (no CSRF token on the device); a bag sold then queues, and on reconnect the till fetches a fresh boot and token before anything is sent, and the sale posts with that token; online, a reload is always the server's page (MuleCity-q8aq) |
| `offline-cold-start.cy.ts` | a browser that ran X POS online once opens `/xpos` and `/xpos/` as a new page with the internet down: with a shift open it starts as the saved user, sells, and the sale syncs with a fresh CSRF token on reconnect; with no shift open it says it is offline and that a shift needs the internet (MuleCity-q8aq, mc30) |
| `offline-orders.cy.ts` | the Orders view, opened online, keeps its list of Sales Orders in flight; offline it shows that list marked last known with its time (never "no orders"), searchable, and cannot load an order for payment (MuleCity-zstm.23) |

Shared steps live in `tests/e2e/support/offline.ts` (`openTillOnline`, which starts from
an empty offline store; `chooseCustomer`; `ringUpOneBag`; `waitUntil`; `customerInvoices`;
`restoreNetworkAfterEach`, which every story file registers). New offline stories, such as
the cashier switch (fb00.7), add a file and reuse these steps.
