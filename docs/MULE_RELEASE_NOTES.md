# Mule City XPOS release notes

## mule-v2.10.1-mc16 (2026-09-29): cashier initials at Pay (`feat/cashier-switching`, MuleCity-fb00.2)

Bill (2026-09-29): the register signs in as one shared "POS" user; every sale
and return records who rang it by the cashier's initials. Replaces the earlier
PIN / cashier-switching design.

- POS Profile: `xpos_require_cashier_initials` (off by default; off behaves
  exactly as before) and `xpos_cashiers`, a list of "XPOS Cashier" rows
  (`initials`, `cashier_name`).
- Pay asks for "Cashier initials", empty and focused on every sale, and shows
  the matched name; initials not on the list keep Pay disabled. Enter moves on
  to the amount. The initials go in the payload as `pos_cashier`, including a
  sale queued offline (the profile and its list are in the cached shift data).
- `create_invoice` refuses a sale or return without listed initials and stores
  them trimmed and uppercase on the new Sales Invoice (and POS Invoice) field
  `pos_cashier` (read-only, no-copy, a standard filter). A sale replayed from
  the offline queue is never refused: it is saved with what was typed and a
  comment on the invoice says the initials were missing or not listed.
- Receipts print the initials as "Cashier" when present (XPOS Thermal Receipt
  and the register's own receipt), else the user's name as before.
- POS Profile validate refuses the same initials twice (stored trimmed, uppercase).
- The Mule City bar drops its desk shortcuts (New order, Account payment, Prepare
  order, Edit in formula editor, Full formula library): the shared login only
  sells; account payments are Pay's Receive on Account (Bill, 2026-09-29).
- Offline e2e helper types the initials at Pay (`payWithEnter`); a timed-out wait
  prints what it last read.
- Gate: vitest 538, vue-tsc clean, fork CI green (run 36641103206); erp2 slot 4
  with Mule feat/cashier-accounts 3c7623ff natives RESULT PASS ran=216 (incl.
  xpos test_cashier_initials, test_made_to_order); offline mode RESULT PASS
  vitest 33/33, Cypress 3/3.
- Found, not fixed: an offline sale paid with change dead-letters on sync with
  "POS Change Leg Row #1: Value missing for: Currency".

## mule-v2.10.1-mc7 (2026-09-28)

- Customer lookup uses the active POS profile when called from the picker,
  preserving group restrictions and company sales context. Hosted acceptance
  caught the missing profile; a regression test now covers that call path.

## mule-v2.10.1-mc6 — customer recognition and recent purchases (2026-09-28)

Workstream: `feat/customer-recent-purchases`, based on `0d2042c` (mc5),
tracked in MuleCity-lt2x. Tagged release for the reproducible staging deployment.

- Recent purchases is directly below the selected customer; history includes
  item names, quantities and units. Replacing a nonempty cart asks first.
- Customer lookup searches linked Contact Phone rows with punctuation ignored
  (at least four digits). Browser cache retains linked numbers for offline lookup.
- Picker shows one familiar FilePro code, omits generic group/territory/address
  clutter, and shows recorded Mule customer kind when available.
- Phone and email values stay out of picker rows. Address/email/phone icons
  show on-file checks or missing-data minus marks, with accessible labels and
  a small legend. Linked active addresses and contact records supply the status.
  Unknown status in an older cache is not mislabeled missing.
- Customer since uses the historical Mule date when available, never the ERP
  import creation timestamp. Southern Woods is dated 2007-08-16.
- Company-scoped trailing-12-month net sales use submitted invoices, including
  returns, excluding consolidated Sales Invoices to avoid counting POS twice.
  Amounts exclude tax and use company currency; invoice read permission is required.
- Phone and sales reads are batched per result set, not per customer.
- Staging data check: all customer mobile fields were empty but linked Contact
  phones exist; all Mule customer-kind fields were blank. No inferred reseller,
  farmer or delivery labels were added. Southern Woods (2980) has 210 invoices;
  candidate history correctly returned its latest 20 with item details.
- Validation: 428 frontend tests, frontend typecheck/build, 3 focused backend
  unit tests, and read-only candidate queries against staging. Full backend
  suite and deployed browser acceptance remain release gates.

## Unreleased: ticket discount cap (`fix/discount-cap`)

Based on `mule-v2.10.1-mc5`. MuleCity-mxwy.2: for a POS Role without
`allow_change_price`, `create_invoice`/`preview_invoice` refuse a ticket whose
line discounts (percentage or amount) and additional discount (percentage or
amount) together take off more than the POS Profile's
`max_discount_percentage_allowed`, measured against each line's rate after
Pricing Rules (ERPNext's engine, as the cart runs it), so a Pricing Rule's own
discount, such as a custom-mix rate, is not a counter discount. Returns and
free items are left alone. Before, only a line's discount percentage was
checked. Also: the server's stock guard follows the profile's "Block sale
beyond available qty"; a stored 0 used to read as 1. Pairs with mulecity-full
`feat/counter-discount-cap` (the 25% cap, the counter's discount rights, and
blocking sales beyond stock on the Mule City profile).

## Unreleased: set tax exemption on the desk (`feat/tax-category-link`)

## Unreleased: `feat/tax-exempt-reason` (MuleCity-mxwy.28)

Built on `feat/tax-category-link` (`24301fc`, from mc5; not on the dropped
`feat/customer-type-picker`).

- From `feat/tax-category-link`: front desk sets a customer's tax exemption
  on the desk (mulecity-full `a473f290`; the Customer history records who).
  **Set tax exemption** on Edit Customer opens
  `/desk/customer/<name>#tax_category` in a new tab; Frappe scrolls the form
  to that field. Nothing is created at the counter (no Customer Tax Change
  Request).
- New Customer: an optional **Tax exemption reason** picker (None (taxable) /
  Farm / Reseller (resale certificate)) replaces that branch's "Set tax
  exemption" checkbox: the reason is saved with the customer, so no desk tab
  is needed. The choices come from the Customer field
  `mule_tax_exempt_reason` (boot `xpos_customer_tax_exempt_reasons`), only
  when the site has it and the user may write its permission level; elsewhere
  the picker is not shown.
- `create_customer` takes `mule_tax_exempt_reason`, checked against those
  choices, and inserts through the Customer's normal validation, where
  mulecity_erpnext sets the Tax Category from it. The unused
  `mule_customer_kind` / `request_tax_exemption` arguments are removed (the
  mc1 follow-up below).
- The Mule City bar shows "Tax exempt: <reason>" for the chosen customer
  (`tax_context`'s `tax_exempt_reason`; absent on older apps) and the same
  **Set tax exemption** link. Needs the frontend rebuilt at deploy and
  mulecity_erpnext with the field (`feat/tax-exempt-reason`).

## mule-v2.10.1-mc5 (2026-09-27)

mc4 plus the fixes from the Sunday staging rehearsal:

- `fix/shift-float-and-close` (`84f68ba`, `499589d`):
  - MuleCity-88ck: Open Shift saves the typed cash float (the client's
    `opening_amount` is mapped to the detail's `amount`, as
    `create_opening_shift` already did); the opening form lists payment methods
    in the POS Profile's order (Cash first for Mule City).
  - MuleCity-oygn: closing or summarising a shift with no linked invoices only
    falls back to unlinked, not-yet-closed invoices created after the shift
    opened, so an earlier closed shift's sales are never counted again.
  - MuleCity-u497: the Close Shift tax breakdown reads the server's `amount`.
    Needs the frontend rebuilt at deploy.
- `fix/customer-picker-codes` (`e7721b4`, `2de5294`), MuleCity-ilog:
  - Customer search also searches the Customer's standard search fields
    (Mule City puts the FilePro codes first), ranks an exact code first, and
    the picker shows the customer ID and those values under each name, as the
    desk does. Offline search matches the same values. Generic; upstreamable.
  - The Mule City panel shows each mix's last-made date and times made
    (sorted by mulecity_erpnext `find_mixes`, newest first), and "View recipe"
    scrolls the recipe into view.

Known follow-ups: MuleCity-rm58 (cancelling a closing clears the invoices'
closing link), the Close Shift "Total Taxes" card reads a field the server
never sends.

Verified: vitest 426/426, `vue-tsc` clean, `yarn build` OK; every
`xpos.api.tests` module passes on the pinned sidecar (ERPNext 16.36.0 /
Frappe 16.35.0). Needs mulecity_erpnext with the `find_mixes` ordering
(fix/ilog-customer-codes) for the mix dates.

## mule-v2.10.1-mc4 (2026-09-27)

mc3 plus: the Mule City panel (Customer Mixes / Orders for Pickup) shows the
buyer's name instead of the Customer ID ("MC-CUST-3820"); the ID stays as the
hover text. Verified: vitest 420/420, `vue-tsc` clean, `yarn build` OK.

## mule-v2.10.1-mc3 (2026-09-27)

mc2 plus these changes (Bill, 2026-09-27):

- `b53d2d0` high-contrast theme, closer to the VT100 terminal the counter is
  used to (not full xterm): a near-black dark theme with a green accent,
  stronger borders and focus rings, and darker muted text in light. Dark is the
  default for new browsers; a browser that already opened XPOS keeps its saved
  theme until someone clicks the Theme toggle. Colour tokens in `style.css` plus
  a few hard-coded colours on the sale screen, cart and payment dialog.
  Generic; could go upstream as an option.
- The Purchasing menu (Purchase Order, Purchase Invoice, Stock Receiving) shows
  only when the POS Profile allows purchase orders / receipts, and those routes
  plus Expenses and Bank Drops send you back to the POS when the profile
  doesn't allow them (keyboard shortcuts and typed URLs included). Generic;
  upstreamable.

Verified: vitest 420/420, `vue-tsc` clean, `yarn build` OK. No server code
changed since mc2.

## mule-v2.10.1-mc2 (2026-09-27)

mc1 plus these changes:

- `fix/mule-grain` (`92bfea9`: `60e03e1`, `87b2d3e`, `f054c05`, `92bfea9`):
  - Before payment, the register asks the server for a preview
    (`preview_invoice` -> `mulecity_erpnext.pos_workspace.preview_cart`) and
    charges what the preview shows. A grain depositor pays only for Mule's
    grain, by card or by cash (parity gap 02 closed).
  - The preview is gated like a sale (`check_may_sell`). The sale is held to
    the total the register showed; a stale preview is refused, never short- or
    over-paid.
- `6b7f14f`: test-only. XPOS unit tests stub the site tax adapter, because
  mulecity_erpnext now copies a return's original taxes.
- It requires mulecity_erpnext main at `fefc35f4` or later, which has
  `preview_cart`, returns that copy their taxes, the counter settings seed and
  the FBR field fixture.

Verified on `6b7f14f`. Bench `f9xpos` has mulecity-full `fefc35f4`, migrated.
- Frontend: vitest 420/420, `vue-tsc` clean, and `yarn build` OK.
- xpos: 272/272 unit tests and 6/6 integration tests pass.
- Grain probes: 16/16 pass.
- Main parity probes: 24 of 31 pass. The open gaps are 04b and 10. The old
  test_02 simulates the cart before the preview existed, and g02 replaces it.
- Probe maintenance: the other failures are harness drift, not XPOS code.
  - 05, 05c and 05e: host main now seeds `hide_unavailable_items=1` and item
    groups = Mule City Counter. That hides the probe's fixture items; with
    those settings off, all three pass.
  - 07a: it calls a host test helper that was renamed (`_imported_formula` ->
    `_replayed_formula`).
- mulecity_erpnext full native suite (`--skip-before-tests`, with xpos
  installed): 635/635 unit, 20/20 integration and 5/5 other, with 0 failures.

Follow-ups carried from mc1: the P2 shift and rights gates, and the P2
Electron offline tile UOM.

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
- `create_customer` `mule_customer_kind` / `request_tax_exemption`: follow-up: remove. The UI no longer sends them (pilot delta). If needed later, replace with Customer Group and a Tax Category request on the desk. Removed in `feat/tax-exempt-reason` (replaced by `mule_tax_exempt_reason`).

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
