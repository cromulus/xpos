<template>
  <nav class="mule-counter-tools" aria-label="Mule City customer work">
    <strong>Mule City</strong>
    <button type="button" @click="open('mixes')">Customer Mixes</button>
    <button type="button" @click="open('orders')">Orders for Pickup<span v-if="customerOrders.length"> ({{ customerOrders.length }} open)</span></button>
    <span v-if="ordersLoading" role="status">Checking customer orders…</span>
    <button v-else-if="ordersError" type="button" @click="refreshOrders">Could not check orders — retry</button>
    <button v-else-if="customerOrders.length" type="button" class="mule-order-alert" @click="open('orders')">{{ customerName || 'This customer' }}: {{ customerOrders.length }} open order(s) · {{ completedOrders ? completedOrders + ' production complete' : customerOrders[0].progress }}</button>
    <a :href="'/desk/sales-order/new?customer=' + encodeURIComponent(customer || '')" target="_blank">New order</a>
    <a href="/desk/payment-entry/new" target="_blank">Account payment</a>
    <small>Practice site</small>
  </nav>
  <Teleport to="body">
    <dialog ref="dialog" class="mule-workspace" @close="mode = ''">
      <header><div><h2>{{ mode === 'mixes' ? 'Customer mixes' : 'Orders for pickup' }}</h2>
        <p>Buyer: <strong :title="customer || undefined">{{ customerName || customer || 'Choose a customer at the register' }}</strong></p></div>
        <button type="button" aria-label="Close customer work" @click="dialog.close()">Close</button></header>
      <form class="mule-search" @submit.prevent="search(0)">
        <input v-model="term" :placeholder="mode === 'mixes' ? 'Ingredients, animal, recipe or customer name' : 'Customer name or order number'" aria-label="Search customer work" />
        <button type="submit" :disabled="busy">Search</button>
        <label v-if="mode === 'mixes'"><input v-model="mine" type="checkbox" @change="search(0)" /> Selected customer's mixes</label>
      </form>
      <p v-if="error" role="alert" class="mule-error">{{ error }}</p>
      <p v-if="busy" role="status">Loading…</p>
      <p v-if="!busy && !error && !rows.length">{{ mode === 'mixes' ? 'No matching mixes. Try another name or open the formula library.' : 'No matching open orders.' }}</p>
      <div class="mule-results">
        <article v-for="row in rows" :key="row.name">
          <template v-if="mode === 'mixes'">
            <div><strong>{{ row.display_name || row.item_name }}</strong>
              <p v-if="row.display_name !== row.ingredients?.join(', ')">{{ row.ingredients?.join(', ') || 'Ingredients not recorded' }}</p>
              <p v-if="!mine">Recipe owner: {{ row.owner_name || 'Not recorded' }}</p>
              <p>{{ row.mule_animal_search || 'Animal not recorded' }}</p>
              <p v-if="row.last_purchase">Last bought: {{ purchaseText(row.last_purchase) }}</p>
              <p v-else>{{ madeText(row) }} · Purchase quantities / price unavailable</p></div>
            <button type="button" :disabled="busy" @click="preview(row)">View recipe</button>
          </template>
          <template v-else>
            <div><strong>{{ row.customer_name }}</strong><p>{{ row.name }} · Requested {{ row.delivery_date }} · {{ row.progress || row.status }}</p></div>
            <a :href="'/desk/sales-order/' + encodeURIComponent(row.name)" target="_blank">Review order</a>
            <button type="button" :disabled="busy || cartHasItems || row.docstatus === 0" @click="pickup(row)">Load for payment</button>
          </template>
        </article>
      </div>
      <p v-if="mode === 'orders'">Review production readiness before release. Loading checks finished stock; the requested pickup date alone does not mean ready.</p>
      <p v-if="mode === 'orders' && cartHasItems" class="mule-error">Finish or park the current basket before loading an order.</p>
      <section v-if="details && mode === 'mixes'" ref="recipe" class="mule-recipe">
        <h3>{{ chosen.display_name || chosen.item_name }}</h3>
        <p><strong>Ingredients:</strong> {{ details.ingredients?.map(i => i.item_name).join(', ') || 'Recipe not recorded' }}</p>
        <p><strong>For:</strong> {{ details.animals || 'Animal not recorded' }}</p>
        <p v-if="details.last_purchase"><strong>Last bought:</strong> {{ purchaseText(details.last_purchase) }}</p>
        <p v-else>No linked purchase quantities or price recorded for this customer.</p>
        <p v-if="details.message">{{ details.message }}</p>
        <form v-if="details.bom" class="mule-order" @submit.prevent="orderMix">
          <label>Quantity<input v-model.number="qty" type="number" :min="unit === 'Bag' ? 1 : 0.001" :step="unit === 'Bag' ? 1 : 'any'" required /></label>
          <label>Unit<select v-model="unit"><option value="Pound">Pounds</option><option v-if="details.bag_weight" value="Bag">Bags ({{ details.bag_weight }} lb)</option></select></label>
          <label>Pickup date<input v-model="date" type="date" required /></label>
          <button type="submit" :disabled="busy || !customer">Prepare order</button>
          <button type="button" :disabled="busy || !customer" @click="editMix">Edit in formula editor</button>
        </form>
        <p v-if="details.bom">Order quantity: {{ orderPounds }} lb<span v-if="details.bag_weight"> · {{ orderBags }} bags of {{ details.bag_weight }} lb</span>. Today’s price is calculated on the prepared order.</p>
        <p>Review pricing and pickup time on the order before submitting. Editing opens separately and keeps your basket.</p>
        <details><summary>Nutrient analysis and full recipe</summary>
          <MuleNutrition :values="details.nutrition" :source="details.nutrition_source" />
          <a v-if="details.bom" :href="'/desk/bom/' + encodeURIComponent(details.bom)" target="_blank">Full recipe (BOM)</a>
        </details>
        <p v-if="created"><a :href="created" target="_blank">Open prepared document</a></p>
      </section>
      <footer><button v-if="start" type="button" :disabled="busy" @click="search(start - 20)">Previous</button>
        <button v-if="more" type="button" :disabled="busy" @click="search(start + 20)">More mixes</button>
        <a href="/desk/customer-formula-link" target="_blank">Full formula library</a></footer>
    </dialog>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import MuleNutrition from './MuleNutrition.vue';
