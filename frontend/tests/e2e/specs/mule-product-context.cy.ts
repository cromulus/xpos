/** Counter story: recognize the selected customer's mix and outstanding work. */
import { lastCallTo } from '../support/frappeStub';
const purchase = {date: '2026-09-20', bags: 20, pounds: 1000, amount: 245, currency: 'USD'};
const mix = {name: 'MIX-TEST', display_name: 'Corn, Barley', item_name: 'Ada Formula A3C60D9B14', ingredients: ['Corn', 'Barley'], mule_animal_search: 'Cattle', last_purchase: purchase};
describe('Mule City product context', () => {
  it('shows useful groups, open work and a customer-first recognizable recipe with historical quantities', () => {
    cy.bootPos({routes: {
      'mulecity_erpnext.pos_workspace.tax_context': {taxes: [], tax_category: '', taxes_and_charges: ''},
      'xpos.api.items.get_item_groups': {parent_groups: [{name: 'Feed'}], groups: [{name: 'House Mixes'}]},
      'mulecity_erpnext.pos_product_context.customer_orders': [{name: 'SO-1', customer_name: 'Ada Lovelace', progress: 'With the mill', docstatus: 1}],
      'mulecity_erpnext.pos_workspace.find_mixes': {rows: [mix], has_more: false},
      'mulecity_erpnext.pos_workspace.mix_details': {bom: 'BOM-TEST', quantity: 8000, uom: 'Pound', bag_weight: 50, ingredients: [{item_name: 'Corn'}, {item_name: 'Barley'}], animals: 'Cattle', nutrition: {protein_pct: 12, fat_pct: null}, last_purchase: purchase},
    }});
    cy.contains('button', 'Feed').should('be.visible');
    cy.contains('button', 'House Mixes').should('be.visible');
    cy.contains('button', '1 open order(s)').should('contain.text', 'With the mill');
    cy.contains('button', 'Customer Mixes').click();
    cy.get('.mule-search input[type=checkbox]').should('be.checked');
    cy.get('.mule-results').should('contain.text', 'Corn, Barley').and('contain.text', '20 bags / 1000 lb').and('not.contain.text', 'A3C60D9B14');
    cy.contains('button', 'View recipe').click();
    cy.contains('summary', 'Nutrient analysis and full recipe').click();
    cy.get('.mule-recipe').should('contain.text', 'Protein').and('contain.text', '12.00%').and('contain.text', 'Unknown');
    cy.get('.mule-order input[type=number]').should('have.value', '20');
    cy.screenshot('customer-mix-context');
    cy.get('.mule-search input[type=checkbox]').uncheck();
    cy.then(() => expect(lastCallTo('mulecity_erpnext.pos_workspace.find_mixes')?.args.customer).to.eq(null));
  });
});
