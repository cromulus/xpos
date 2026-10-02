/** Real queued pickup story: coverage was valid at the reported sale, reconnect is after expiry.
 * erp2's allow_tests fixture creates native order/manufacture and signed historic evidence.
 * Browser admission failures (expiry/customer/cap/clock) are also exercised in vfdOffline.spec.ts.
 */
import { ensureOpenShift, openTillOnline, restoreNetworkAfterEach, waitUntil } from '../support/offline';

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
    waitUntil(() => cy.pendingInvoices(), rows => rows.length === 0, 'VFD pickup replay to post');
    const filters = JSON.stringify({ xpos_local_id: data.local_id });
    cy.benchCall('frappe.client.get_list', { doctype: 'Sales Invoice', filters,
      fields: JSON.stringify(['name', 'docstatus', '_comments']) }).then((invoices: any[]) => {
      expect(invoices).to.have.length(1);
      expect(invoices[0].docstatus).to.equal(1);
      expect(invoices[0]._comments).to.contain('VFD offline expiry review');
      const name = invoices[0].name;
      // The native invoice timeline checks reference permissions and returns the
      // full comment; Sales Invoice._comments deliberately truncates it.
      cy.request({ method: 'GET', url: '/api/method/frappe.desk.form.load.getdoc',
        qs: { doctype: 'Sales Invoice', name } }).then(response => {
        expect(JSON.stringify(response.body.docinfo.comments)).to.contain('not independently verified');
      });
      cy.benchCall('frappe.client.get', { doctype: 'Sales Invoice', name }).then((invoice: any) => {
        expect(invoice.items[0].mule_vfd).to.equal(data.items[0].mule_vfd);
        expect(invoice.customer).to.equal(data.customer);
      });
      // A lost successful response requeues the same ticket, not a new invoice or flag.
      cy.networkOff();
      cy.queueInvoice({ local_id: data.local_id, data, status: 'pending', retry_count: 0,
        customer_name: data.customer, created_at: new Date().toISOString() });
      cy.networkOn();
      waitUntil(() => cy.pendingInvoices(), rows => rows.length === 0, 'duplicate VFD pickup replay');
      cy.benchCall('frappe.client.get_list', { doctype: 'Sales Invoice', filters,
        fields: JSON.stringify(['name', '_comments']) }).then((again: any[]) => {
        expect(again).to.have.length(1);
        expect(again[0].name).to.equal(name);
        const comments = JSON.parse(again[0]._comments || '[]');
        expect(comments.filter((entry: any) => entry.comment?.includes('VFD offline expiry review'))).to.have.length(1);
      });
      cy.benchCall('frappe.client.get_list', { doctype: 'ToDo',
        filters: JSON.stringify({ reference_type: 'Sales Invoice', reference_name: name }),
        fields: JSON.stringify(['name']) }).should('have.length', 1);
    });
  });
});
