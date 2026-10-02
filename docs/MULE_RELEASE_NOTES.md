# Mule City XPOS release notes

## mule-v2.10.1-mc26 (unreleased)

### The cart's mix check places nothing (MuleCity-ynb9)

The cart's ingredient check (debounced 600 ms on every cart change) called the
Mule app's `counter_mix_orders.counter_quote`, which places the Sales Order, its
Work Order and Stock Reservation Entries in a savepoint and rolls them back: Bin
row locks and a full order on every change. It now calls the app's read-only
`counter_mix_orders.counter_check`, same answer and shape (`orders`,
`orders_total`, `ticket`, `ticket_due`, or the "Short ingredients" refusal).
Pay still asks `counter_quote`, and `counter_checkout` places the order.

- `cartStore.checkMixOrders` asks `counter_check`; `openMixOrderPayment` is
  unchanged. Needs a Mule app with `counter_check` (MuleCity-ynb9).
- vitest: `tillCustomMixes.spec.ts` checks the cart asks `counter_check` and
  never `counter_quote`, and Pay still asks `counter_quote`.

## mule-v2.10.1-mc25 (unreleased)

### Close Shift counts the till's Payment Entries (MuleCity-49ue)

On the mc24 staging walk (2026-10-02) a custom mix order paid now in cash
(advance Payment Entry ACC-PAY-05006, $0.28) was not in the shift's expected
cash, so the drawer was over. The pickup ticket later uses the advance and takes
no cash, so that money was never expected in any shift. Payments on account and
settled tickets (also Payment Entries) were missing from the till's close the
same way.

- A Payment Entry taken at the till carries its POS Opening Shift in
  `reference_no`, the tag `receive_on_account` and `settle_outstanding_invoice`
  already set and the desk closing (`closing_processing.data.get_payments_entries`)
  already reads. The Mule app's mix-order prepayment now sets it too (it used
  the cart id; the cart id stays on the Sales Order and in the remarks).
- `xpos.api.shifts.get_shift_till_payments(shift)`: submitted Payment Entries
  with `reference_no` = the shift, Receive counted in, Pay counted out, in the
  cash account's currency. `get_shift_expected_amounts` adds them, so the close
  sheet's Expected and the saved POS Closing Shift's `payment_reconciliation`
  include them; `close_shift` also lists them in the closing's `pos_payments`.
- No double counting: the pickup ticket's advance is in its `advances` table,
  not a payment row, so the later shift expects only the cash that ticket took.
- New custom field `Payment Entry.pos_cashier` (Cashier). The helper
  `xpos.api.payments.stamp_till_payment(pe, pos_profile, shift, initials)` sets
  the shift tag and the cashier the invoice way (`apply_pos_cashier`); the Mule
  app's prepayment passes the initials typed at Pay. `receive_on_account` and
  `settle_outstanding_invoice` take an optional `pos_cashier`; their dialogs
  don't ask yet, so on the shared login those payments count under "(none)".
- `get_shift_summary` returns `till_payments` (`{mode: {count, amount,
  currency}}`) and `by_cashier` rows gain `payments_count`/`payments_total`.
  `payment_summary` stays the invoice payment rows only.
- Close Shift shows "Payments received" (mode, count, amount) and, when there
  are any, Payments and Payments Total columns in By Cashier.
- Tests: `xpos/api/tests/test_shifts.py` (`TestTillPaymentsInTheShift`),
  `frontend/tests/closingTillPayments.spec.ts`; Mule app
  `test_counter_mix_orders` (prepay in one shift, pickup in a later shift and in
  the same shift) and `test_xpos_counter_settings` (payment on account).

## mule-v2.10.1-mc24 (unreleased)

### Close Shift waits for offline sales (MuleCity-86ea)

On staging (2026-10-01) a queued sale was refused at sync ("1 need attention")
and Close Shift closed anyway, so that sale's cash was not in the closing.

- `ClosingDialog.vue` reads this browser's offline queue when it opens and again
  on Close Shift (`frontend/src/utils/closeShiftGuard.ts`). Every Close Shift
  entry point (navbar, menu, Ctrl+Shift+O) opens this dialog.
