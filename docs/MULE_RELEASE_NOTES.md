# Mule City XPOS release notes

## mule-v2.10.1-mc1 (2026-09-27)

XPOS is Mule City's only POS. This fork's `main` is the release branch.
Base: upstream kodlyft/xpos v2.10.1 (`374b76b`). Target platform: ERPNext
16.36.0 / Frappe 16.35.0 with `mulecity_erpnext` installed.

### What is in it

- `mule-city-demo` (`19943ea`, `d4bdde7`): the pilot's committed edits.
- Pilot delta (`4cd69c1`): New Customer no longer shows "Customer type" or
  "Request tax exemption". The form always sent `mule_customer_kind`, and
  `create_customer` refuses that while the Customer custom fields are absent,
  which they are in `mulecity_erpnext`.
- `fix/bep-repeat-pricing` (`9d9dbc8`): repeat, tiles and the server price lock
  use ERPNext's price-list resolver (`selling_price`: customer, date, UOM);
  line rate and discount keep the field's precision; a past custom mix repeats
  as its mix Item.
- `feat/browser-cache-controls` (`6818a15`), `fix/durable-invoice-retries`
  (`9edd8d9`, `695c250`), `perf/batch-catalog-stock` (`44e70cb`): the reviewed
  versions of the cache, retry and stock features already in `mule-city-demo`.
  They add formatting and one retry test.
- `fix/mule-cart` (`721add0`: `494176f`, `923a107`, `d43b1bc`, `c66504b`,
  `2e861b3`, `e4e6565`, `721add0`):
  - Tiles, scans and cart lines use the Item's Default Sales UOM and its
    conversion (standard ERPNext Item config). Cow Feed 2 Bag = 100 lb, $18.
    This replaces the pilot/demo UOM handling with the standard setting.
  - `create_invoice` checks Sales Invoice create permission and the caller's
    seat at the register.
  - Repeat leaves out lines that have no Item.
  - `check_may_sell` gates create, save_draft and delete_draft. The server
    derives `conversion_factor` from the Item for the price lock. Scans keep
    `conversion_factor`. A duplicate replay is read-checked.
- `fece670`, `244d6c2`: test-only. Mocks follow bep's `selling_price` and
  mule-cart's register gate.

### Deploying

- It needs `mulecity_erpnext`. `xpos/api/invoices.py` imports
  `mulecity_erpnext` (taxes, order fields, mix repeat), so this build does not
  run standalone.
- Run `bench migrate`. It adds four POS Profile fields: Browser Customer
  Limit, Customer Order, Browser Product Limit and Product Order.
- Build the SPA (`cd frontend && yarn install --frozen-lockfile && yarn build`).
  Built assets are not committed.
- XPOS adds a Pakistan FBR tax field to Item's Foreign Trade section.
  `mulecity_erpnext` p0/xpos-settings hides it with a UI fixture. A bench
  without that branch fails one test. The fork is unchanged for this.
- Upstream `develop` commits `1ff0e58` and `a056d2d` are in the history
  because the three PR branches were cut from `develop`. Their flit_core
  `>=4.1` bump was reverted at merge, so the build pin stays v2.10.1's
  `>=3.12,<4`.

### Verified (on `bde2442`)

- Frontend: vitest 411/411, `vue-tsc --noEmit` clean, and `yarn build` OK.
- XPOS on bench `f9xpos` (restored 9/26 base, bootstrapped, ERPNext 16.36.0,
  Frappe 16.35.0):
  - `run-tests --app xpos`: 267/267 unit tests and 6/6 integration tests
    pass.
  - Parity probes: 25 of 31 pass. These now pass: 03, 07 and 12 (bep); 05,
    05b–05e, 08b, 10c, 14, 15 and 16 (mule-cart). The 6 that still fail are
    known gaps (see below).
- `mulecity_erpnext` full native suite: see the tag message.

### Known gaps and follow-ups for mc2

