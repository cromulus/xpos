/** Real queued pickup story: coverage was valid at the reported sale, reconnect is after expiry.
 * erp2's allow_tests fixture creates native order/manufacture and signed historic evidence.
 * Browser admission failures (expiry/customer/cap/clock) are also exercised in vfdOffline.spec.ts.
 */
import { ensureOpenShift, invoiceComments, openTillOnline, restoreNetworkAfterEach, waitUntil } from '../support/offline';

/** The queue's sync state, not its payload, so a timeout names the server's refusal. */
const queueState = () => cy.pendingInvoices().then(rows =>
  rows.map(({ local_id, status, retry_count, error }) => ({ local_id, status, retry_count, error })));

describe('the medicated pickup sold before expiry reconnects later', () => {
  beforeEach(() => { cy.benchLogin(); ensureOpenShift(); });
  restoreNetworkAfterEach();
  it('posts the actual queue once, preserves its VFD, and adds one review comment and task', () => {
    const raw = Cypress.env('vfdFixture');
    expect(raw, 'erp2 must prepare the VFD pickup fixture; no skipped gate').to.be.a('string').and.not.be.empty;
    const data = JSON.parse(raw);
    openTillOnline();
    cy.networkOff();
    cy.queueInvoice({ local_id: data.local_id, data, status: 'pending', retry_count: 0,
      customer_name: data.customer, created_at: new Date().toISOString() });
    cy.pendingInvoices().should('have.length', 1);
    cy.networkOn();
    waitUntil(queueState, rows => rows.length === 0, 'VFD pickup replay to post');
    const filters = JSON.stringify({ xpos_local_id: data.local_id });
    cy.benchCall('frappe.client.get_list', { doctype: 'Sales Invoice', filters,
      fields: JSON.stringify(['name', 'docstatus']) }).then((invoices: any[]) => {
      expect(invoices).to.have.length(1);
      expect(invoices[0].docstatus).to.equal(1);
      const name = invoices[0].name;
      // The native invoice timeline checks reference permissions and returns the
      // full comment (Frappe 16.54 no longer lists the _comments cache column).
      invoiceComments(name).then(comments => {
        expect(comments.join(' ')).to.contain('VFD offline expiry review');
        expect(comments.join(' ')).to.contain('not independently verified');
      });
      cy.benchCall('frappe.client.get', { doctype: 'Sales Invoice', name }).then((invoice: any) => {
        expect(invoice.items[0].mule_vfd).to.equal(data.items[0].mule_vfd);
        expect(invoice.customer).to.equal(data.customer);
      });
      // A lost successful response requeues the same ticket, not a new invoice or flag.
      cy.networkOff();
      cy.queueInvoice({ local_id: data.local_id, data, status: 'pending', retry_count: 0,
        customer_name: data.customer, created_at: new Date().toISOString() });
      cy.pendingInvoices().should('have.length', 1);
      cy.networkOn();
      waitUntil(queueState, rows => rows.length === 0, 'duplicate VFD pickup replay');
      cy.benchCall('frappe.client.get_list', { doctype: 'Sales Invoice', filters,
        fields: JSON.stringify(['name']) }).then((again: any[]) => {
        expect(again).to.have.length(1);
        expect(again[0].name).to.equal(name);
      });
      invoiceComments(name).then(comments =>
        expect(comments.filter(text => text.includes('VFD offline expiry review'))).to.have.length(1));
      cy.benchCall('frappe.client.get_list', { doctype: 'ToDo',
        filters: JSON.stringify({ reference_type: 'Sales Invoice', reference_name: name }),
        fields: JSON.stringify(['name']) }).should('have.length', 1);
    });
  });
});
