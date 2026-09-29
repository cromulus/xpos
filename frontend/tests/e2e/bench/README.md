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
| `XPOS_BENCH_PROFILE`, `XPOS_BENCH_COMPANY` | The POS Profile (with **Use Offline Mode** on) and its company |
| `XPOS_BENCH_ITEM` | An item in stock with a price, shown in the item list |
| `XPOS_BENCH_CUSTOMER` | The customer the tickets are rung up for |
| `XPOS_BENCH_SECOND_MODE` | The second ticket's tender (default `Cash`) |

The profile's discount cap (`max_discount_percentage_allowed`) must be under
30% for the refused-sale story.
