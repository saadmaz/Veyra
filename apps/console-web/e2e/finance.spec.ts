import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { FakeApi } from './fake-api';

const PASSWORD = 'correct horse battery staple';
const ZONE = 'Asia/Karachi';

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** A property-local date, shifted by some days. */
function day(offsetDays = 0): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function setup() {
  const api = new FakeApi();
  const admin = api.addUser('admin@example.test', PASSWORD, 'Ada Admin');
  const org = api.addOrganisation('Harbour Group', admin.id);
  const property = api.addProperty(org.id, 'Harbour View', 'HVR');
  const unit = api.addUnit(property.id, '101');
  const ana = api.addPerson(org.id, 'Ana Owner', 'ana@example.test');
  api.addOwnership(unit.id, ana, '2026-01-01');
  const owner = api.addUser('ana@example.test', PASSWORD, 'Ana Owner');
  api.linkPerson(ana.id, owner.id);
  const farah = api.addUser('farah@example.test', PASSWORD, 'Farah Finance');
  api.addMembership(org.id, farah.id, 'FINANCE_OFFICER');
  const omar = api.addUser('omar@example.test', PASSWORD, 'Omar Officer');
  api.addMembership(org.id, omar.id, 'FINANCE_OFFICER', property.id);
  const base = `/organisations/${org.id}/properties/${property.id}`;
  const seedContext = {
    propertyId: property.id,
    units: api.units,
    ownerships: api.ownerships,
    tenancies: api.tenancies,
  };
  return {
    api,
    admin,
    org,
    property,
    unit,
    owner,
    farah,
    omar,
    base,
    finance: `${base}/finance`,
    seedContext,
  };
}

/** Finance set up, one issued invoice of PKR 5,000.00 and a payment of PKR 6,000.00 against it. */
function seedPaid(ctx: ReturnType<typeof setup>, issuedDaysAgo = 0, dueInDays = 14) {
  const { api, property, unit, seedContext } = ctx;
  api.finance.setUp(property.id);
  const invoice = api.finance.seedIssuedInvoice(
    seedContext,
    unit.id,
    500_000n,
    day(-issuedDaysAgo),
    day(dueInDays - issuedDaysAgo),
  );
  return invoice;
}