// Both hosts supply their authenticated RPC client; this component owns no pricing.
// customer is the Customer ID (used in every call); customerName is what people read.
const props = defineProps({customer: String, customerName: String, profile: String, request: Function, cartHasItems: Boolean});
const emit = defineEmits(['pickup']);
const dialog = ref(null), mode = ref(''), term = ref(''), mine = ref(true);
const customerOrders = ref([]), ordersLoading = ref(false), ordersError = ref(false);
let orderGeneration = 0;
const completedOrders = computed(() => customerOrders.value.filter(row => row.progress?.startsWith('Production complete')).length);
const orderPounds = computed(() => unit.value === 'Bag' ? qty.value * details.value?.bag_weight : qty.value);
const orderBags = computed(() => details.value?.bag_weight ? orderPounds.value / details.value.bag_weight : null);
const rows = ref([]), busy = ref(false), error = ref(''), more = ref(false), start = ref(0);
const recipe = ref(null), details = ref(null), chosen = ref(null), qty = ref(0), date = ref(''), created = ref(''), unit = ref('Pound');
let generation = 0;
const api = (name, args) => props.request('mulecity_erpnext.pos_workspace.' + name, {pos_profile: props.profile, ...args});
// Mixes come newest first; this line says which one the customer is on now.
function madeText(row) {
  if (!row.last_used) return 'No sales recorded';
  const times = row.usage_count === 1 ? 'once' : row.usage_count + ' times';
  return 'Last used ' + row.last_used + ' · recorded ' + times;
}
function fail(e) { error.value = e?.message || 'Could not complete this request. Please retry.'; }
async function open(next) { mine.value = !!props.customer; mode.value = next; term.value = ''; details.value = null; dialog.value.showModal(); await search(0); }
async function search(offset = 0) {
  const token = ++generation; busy.value = true; error.value = ''; details.value = null;
  try {
    const result = mode.value === 'orders' && props.customer
      ? await props.request('mulecity_erpnext.pos_product_context.customer_orders', {customer: props.customer, pos_profile: props.profile, search: term.value})
      : await api(mode.value === 'mixes' ? 'find_mixes' : 'find_orders', {
      search: term.value, customer: mode.value === 'orders' || mine.value ? props.customer : null,
      ...(mode.value === 'mixes' ? {start: offset} : {})});
    if (token !== generation) return;
    rows.value = mode.value === 'mixes' ? result.rows : result;
    more.value = !!result.has_more; start.value = offset;
  } catch (e) { if (token === generation) { rows.value = []; fail(e); } }
  finally { if (token === generation) busy.value = false; }
}
async function preview(row) {
  const token = ++generation;
  busy.value = true; error.value = ''; created.value = '';
  try { const result = await api('mix_details', {item_code: row.name, customer: props.customer || null});
    if (token !== generation) return;
    details.value = result; chosen.value = row; unit.value = details.value.bag_weight ? 'Bag' : 'Pound'; qty.value = unit.value === 'Bag' ? (details.value.last_purchase?.bags || (details.value.last_purchase?.pounds ? details.value.last_purchase.pounds / details.value.bag_weight : 0)) : (details.value.last_purchase?.pounds || 0);
    await nextTick(); recipe.value?.scrollIntoView({behavior: 'smooth', block: 'start'}); }
  catch(e) { if (token === generation) fail(e); } finally { if (token === generation) busy.value = false; }
}
async function orderMix() {
  busy.value = true; error.value = '';
  try { const name = await api('create_mix_order', {bom: details.value.bom, customer: props.customer, qty: qty.value, uom: unit.value, pickup_date: date.value});
    created.value = '/desk/sales-order/' + encodeURIComponent(name); window.open(created.value, '_blank');
  } catch(e) { fail(e); } finally { busy.value = false; }
}
async function editMix() {
  busy.value = true; error.value = '';
  try { const name = await props.request('mulecity_erpnext.mule_feed_formula.api.create_scratchpad_from_mix', {bom: details.value.bom, customer: props.customer});
    created.value = '/desk/formula-scratchpad/' + encodeURIComponent(name); window.open(created.value, '_blank');
  } catch(e) { fail(e); } finally { busy.value = false; }
}
async function pickup(row) {
  if (props.cartHasItems) return;
  busy.value = true; error.value = '';
  try { const doc = await api('pickup_invoice', {sales_order: row.name}); emit('pickup', doc); dialog.value.close(); }
  catch(e) { fail(e); } finally { busy.value = false; }
}
function purchaseText(p) {
  const units = [p.bags != null ? p.bags + ' bags' : '', p.pounds != null ? p.pounds + ' lb' : ''].filter(Boolean).join(' / ');
  return [p.date, units, new Intl.NumberFormat(undefined, {style: 'currency', currency: p.currency}).format(p.amount) + ' before tax'].filter(Boolean).join(' · ');
}
async function refreshOrders() {
  const token = ++orderGeneration;
  customerOrders.value = []; ordersError.value = false; ordersLoading.value = false;
  if (!props.customer || !props.profile) return;
  ordersLoading.value = true;
  try {
    const result = await props.request('mulecity_erpnext.pos_product_context.customer_orders', {customer: props.customer, pos_profile: props.profile});
    if (token === orderGeneration) customerOrders.value = result;
  } catch { if (token === orderGeneration) ordersError.value = true; }
  finally { if (token === orderGeneration) ordersLoading.value = false; }
}
onMounted(() => window.addEventListener('focus', refreshOrders));
onUnmounted(() => window.removeEventListener('focus', refreshOrders));
watch(() => [props.customer, props.profile], () => { refreshOrders(); if (mode.value) { mine.value = !!props.customer; search(0); } }, {immediate: true});
</script>