- Counted: every queued sale for this till's POS Profile, from any shift (a
  stuck sale from an earlier shift is still missing money). Held drafts and
  another profile's sales are not counted.
- Waiting sales (pending, syncing, failed and retrying): when online the dialog
  syncs them first; when offline it says to reconnect (closing is online-only).
- Sales that need attention (refused or out of retries): a red list with the
  customer, amount and error, and "Open offline invoices" to fix (Requeue) or,
  where the profile allows deleting offline invoices, remove them.
- Close Shift stays disabled while either list is not empty. There is no
  "close anyway": the profile's existing `allow_delete_offline_invoice` is the
  manager's way out.
- Tests: `frontend/tests/closeShiftQueue.spec.ts`.

### Batch picker reads Serial and Batch Bundle stock (MuleCity-86ea)

- `xpos.api.items._get_batch_data` summed `Stock Ledger Entry.batch_no`, which
  is empty when stock moves through a Serial and Batch Bundle (ERPNext v15+), so
  `get_item_detail` returned `batches: []` for a lot with 20 on the shelf. It now
  uses ERPNext's `get_batch_qty(item_code, warehouse, for_stock_levels=True)`,
  which reads bundle entries and legacy `sle.batch_no` rows together, in the
  Stock Settings pick order. `for_stock_levels` avoids taking unconsolidated POS
  Invoice qty off twice (`get_pending_batch_qty` already does). Expired and
  sold-out lots are still left out.
- The picker shows "Made: <date>" when a lot has no expiry
  (`manufacturing_date` on each `get_item_detail` batch row).
- The shared cashier login (Mule POS Cashier + Desk User) gets the same list:
  the helper's queries and `frappe.get_all` on Batch need no read permission.
- A chosen lot travels as `batch_no` on the invoice row; ERPNext turns it into
  the outward bundle.
- Tests: `xpos.api.tests.test_batch_picker`.

### Custom mixes can be ordered from the item list (MuleCity-zstm.20)

mc23 staging walk (2026-10-02): every custom mix showed "Out of Stock $0.00"
and could not be put in the cart; the walk's mix orders were placed from the
bench. Bill (2026-09-30): a mix is ordered at the till (pickup or delivery, on
account or paid there), and the till shows whether its ingredients are there
before ordering. **Needs the Mule app's `xpos_list_rate` hook and its Stock
Reservation Entry grant for the till login (MuleCity-zstm.20 app commits);**
with an older app a mix still lists as made to order but shows "No price" and
can't be added. No migrate needed for XPOS.

- Item card, list row and search: a made-to-order item (`is_made_to_order`,
  from the site's `xpos_made_to_order_items` hook since mc13) is never "Out of
  Stock" and can be tapped; with nothing made its badge reads "Made to order".
  The cart already let it in (`checkAvailability`); the tiles didn't.
- New site hook `xpos_list_rate` (`xpos.api.items.LIST_RATE_HOOK`): callables
  `(item_code, price_list, uom, conversion_factor, customer, transaction_date,
  qty)` returning a list rate or None. `selling_price` asks it first, so the
  item list, `get_sale_unit` (unit change), the barcode/detail lookups, the
  invoice price lock and Repeat all price a mix the same way. Mule City answers
  with the mix's recipe price (`mix_price.bom_list_rate`, the base its Sales
  Order gets). None keeps ERPNext's Item Price lookup.
- `get_pos_items`: an item whose price raises (a mix whose recipe needs review)
  is listed at rate 0 with `price_error` (the reason), and the rest of the page
  still loads. The tile shows "No price" with the reason on hover, never $0.00.