- DONE in mc1: `save_draft_invoice` now has the permission and register gate
  (`check_may_sell`, 721add0).
- P2: shift and rights gates. `open_shift` does not check that the user is on
  the POS Profile, so non-sellers (Joe, Paul) can open a shift on Mule City
  Retail, although their sales are still refused. `close_shift` does not check
  whose shift it is, so one cashier can close another's with any count. The
  sync endpoint trusts client amounts. XPOS rights (returns, discounts) are
  enforced only in the UI, not in `create_invoice`.
- P2: the Electron offline tile still uses the stock UOM, not the Default
  Sales UOM.
- Parity 02: the cart charges the pre-split total for a grain depositor
  (needs a server cart preview).
- Parity 04b: `find_mixes` / `mix_details` miss mixes in job sub-groups
  (server side, `mulecity_erpnext`).
- Parity 06: XPOS returns carry no tax rows.
- Parity 08c: Lisa cannot open or close her till. Config: a POS Role on her
  POS Profile User row.
- Parity 09: config: `POS Profile.default_print_format = Mule City Ticket`.
- Parity 10: repeat search does not find a FilePro ticket number.

### Mule-specific logic and what could replace it

One line per item. Status is either "keep" or "follow-up: remove, replace with ...".

**mule-city-demo `19943ea`**
- Browser cache limits and order (POS Profile fields, sync status): generic XPOS feature, configured on POS Profile. Keep; offer upstream.
- Durable invoice journal and retry identity: generic. Keep; offer upstream.
- Batched catalog stock: generic. Keep; offer upstream.
- `MuleWorkspace.vue` (customer mixes, pickup orders, prepare order, formula editor): Mule-specific, and no config replaces it. Keep.
- `muleOrderFields.ts` / `_mule_order_fields` (carry `mule_*` quote fields to the invoice): Mule-specific, and Mule's validation requires it. Keep.
- Cart `muleTax*` and server `apply_customer_taxes`: follow-up: remove, replace with a generic XPOS change that resolves taxes through ERPNext `get_party_details` (Tax Rule + Customer Tax Category). Config alone cannot do this, because XPOS applies the POS Profile template.

**mule-city-demo `d4bdde7`**
- Counter search across the POS Settings search fields (alias such as `mule_legacy_product_code`): generic, and configured in POS Settings. Keep.
- Repeat search by customer and customer name: generic. Keep; offer upstream.
- Removed the "Loyalty Program" cart button: follow-up: remove, replace with upstream's button behind a POS Profile or POS Role toggle. Upstream has no toggle today, so this is a hard-coded removal.
- `create_customer` address validation: generic. Keep.
- `create_customer` `mule_customer_kind` / `request_tax_exemption`: follow-up: remove. The UI no longer sends them (pilot delta). If needed later, replace with Customer Group and a Tax Category request on the desk.

**Pilot delta `4cd69c1`**
- Removes Mule UI (customer type, exemption request). Keep.

**fix/bep-repeat-pricing `9d9dbc8`**
- `selling_price` (ERPNext `get_price_list_rate_for`) in tiles, repeat and the price lock: generic. It replaces custom lookups with ERPNext's own. Keep; offer upstream.
- `_item_field_precision`: generic. Keep; offer upstream.
- `_mule_repeat_lines` (a past custom mix repeats as its mix Item): Mule-specific, and no config replaces it. Keep, behind the adapter.

**fix/mule-cart `c66504b`**
- Default Sales UOM on tiles, scans and cart: generic. It uses standard ERPNext Item config and replaces the demo's UOM handling. Keep; offer upstream.
- `create_invoice` / draft permission + register gate (`check_may_sell`), server-derived conversion factor: generic. Keep; offer upstream.
- Repeat skips lines with no Item: generic. Keep.

**Fork PR branches (browser-cache-controls, durable-invoice-retries, batch-catalog-stock)**
- Generic XPOS improvements with no Mule logic. Keep; offer upstream as PRs.