<style scoped>
/* A compact counter toolbar and readable recipe sheet, using host typography. */
.mule-counter-tools { display:flex; flex-wrap:wrap; align-items:center; gap:10px; padding:8px 16px; border-bottom:1px solid hsl(var(--border)); background:hsl(var(--secondary)); color:hsl(var(--foreground)); flex-shrink:0; }
.mule-counter-tools strong { margin-right:8px; } .mule-counter-tools small { margin-left:auto; }
.mule-counter-tools button, .mule-workspace button { border:1px solid hsl(var(--border)); border-radius:5px; padding:7px 12px; background:hsl(var(--card)); color:hsl(var(--foreground)); cursor:pointer; font:inherit; }
button:disabled { opacity:.5; cursor:not-allowed; } button:focus-visible, a:focus-visible, input:focus-visible { outline:3px solid hsl(var(--ring)); outline-offset:2px; }
.mule-counter-tools a, .mule-workspace a { color:hsl(var(--primary)); text-decoration:underline; }
.mule-workspace { margin:auto; width:min(950px,94vw); max-height:88vh; padding:22px; border:1px solid hsl(var(--border)); border-radius:8px; background:hsl(var(--card)); color:hsl(var(--foreground)); overflow:auto; font-size:16px; line-height:1.45; font-family:inherit; }
.mule-workspace::backdrop { background:rgba(0,0,0,.4); }
.mule-workspace header { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; }
.mule-workspace h2 { font-size:24px; font-weight:700; margin:0; } .mule-workspace h3 { font-size:20px; font-weight:650; }
.mule-workspace p { margin:6px 0 12px; } .mule-workspace input:not([type=checkbox]) { border:1px solid hsl(var(--input)); padding:8px; border-radius:4px; background:hsl(var(--card)); color:hsl(var(--foreground)); }
.mule-search { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; align-items:center; } .mule-search>input { flex:1; min-width:220px; }
.mule-results article { display:flex; align-items:center; gap:12px; padding:12px 0; border-bottom:1px solid hsl(var(--border)); } .mule-results article>div { flex:1; } .mule-results p { font-size:14px; margin:4px 0; }
.mule-recipe { border-top:3px solid hsl(var(--ring)); margin-top:20px; padding-top:16px; } .mule-recipe table { width:100%; border-collapse:collapse; margin:12px 0; } th,td { padding:7px; text-align:left; border-bottom:1px solid hsl(var(--border)); }
.mule-order { display:flex; flex-wrap:wrap; gap:12px; align-items:end; } .mule-order label { display:flex; flex-direction:column; } .mule-order input { max-width:180px; }
.mule-error { color:hsl(var(--destructive)); } .mule-workspace footer { display:flex; gap:12px; margin-top:16px; align-items:center; }
</style>