test.describe('finance officers', () => {
  test('set up finance, bill the month, issue the invoice and record a payment', async ({
    page,
  }) => {
    const ctx = setup();
    const { api, farah, base } = ctx;
    api.currentUserId = farah.id;
    page.on('dialog', (dialog) => void dialog.accept());
    await api.install(page);

    await page.goto(base);
    await page.getByRole('link', { name: 'Open finance' }).click();
    await expect(page.getByRole('heading', { name: 'Finance', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Set up finance' }).click();
    await expect(page.getByRole('region', { name: 'Chart of accounts' })).toContainText(
      'Receivables from units',
    );
    await expect(page.getByRole('region', { name: 'Owed now' })).toContainText('Nothing is owed.');
    await expectAccessible(page);

    // A monthly service charge for every unit, then this month's billing as drafts.
    await page.getByRole('link', { name: 'Billing setup' }).click();
    const recurring = page.getByRole('form', { name: 'New recurring charge' });
    await recurring.getByLabel('Charge type').selectOption({ label: 'Service charge (SERVICE)' });
    await recurring.getByLabel('Amount (PKR)').fill('5,000');
    await recurring.getByRole('button', { name: 'Add charge' }).click();
    await expect(page.getByRole('list', { name: 'Recurring charges' })).toContainText(
      'every unit · PKR 5,000.00 a month',
    );
    const run = page.getByRole('form', { name: 'Run monthly billing' });
    await run.getByRole('button', { name: 'Run billing' }).click();
    await expect(run.getByRole('status')).toContainText(
      '1 invoice created as drafts to check and issue',
    );
    await expectAccessible(page);
    await expectNoHorizontalScroll(page);

    // Running again bills nothing twice.
    await run.getByRole('button', { name: 'Run billing' }).click();
    await expect(run.getByRole('status')).toContainText('No new invoices');

    await run.getByRole('link', { name: 'See the invoices' }).click();
    await page.getByRole('link', { name: 'Draft', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Draft invoice' })).toContainText('Ana Owner');
    await page.getByRole('button', { name: 'Issue invoice' }).click();
    const issued = page.getByRole('region', { name: 'Invoice INV-000001' });
    await expect(issued).toContainText('PKR 5,000.00');
    await expectAccessible(page);

    // Paying more than owed: the invoice is settled and the rest is kept as credit.
    await issued.getByRole('link', { name: 'Record a payment' }).click();
    const form = page.getByRole('form', { name: 'Record a payment' });
    await expect(form.getByLabel('Unit')).toHaveValue(ctx.unit.id);
    await form.getByLabel('Amount (PKR)').fill('6000.505');
    await form.getByRole('button', { name: 'Record payment' }).click();
    await expect(form.getByText('PKR amounts have at most 2 decimals.')).toBeVisible();
    await form.getByLabel('Amount (PKR)').fill('6000');
    await form.getByLabel('Reference (optional)').fill('TRX-1001');
    await form.getByRole('button', { name: 'Record payment' }).click();
    const recorded = page.getByRole('status').filter({ hasText: 'Receipt RCT-000001 recorded' });
    await expect(recorded).toContainText(
      'PKR 5,000.00 applied to invoices, PKR 1,000.00 kept as credit',
    );
    await expect(page.getByRole('region', { name: 'Receipts' })).toContainText('RCT-000001');
    expect(api.finance.payments).toHaveLength(1);
    await expectAccessible(page);
    await expectNoHorizontalScroll(page);

    await page.goto(`${ctx.finance}/invoices`);
    await expect(page.getByRole('table')).toContainText('settled');
  });

  test('a refund waits for a second person, who approves it', async ({ page }) => {
    const ctx = setup();
    const { api, farah, omar, finance } = ctx;
    seedPaid(ctx);
    api.currentUserId = farah.id;
    await api.install(page);

    // Farah records PKR 6,000.00: PKR 1,000.00 is left unused.
    await page.goto(`${finance}/payments`);
    const form = page.getByRole('form', { name: 'Record a payment' });
    await form.getByLabel('Unit').selectOption({ label: 'Unit 101' });
    await form.getByLabel('Amount (PKR)').fill('6000');
    await form.getByRole('button', { name: 'Record payment' }).click();
    await page.getByRole('link', { name: 'Open the receipt' }).click();
    await expect(page.getByRole('region', { name: 'Receipt RCT-000001' })).toContainText(
      'PKR 1,000.00',
    );

    const refund = page.getByRole('form', { name: 'Refund' });
    await refund.getByLabel('Reason').fill('Overpaid by mistake');
    await refund.getByRole('button', { name: 'Ask for approval' }).click();
    await expect(page.getByRole('region', { name: 'Refund' })).toContainText('Sent for approval.');
    await expect(page.getByText('Refund requested.')).toBeVisible();

    // The requester cannot decide their own request.
    await page.getByRole('main').getByRole('link', { name: 'Approvals' }).click();
    const requests = page.getByRole('list', { name: 'Approval requests' });
    await expect(requests).toContainText('Refund of PKR 1,000.00');
    await expect(requests).toContainText('Someone else must approve this.');
    await expect(requests.getByRole('button', { name: /Decide/ })).toHaveCount(0);
    await expectAccessible(page);

    // Omar, another finance officer, approves it.
    api.currentUserId = omar.id;
    await page.reload();
    await requests.getByRole('button', { name: 'Decide: Refund of PKR 1,000.00' }).click();
    await requests.getByLabel('Note (optional)').fill('Checked the bank statement');
    await requests.getByRole('button', { name: 'Approve' }).click();
    await expect(requests).toHaveCount(0);
    await page.getByLabel('Show').selectOption({ label: 'Approved' });
    await expect(page.getByRole('list', { name: 'Approval requests' })).toContainText(
      'Decided by Omar Officer',
    );
    expect(api.finance.payments[0]?.refunded).toHaveLength(1);

    await page.goto(`${finance}/payments/${api.finance.payments[0]?.id}`);
    await expect(page.getByRole('region', { name: 'Receipt RCT-000001' })).toContainText(
      'Refunded',
    );
    await expect(page.getByRole('form', { name: 'Refund' })).toHaveCount(0);
    await expectAccessible(page);
  });

  test('credit notes, write-off requests, ageing, statements and closing a period', async ({
    page,
  }) => {
    const ctx = setup();
    const { api, farah, finance } = ctx;
    // Issued 40 days ago, due 26 days ago: 1–30 days late.
    const invoice = seedPaid(ctx, 40, 14);
    api.currentUserId = farah.id;
    page.on('dialog', (dialog) => void dialog.accept());
    await api.install(page);

    await page.goto(`${finance}/reports`);
    const ageing = page.getByRole('region', { name: 'Ageing' });
    await expect(ageing.getByRole('row', { name: /101/ })).toContainText('PKR 5,000.00');
    await ageing.getByRole('button', { name: 'Statement of unit 101, owners' }).click();
    const statement = page.getByRole('region', { name: 'Statement' });
    await expect(statement).toContainText('PKR 5,000.00 owed');
    await expect(statement.getByRole('table')).toContainText('INV-000001');
    await expectAccessible(page);
    await expectNoHorizontalScroll(page);

    await page.goto(`${finance}/invoices/${invoice.id}`);
    await expect(page.getByRole('region', { name: 'Invoice INV-000001' })).toContainText('overdue');
    const credit = page.getByRole('form', { name: 'Credit note' });
    await credit.getByLabel('Amount (PKR)').fill('500');
    await credit.getByLabel('Reason').fill('Billed for a closed gym month');
    await credit.getByRole('button', { name: 'Issue credit note' }).click();
    await expect(page.getByRole('list', { name: 'Credits' })).toContainText(
      'Credit note CRN-000001',
    );
    await expect(page.getByRole('region', { name: 'Invoice INV-000001' })).toContainText(
      'PKR 4,500.00',
    );

    // More than is owed is refused by the API, in its own words.
    const writeOff = page.getByRole('form', { name: 'Write off' });
    await expect(writeOff.getByLabel('Amount (PKR)')).toHaveValue('4500.00');
    await writeOff.getByLabel('Amount (PKR)').fill('9000');
    await writeOff.getByLabel('Reason').fill('Owner cannot be traced');
    await writeOff.getByRole('button', { name: 'Ask for approval' }).click();
    await expect(writeOff.getByRole('alert')).toContainText('more than the invoice still owes');
    await writeOff.getByLabel('Amount (PKR)').fill('4500');
    await writeOff.getByRole('button', { name: 'Ask for approval' }).click();
    await expect(page.getByRole('region', { name: 'Write off' })).toContainText(
      'Sent for approval.',
    );
    expect(api.finance.approvals[0]?.action).toBe('WRITE_OFF');
    await expectAccessible(page);

    // Closing this month's period; reopening it needs approval.
    await page.goto(`${finance}/reports`);
    const periods = page.getByRole('list', { name: 'Accounting periods' });
    const current = periods.getByRole('listitem').first();
    await current.getByRole('button', { name: /^Close period/ }).click();
    await expect(current.getByText('closed', { exact: true })).toBeVisible();
    await current.getByRole('button', { name: /^Reopen period/ }).click();
    await current.getByLabel('Reason').fill('Late bank charges to post');
    await current.getByRole('button', { name: 'Ask for approval' }).click();
    await expect(page.getByRole('region', { name: 'Accounting periods' })).toContainText(
      'Sent for approval.',
    );
    expect(api.finance.approvals.map((a) => a.action)).toEqual(['WRITE_OFF', 'REOPEN_PERIOD']);
  });
});

test.describe('access', () => {
  test('a property manager reads finance but cannot change it', async ({ page }) => {
    const ctx = setup();
    const { api, org, property, finance, base } = ctx;
    const manager = api.addUser('pm@example.test', PASSWORD, 'Pat Manager');
    api.addMembership(org.id, manager.id, 'PROPERTY_MANAGER', property.id);
    api.currentUserId = manager.id;
    await api.install(page);

    await page.goto(finance);
    await expect(page.getByText('A finance officer needs to set up finance')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Set up finance' })).toHaveCount(0);

    seedPaid(ctx);
    await page.goto(`${finance}/invoices`);
    await expect(page.getByRole('table')).toContainText('INV-000001');
    await expect(page.getByRole('form', { name: 'New invoice' })).toHaveCount(0);
    await page.goto(`${finance}/payments`);
    await expect(page.getByRole('form', { name: 'Record a payment' })).toHaveCount(0);
    await page.goto(`${finance}/billing`);
    await expect(page.getByRole('form', { name: 'Run monthly billing' })).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Charge types' })).toContainText('SERVICE');
    await expectAccessible(page);
    expect(api.log.filter((line) => line.startsWith('POST') && line.includes('/finance'))).toEqual(
      [],
    );
    await page.goto(base);
    await expect(page.getByRole('link', { name: 'Open finance' })).toBeVisible();
  });

  test('a guard and a resident cannot see finance', async ({ page }) => {
    const ctx = setup();
    const { api, org, property, owner, finance, base } = ctx;
    seedPaid(ctx);
    const guard = api.addUser('guard@example.test', PASSWORD, 'Gil Guard');
    api.addMembership(org.id, guard.id, 'SECURITY_GUARD', property.id);
    api.currentUserId = guard.id;
    await api.install(page);

    await page.goto(base);
    await expect(page.getByRole('heading', { name: 'Harbour View', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Finance' })).toHaveCount(0);
    await page.goto(`${finance}/invoices`);
    await expect(page.getByRole('heading', { name: 'You cannot view finance' })).toBeVisible();

    // Residents reach their own unit only, never the property's finance.
    api.currentUserId = owner.id;
    await page.goto(finance);
    await expect(page.getByRole('heading', { name: 'Property not found' })).toBeVisible();
    expect(api.log.filter((line) => line.includes('/finance/'))).toEqual([]);
  });
});