- Cart (`cartStore.addItem`, `addItemWithDetails`): a made-to-order item with no
  price is refused with the reason. Offline, a mix is refused unless it is made
  bags on hand at a price the till already has ("Custom mixes can't be ordered
  offline..."); orders stay online-only, as before.
- Cart: with a mix to order and a pickup date, the cart asks the site's
  `counter_mix_orders.counter_quote` (debounced, the same check Pay makes) and
  shows "Ingredients on hand. Mix order $X." or the site's refusal, e.g. "Can't
  order yet: Short ingredients: ..." (MuleCity-mxwy.16). Pay still asks again;
  it is the gate. No override at the till.
- Tests: `frontend/tests/tillCustomMixes.spec.ts`,
  `xpos.api.tests.test_made_to_order` (TestSitePricedItems), Mule
  `test_till_custom_mixes` (as the till's own login).
- Touched in `xpos/api/items.py`: `selling_price` and the pricing loop of
  `get_pos_items` only (plus the `LIST_RATE_HOOK` constant).

## mule-v2.10.1-mc23 (2026-10-02, staging)

Bill's counter review of 2026-10-01 (epic MuleCity-qajl). **Migrate needed**
(new custom fields on Sales Invoice and POS Invoice, and `pos_notes`,
`pos_delivery_miles` and `pos_delivery_miles_source` on the Sales Order header). Needs the Mule app's
`xpos_delivery_customers` change (address title, line 2, state, ZIP and the
primary/shipping flags); with an older app the picker still works but has
nothing to preselect or search by beyond street and town.

### Offline cache of addresses, contacts and miles (MuleCity-qajl.4)

Bill: "we should cache addresses and contact info for customers so offline can
still do shipping!"

- Each cached customer row carries its delivery addresses in full (`xpos_delivery.
  addresses[]`: name, title, both street lines, town, state, ZIP, miles,
  miles source, `is_primary_address`, `is_shipping_address`) and its contacts
  (`xpos_contacts[]`: name, full name, phones, emails, `is_primary_contact`;
  `xpos.api.customers._customer_contacts`, three batched queries). They refresh
  with the customer cache: at till open and on every sync, as the tax contexts do.
- The cache panel lists "Addresses" (how many, when refreshed; it fails when the
  customers or the delivery policy could not be fetched).
- Electron: the `customers` table keeps every key the browser keeps, in one JSON
  column `xpos_row` (schema.sql and a startup migration). Before, the extra keys
  (`xpos_delivery`, `xpos_has_*`, ...) failed the insert, so an Electron till's
  customer cache was not filled by the preload (the 6nb1 gap).
- Tests: `frontend/tests/offlineAddressCache.spec.ts`,
  `xpos.api.tests.test_customers` (TestCachedContacts), Mule
  `test_xpos_delivery`.

### Delivery facts stored on the sale (MuleCity-qajl contract)

- New fields on Sales Invoice and POS Invoice: `pos_delivery_miles` (Float) and
  `pos_delivery_miles_source` (Select: `address` | `manual`). **Migrate needed.**
- `create_invoice` and `save_draft_invoice` store, through `apply_delivery_facts`:
  the standard `shipping_address_name` with its `shipping_address` display
  (ERPNext's `get_address_display`), the day (`pos_delivery_date`; the draft path
  did not save it before) and the miles with their source. They ride in the
  sale's data, so an offline sale keeps them through the queue. A parked tab
  returns them (`get_invoice_details`).
- The offline receipt snapshot (`ReceiptSnapshot.delivery`: address name, full
  address, miles, miles source, day) is filled for a delivery sale. Printing it
  is the prints lane's (qajl.5); `receiptTemplate.ts` is unchanged.

### Customer card (MuleCity-qajl.2)

- Recent purchases is gone (Repeat in the top bar does it). Credit limit stays.
- Add delivery is its own button on a line below the account row. Once added,
  the line shows where it goes, its miles and the day, which can be changed
  there. Who sees it: see "The delivery address rule" below (it replaced "only
  when the customer has an address").

### The delivery address rule (Bill 2026-10-01 22:52, MuleCity-qajl.2/.3)

Bill: a delivery always needs a real customer; use the customer's one address,
else their one shipping address, else pick from the list, or add a new address
right at the till. **Needs the Mule app's `address_lookup.py`**
(`xpos_add_delivery_address`, `xpos_walk_in_customers` hooks) and its
`address_type` on cached addresses; without them the walk-in list is the POS
Profiles' default customers only and adding an address is refused.

- **No delivery for walk-ins.** `xpos.api.delivery.walk_in_customers()` = every
  POS Profile's default customer plus the site's `xpos_walk_in_customers` hook
  (Mule City: Walk-In Customer and FilePro's CASH 338). It rides on the cached
  delivery policy (`walk_in_customers`), so the till hides Add delivery for them
  online and offline. The server refuses (`refuse_walk_in_delivery`, called by
  `apply_delivery_facts` and `resolve_new_shipping_address`) a sale, parked tab
  or preview to a walk-in or no customer that carries a shipping address, an
  address typed offline, delivery miles or the site's delivery line: "Delivery
  needs a named customer, not ...". A day alone is not a delivery. Returns pass
  (a FilePro-era 338 sale with a DEL line can still be returned).
- **Who sees the button:** any named, non-walk-in customer on a sale (not a
  return) when the site quotes delivery, online or offline, address or not.
- **Which address:** the only address; else the only Shipping-type address
  (`address_type`; `is_shipping_address` is Frappe's single *preferred* shipping
  flag, so it cannot say "one shipping address"); quoted and added at once when
  it has a price. Otherwise the picker (primary shipping preselected). "Change
  delivery" always opens the picker.
- **Add new address**, always in the picker; with no addresses the button opens
  it directly: street, line 2, city, state (NC by default), ZIP, optional name and
  miles. Online `xpos.api.customers.add_delivery_address` (thin wrapper on the
  site hook) makes a Shipping Address of the customer, or returns the one with the
  same lines, looks up Google's miles and answers with the cached address shape,
  `address_display`, `miles_pending`, `latitude`/`longitude` with
  `geolocation_pending` (coordinates are None until MuleCity-gvxs adds the
  Address fields; cached addresses carry them too, nothing geocodes) and a
  quote; when Google finds no miles the
  form asks for typed miles (kept on the Address as `manual`, flagged for review)
  or the clerk types the charge. The new address goes on the customer's cached
  row at once.
- **Offline:** the add is queued (`services/addressQueue.ts`, sync meta, browser
  and Electron) under a `LOCAL-ADDR-` id that the cart uses as the address name.
  At sync the queue is replayed first, with typed miles as `manual_offline`; the
  local id -> Address pair goes to the sync id map, and each queued sale's local
  id is swapped for the real name before it is sent. A sale still carries the
  whole address (`xpos_new_shipping_address` with state, ZIP and `local_id`), so
  if the replay did not run (the Electron sync engine pushes sales on its own),
  `resolve_new_shipping_address` makes it through the same site hook: one
  Address either way. An add the site refuses is kept and listed in the sync
  errors, not retried.
- Tests: `frontend/tests/delivery.spec.ts` ("Bill's address rule"),
  `frontend/tests/addressQueue.spec.ts` (replay order, refusal, network drop),
  `xpos.api.tests.test_delivery` (TestNoDeliveryForWalkIns,
  TestAddADeliveryAddressAtTheTill), Mule `test_address_lookup` and
  `test_xpos_delivery`, bench stories in `tests/e2e/bench/offline-delivery.cy.ts`
  (no-address customer adds one offline and syncs; walk-in sees no Add delivery).

### Add delivery picker and the delivery day (MuleCity-qajl.3)

Bill: "if they have multiple addresses, it pops up the addresses with the
primary shipping address as default, but can select others. and can search. it
should show miles and cost." / the clerk picks the delivery day at the POS.

- One address with a price (miles, standing charge or free): quoted and added at
  once, as before. Several, one with no miles, or offline: the picker opens on
  the primary shipping address (else shipping, else primary, else the first),
  with a search box (street, line 2, town, name, ZIP) and each row's miles (or
  "no miles") and cost. Row costs are the till's own quote from the cached
  policy (`quoteOffline`); the chosen row is quoted by the site online, as before.
  A standing charge or free delivery shows on every row.
- An address with no miles: the clerk types its one-way miles; they are priced by
  the policy, the line says "miles typed at the till", and the sale keeps
  `pos_delivery_miles_source = manual` (the site adds its review Comment, as for
  miles typed offline). Leaving the miles empty still lets the clerk type the
  charge. The typed miles are not written back to the Address.
- Delivery day: a date in the picker (default the day already chosen, else
  today), changeable on the card. It is the sale's `pos_delivery_date`; with a
  counter order in the cart it also sets the mix pickup date, which the Mule app
  uses as the Sales Order's `delivery_date`.
- Removing the delivery line drops the delivery (address, miles, day facts) from
  the sale.
- Offline it behaves the same from the cache. One address with a price is now
  added at once offline too (the rule above); the add-address form is in the
  picker online and offline.
- Tests: `frontend/tests/delivery.spec.ts` (picker stories online and offline),
  `xpos.api.tests.test_delivery`, bench story in
  `tests/e2e/bench/offline-delivery.cy.ts` (three addresses, primary shipping
  preselected, search, a no-miles row priced from typed miles, synced sale keeps
  address, day and miles).

### Clear the customer and basket (MuleCity-zstm.22)

Bill: "on xpos, in staging, STILL no way to clear out the current customer."

- A control beside the customer's name (`ClearCustomer.vue`, `data-testid=
  "clear-customer"`) clears the customer, every line, discounts and delivery,
  and puts back the profile's default (walk-in) customer (`cartStore.clearAll`;
  the walk-in row comes from the till's cache, else the server). It asks first
  when the basket has lines; with only a customer it clears at once. Disabled for
  walk-in with an empty basket; hidden in return mode (the return banner has its
  own exit). Pure client state: works offline. The trash button is unchanged
  (basket only, customer kept).
- Tests: `frontend/tests/clearCustomer.spec.ts`.

### Orders in flight and the indicator at the customer's name (MuleCity-zstm.23, mxwy.10)

Bill: the top-bar Orders defaults to the selected customer's orders, still
searchable; no customer = every order in flight; a clear indicator next to the
customer's name when they have orders in flight or ready for pickup.

- **Needs the Mule app's `pos_workspace.find_orders` change** (customer optional,
  `limit`, `readiness`/`progress` per row; app branch `feat/qajl-orders`). It
  still returns a list, so mc22 keeps working against the new app; with an older
  app this release lists orders without readiness.
- `/orders` opens two tabs: **Orders in flight** (default) and **Sales history**
  (the old Orders view, reprint unchanged; `?tab=history`). In flight = submitted
  Sales Orders, not Closed/Completed, `per_billed < 100`: what the till's pickup
  closes (`pickup_invoice` refuses a fully billed order; its invoice updates
  stock, so one pickup bills and delivers). Scope: the cart's customer (walk-in =
  everyone), or `?customer=`; "Show all orders" / "Only <customer>" switch it.
  Each row says how far along it is (Ready for pickup / With the mill / Partly
  picked up / Waiting, from the order's Work Orders); ready rows stand out.
- **Delivered orders are not pickups** (MuleCity-x4kb, the till never moves
  stock twice): an order with goods on a submitted Delivery Note (all or part)
  is listed as "Delivered — not billed" (`readiness: delivered`, its notes named),
  Load for payment is disabled with "Already delivered on <DN>; bill it from the
  Delivery Note at the desk", and the indicator never counts it as ready. The
  Mule app's `pickup_invoice` refuses it too.
- **Load for payment** does what the Mule City dialog did: `pickup_invoice` (the
  delivery-to-pickup notice, fxh advances), `cartStore.loadFromInvoice`, back to
  the till. It needs an empty basket and the internet.
- The indicator (`CustomerOrdersBadge.vue`) sits after the customer's name: a
  quiet "N orders" when they have orders in flight, a green "N ready" when any is
  ready. Click opens their orders. Walk-in or none: nothing.
- Offline: every unsearched list is kept in the sync-meta store
  (`open_orders::<profile>::<customer|*>`, the way the tax contexts are), and the
  background sync refreshes the everyone list. Offline, the view and the
  indicator show that last known list with its time, searched on the till (a
  customer never fetched alone is read from a complete everyone list); with
  nothing kept the view says it does not know and the indicator shows nothing.
  Never "no orders" it does not know.
- Tests: `frontend/tests/openOrders.spec.ts`, bench story
  `tests/e2e/bench/offline-orders.cy.ts`; Mule `test_find_orders`.

### Screen cleanup (MuleCity-qajl.1)

Bill: "we don't need Cart" / "we don't need this line anymore: Mule City,
Customer Mixes, Orders for Pickup, Practice site" / a red Practice site banner
lower left / "online and in sync can be combined into one thing" / "we don't
need Main - MCSF!" / "we do need the initials of the current user where the
profile is."

- No "Cart" heading: the customer button has the line.
- The Mule City row is gone. Its dialog stays (`MuleWorkspace.vue`): `open('mixes')`
  and `open('orders')` are exposed and answer the window event
  `xpos:open-mule-workspace` (`{detail: {mode}}`). Customer Mixes opens from a
  **Mixes** button on the customer card; open orders come through the Orders view.
- **Practice site**: a fixed red banner lower left (`PracticeSiteBanner.vue` in
  `DefaultLayout.vue`, browser and Electron), only when
  `boot.mule_practice_site` is true. Never on production.
- **One status control** (`CacheSyncStatus.vue`, `utils/statusSummary.ts`): one
  label for connection, pending sales and the offline cache ("Online · in sync",
  "Offline · 1 pending · saved data", "Online · 2 pending · check data sync");
  the cache detail, Refresh now and Pending sales sit behind it. Shown with
  offline mode or pending sales, as before.
- The warehouse badge ("Main - MCSF") is gone.
- The avatar shows initials. A named login: its own (`initialsOf(userFullName)`).
  The shared register login (1p4i): the initials last accepted at Pay this
  session (`posStore.lastCashierInitials`, in memory, set when Pay submits), a
  neutral mark before the first sale. Pay still asks every sale.
- Electron `MenuBar.vue` is unchanged (it never had the warehouse, avatar or
  sync label).
- Tests: `statusSummary.spec.ts`, `cashierInitials.spec.ts` (initials),
  `muleWorkspace*.spec.ts` (banner, dialog by event).

### Delivery on the offline receipt (MuleCity-qajl.5, XPOS half)

Bill: "delivery should both be a line item on the printed receipt, but also a
section on the receipt."

- `buildReceiptHtml` prints a Delivery section after the customer, from the
  snapshot's `delivery`: the address ("Address not recorded" when none), then
  "Miles: 12 mi · Day: Monday, October 5, 2026". Miles read "12 mi", "12 mi,
  typed" (miles the clerk typed) or "miles not known"; the day is the prints'
  long style, read as a local date. Same wording as the Mule City Ticket's
  section (Mule app `print_delivery`), so offline and online prints match.
- The DEL line still prints with the items. A pickup sale (no `delivery` on the
  snapshot, including snapshots queued by an older till) prints no section.
- The receipt note keeps its line breaks.
- New custom fields `pos_delivery_miles` (Float) and `pos_delivery_miles_source`
  (Select: `address` | `manual`) on the **Sales Order header**, defined as on
  Sales Invoice (read-only, `no_copy`), after `delivery_date`. **Migrate
  needed.** The till does not fill them; the Mule app writes the miles at order
  time on counter orders for the order slip and Work Order.
- A delivery priced by a standing charge or a no-charge exception still keeps the
  address's miles on the sale (`pos_delivery_miles`, source `address`) whenever
  the address has miles: the quote carries them and `apply_delivery_facts`
  stores what the cart sends. Pinned in `frontend/tests/delivery.spec.ts`.
- Tests: `frontend/tests/receiptTemplate.spec.ts` ("the Delivery section").

### Cashier initials on returns, and the close sheet by cashier (MuleCity-qajl.6)

Bill: "we should do initials for returns as well."

- Returns already asked (mc22, confirmed on staging 2026-10-01: ACC-SINV-49748,
  `pos_cashier` BI). New vitest cases pin it: a return on the shared login is
  blocked until the initials are on the list, and sends `is_return`,
  `pos_cashier` and its note, online and queued offline
  (`frontend/tests/cashierInitials.spec.ts`).
- `get_shift_summary` reads `pos_cashier` and returns `by_cashier`: one row per
  initials (sales count and total, returns count and total; ERPNext's
  `grand_total`, so return totals are negative), sorted by initials, then a
  "(none)" row for invoices saved without initials (a named login). The Close
  Shift sheet shows it as a "By Cashier" table under Returns (return totals as
  positive amounts). Closing is online only. An older server without
  `by_cashier` shows no table.
- Tests: `xpos.api.tests.test_shifts` (TestCloseSheetByCashier),
  `frontend/tests/closingByCashier.spec.ts`.

### Notes on sales, orders and returns (MuleCity-qajl.7)

Bill: "we should be able to add notes to sales, orders, and returns as well."

- New custom field `pos_notes` (Small Text, "POS Notes", after `delivery_date`,
  editable after submit) on the **Sales Order header**. **Migrate needed.**
  Same fieldname as Sales Invoice / POS Invoice and never `no_copy`, so ERPNext's
  `make_sales_invoice` carries an order's note onto its pickup invoice.
- The cart's note box (POS Profile `display_additional_notes`, turned on by the
  Mule app's v9 seed) shows in return mode too. The note goes as `pos_notes` with
  a sale, a return (its own note; the sold invoice's note is not copied) and a
  counter order (the Mule app's `counter_checkout` puts it on each Sales Order's
  header); XPOS's own `create_sales_order` saves it on the header too.
- An order loaded for pickup (`loadFromInvoice`) brings its note into the box.
- The note is trimmed; a blank note is not sent and the receipt prints nothing.
  It rides in the invoice data, so an offline sale or return keeps it through
  the queue, and the offline receipt prints it.
- Tests: `frontend/tests/notes.spec.ts`, `xpos.api.tests.test_order_notes`,
  Mule `test_counter_mix_orders` (the order's note and its slip).

### /xpos is never website-cached (MuleCity-urx9, P0 security)

- `xpos/www/xpos.py` sets `no_cache = 1` (and `sitemap = 0`). The page renders
  `window.xpos.boot` and the session CSRF token, and Frappe's website cache
  (keyed by path, shared by every visitor, 30 min) served one visitor's copy to
  everyone: a cached logged-out copy broke login with CSRFTokenError, and a
  cached logged-in copy leaked that user's boot and token. Both route rules
  (`/xpos`, `/xpos/<path>`) render this one page; there are no other XPOS www
  pages. The fix does not depend on the site's `disable_website_cache` (the
  2026-10-02 mitigation on staging and prod, which can be removed after
  deploying this).
- Tests: `xpos.api.tests.test_csrf_token` (TestXposPageIsNeverWebsiteCached:
  the module flags, the routes, and Frappe's `TemplatePage` reading `no_cache`
  so `can_cache()` refuses the page).

### Offline database open can no longer hang the till (MuleCity-pg10)

Bill's Safari stopped after loading tax_context and never asked for items:
opening the offline IndexedDB (`xpos_offline_v3`) waited forever.

- `XPosDB.open()` (also Dexie's implicit auto-open behind every table access)
  gives up when the open is blocked (another tab or window holds an older
  version and does not let go) or takes longer than `DB_OPEN_TIMEOUT_MS`
  (8 s). It rejects with `OfflineDbUnavailableError` (`reason`: `blocked` |
  `timeout`, `userMessage`) and closes the database with auto-open off, so every
  later offline-data call fails at once instead of queueing behind the stuck
  open. The till does not retry on its own, and never deletes the database in
  that state (the old "reset on open error" path could delete and block too;
  its delete is now under the same timeout).
- The till carries on online: `posStore.useOfflineMode` is off while the
  database is unavailable, and a 30 s error toast tells the cashier what to do:
  blocked: "Offline data is locked by another X POS tab or window. Close the
  other X POS tabs, then reload this page. The till keeps working online;
  offline sales are off until then." Timeout: the same advice, plus "if it
  keeps happening, clear this site's data in the browser settings (offline
  sales not yet synced from this device would be lost)". Clear Cached Data
  (Ctrl+Shift+R) needs the database open, so it is not offered there.
- `versionchange`: Dexie already closes the connection so another tab can
  upgrade (its default handler); unchanged.
- Tests: `frontend/tests/offlineDbOpen.spec.ts` (fake-indexeddb, new dev
  dependency: a blocking older-version connection, a never-answering open, the
  implicit open, `useOfflineMode`).

## mule-v2.10.1-mc22

### Named logins (MuleCity-1p4i): initials only on a shared login

Bill (2026-09-30): owners and front desk also sell at the register under their
own logins; only the shared counter login is asked for initials.

- POS Profile User: `xpos_shared_login` ("Shared Login", off by default). Migrate needed.
- The initials rule is now: the profile's `xpos_require_cashier_initials` AND the
  signed-in user's row is a Shared Login. Pay shows the box only then
  (`initialsRequiredFor`, the posStore's `requireCashierInitials`; PaymentDialog
  unchanged). `apply_pos_cashier` refuses a shared login's sale without listed
  initials as before; anyone else's sale is saved with `pos_cashier` = their
  full name, whatever was typed. Profile flag off: unchanged (nothing set).
- A profile that requires initials but marks no row as shared asks nobody.
- Tests: `xpos.api.tests.test_cashier_initials`, `frontend/tests/cashierInitials.spec.ts`.

### Customer Mixes labels (MuleCity-c6dp): Customer Mixes say what the evidence is

- Each mix is named by the `display_name` and `owner_name` that `find_mixes`
  already returns ("CORN, OATS, SOYBEAN MEAL" / "Recipe of ALBERT ADKINS"), not
  its generated "Formula A846D90316" title or the owner-search text; the
  product's own name stays on hover and in search.
- "Last made … · made N times" becomes "Last ordered … · ordered N times": the
  recall index counts orders and sales, not batches. The latest submitted
  invoice shows as "Last bought <date> by <buyer> · <bags / lb> · <amount>".
  Nothing says "made" until the server supplies manufacture records.
- The empty mix search no longer points to the removed formula library; the
  cart says "Credit limit" instead of "Limit"; the product list's info button
  has an accessible label.

## Native formula entry candidate (2026-09-29; not released)

Workstream: `codex/native-formula-entry`, reconciled with mc20 `fe403000`.
MuleCity-jr36.11 and MuleCity-phjf track integration.

- Preserve mc19 shared-register restrictions: no formula editor or Desk
  shortcuts. Formula creation remains in the native Desk workflow.
- Cart rows preserve Sales Order, source row, BOM and literal mill instructions.
  Distinct order rows or instructions stay separate. Retired quote fields are
  dropped from invoice transport.
- Pickup prices use b3's MuleCity-jfdy `9f53a07` (local cherry-pick `edc26d4`).
  The same source row supplies mill instructions, overriding cart edits.
  This candidate adds no second order-price or ingredient-price engine.
- Prior candidate validation: 511 frontend tests, typecheck, build and 41 backend
  adapter tests passed before mc19 reconciliation. After reconciliation, all
  566 frontend tests, typecheck and build pass with Node 24.8.0. The same
  gates passed again after the mc20 merge on 2026-09-30.
  Native backend, installed browser and combined app integration remain release
  gates; ATC runs erp2 tests on assigned slot 6 under MuleCity-2ea0.
  Feature branch publication is authorized; ATC owns tags, platform pins,
  main/staging integration and deployment.

## mule-v2.10.1-mc20 (2026-09-29): cash sales with change post (MuleCity-ztb9)

- A cash sale paid with change posts again, online and offline. Every such sale
  was refused with "POS Change Leg Row #1: Value missing for: Currency": the
  change row's Currency fetched the Mode of Payment's tender currency on save,
  and Mule City's Cash has none, so it blanked the currency the server set.
  The field now fetches only when empty (`fetch_if_empty`), so migrate is needed.
- Queued sales were in the right shape and need no change. Offline sales that
  already went to "need attention" are not retried by reconnecting; retry them
  from the pending list once this is deployed.
- Tests: `xpos.api.tests.test_change_legs` (fork) and an offline e2e story
  paying $50 cash for one bag in `tests/e2e/bench/offline-selling.cy.ts`.

## mule-v2.10.1-mc19 (2026-09-29): cashier initials at Pay (`feat/cashier-switching`, MuleCity-fb00.2)

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
- Gate (on mc18, 9839236): vitest 561, vue-tsc clean, fork CI green (run
  36645218348); erp2 slot 4 with Mule feat/cashier-accounts 426ee812: natives
  RESULT PASS ran=405 failures=0 skipped=1 (incl. xpos test_cashier_initials,
  test_invoices, test_pricing_rules, test_discount_cap, test_printing,
  test_made_to_order); offline RESULT PASS vitest 33/33, Cypress 3/3.
- Found, fixed separately (MuleCity-ztb9, fix/offline-change-legs): an offline sale paid with change dead-letters on sync with
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
