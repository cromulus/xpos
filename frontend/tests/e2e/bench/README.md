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

## Settings (`frontend/.env.local`, never committed)

| Variable | Meaning |
|---|---|
| `XPOS_BENCH_URL` | The site, e.g. `http://localhost:8080` |
| `XPOS_BENCH_USER`, `XPOS_BENCH_PASSWORD` | A user on the POS Profile, with a POS Role that may sell |
| `XPOS_BENCH_IMPERSONATE` | Optional: log in as an administrator above, then continue as this cashier (Frappe Impersonate) |
| `XPOS_BENCH_PROFILE`, `XPOS_BENCH_COMPANY` | The POS Profile (with **Use Offline Mode** on) and its company |
| `XPOS_BENCH_ITEM` | An item in stock with a price, shown in the item list |
| `XPOS_BENCH_CUSTOMER` | The customer the tickets are rung up for |
| `XPOS_BENCH_SECOND_MODE` | The second ticket's tender (default `Cash`) |
| `XPOS_BENCH_EXEMPT_CATEGORY` | A Tax Category whose Tax Rule charges no tax (default `Mule City Exempt`), for `offline-tax.cy.ts` |
| `XPOS_BENCH_EXEMPT_REASON_FIELD`, `XPOS_BENCH_EXEMPT_REASON` | Optional: a Customer field and value the site requires for an exempt customer (Mule City: `mule_tax_exempt_reason` = `Farm`) |

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

Shared steps live in `tests/e2e/support/offline.ts` (`openTillOnline`, which starts from
an empty offline store; `chooseCustomer`; `ringUpOneBag`; `waitUntil`; `customerInvoices`;
`restoreNetworkAfterEach`, which every story file registers). New offline stories, such as
the cashier switch (fb00.7), add a file and reuse these steps.
