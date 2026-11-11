import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { FakeApi } from './fake-api';

/*
 * Residents' billing (Phase 6 Part 6): an owner sees the owners' account, reports a bank
 * transfer and finance confirms it; a tenant sees only their tenancy's account and the reason a
 * transfer was not confirmed. The API's own tests prove the access rules; these prove the
 * screens.
 */

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

function day(offsetDays = 0): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** An owner and a tenant of unit 101, two finance officers and one issued owners' invoice. */
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
  const tia = api.addPerson(org.id, 'Tia Tenant', 'tia@example.test');
  api.addTenancy(unit.id, tia, '2026-01-01');
  const tenant = api.addUser('tia@example.test', PASSWORD, 'Tia Tenant');
  api.linkPerson(tia.id, tenant.id);
  const farah = api.addUser('farah@example.test', PASSWORD, 'Farah Finance');
  api.addMembership(org.id, farah.id, 'FINANCE_OFFICER');
  const base = `/organisations/${org.id}/properties/${property.id}`;
  api.finance.setUp(property.id);
  const invoice = api.finance.seedIssuedInvoice(
    {
      propertyId: property.id,
      units: api.units,
      ownerships: api.ownerships,
      tenancies: api.tenancies,
    },
    unit.id,
    500_000n,
    day(0),
    day(14),
  );
  return { api, owner, tenant, farah, unitPath: `${base}/units/${unit.id}`, base, invoice };
}

test.describe('residents', () => {
  test('an owner reports a bank transfer, finance confirms it and the invoice is paid', async ({
    page,
  }) => {
    const { api, owner, farah, unitPath, base } = setup();
    api.currentUserId = owner.id;
    await api.install(page);

    await page.goto(unitPath);
    await page.getByRole('link', { name: 'Open billing' }).click();
    await expect(page.getByRole('heading', { name: 'Billing', level: 1 })).toBeVisible();
    const account = page.getByRole('region', { name: "Owners' account" });
    await expect(account).toContainText('PKR 5,000.00 owed');
    await expect(account).toContainText('Tenants do not see it.');
    await expect(page.getByRole('group', { name: 'Your invoices' })).toContainText('INV-000001');
    await expectAccessible(page);
    await expectNoHorizontalScroll(page);

    // The form checks what it can before sending.
    const form = page.getByRole('form', { name: 'Report a bank transfer' });
    await form.getByRole('button', { name: 'Send to finance' }).click();
    await expect(form.getByText('Enter an amount.')).toBeVisible();
    await expect(form.getByText("Enter the bank's reference for the transfer.")).toBeVisible();
    await form.getByLabel('Amount (PKR)').fill('5,000');
    await form.getByLabel('Bank reference').fill('FT-778');
    await form.getByRole('button', { name: 'Send to finance' }).click();
    await expect(page.getByText('is waiting for finance to confirm it')).toBeVisible();
    await expect(account).toContainText('Transfers waiting for finance');
    await expect(account).toContainText('PKR 5,000.00');
    await expect(page.getByRole('list', { name: 'Bank transfers you reported' })).toContainText(
      'waiting for finance',
    );

    // Finance finds the money and confirms it.
    api.currentUserId = farah.id;
    await page.goto(`${base}/finance/transfers`);
    const waiting = page.getByRole('list', { name: 'Bank transfers' });
    await expect(waiting).toContainText('FT-778');
    await expect(waiting).toContainText('reported by Ana Owner');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Confirm: PKR 5,000.00 for unit 101' }).click();
    await page.getByRole('button', { name: 'Confirm and record payment' }).click();
    await expect(page.getByText('No transfers here.')).toBeVisible();
    await page.getByLabel('Show').selectOption('CONFIRMED');
    await expect(page.getByRole('list', { name: 'Bank transfers' })).toContainText(
      'Recorded as RCT-000001',
    );

    // The owner sees the receipt and a settled invoice.
    api.currentUserId = owner.id;
    await page.goto(`${unitPath}/billing`);
    await expect(page.getByRole('region', { name: "Owners' account" })).toContainText(
      'Nothing owed',
    );
    await expect(page.getByRole('group', { name: 'Your receipts' })).toContainText('RCT-000001');
    await expect(page.getByRole('group', { name: 'Your invoices' })).toContainText('settled');
    await expect(page.getByRole('list', { name: 'Bank transfers you reported' })).toContainText(
      'confirmed',
    );
    await expectAccessible(page);
  });

  test('a tenant sees only their tenancy account and why a transfer was not confirmed', async ({
    page,
  }) => {
    const { api, tenant, farah, unitPath, base, invoice } = setup();
    api.currentUserId = tenant.id;
    await api.install(page);

    await page.goto(`${unitPath}/billing`);
    const account = page.getByRole('region', { name: 'Tenancy account' });
    await expect(account).toContainText('Nothing owed');
    await expect(account).toContainText('The owners do not see it.');
    // The owners' invoice is not the tenant's business.
    await expect(page.getByText('No invoices yet.')).toBeVisible();
    await expect(page.getByRole('region', { name: "Owners' account" })).toHaveCount(0);

    const form = page.getByRole('form', { name: 'Report a bank transfer' });
    await form.getByLabel('Amount (PKR)').fill('1200.555');
    await form.getByRole('button', { name: 'Send to finance' }).click();
    await expect(form.getByText('PKR amounts have at most 2 decimals.')).toBeVisible();
    await form.getByLabel('Amount (PKR)').fill('1200');
    await form.getByLabel('Bank reference').fill('IBFT-9');
    await form.getByLabel('Note for finance (optional)').fill('Utilities for this month');
    await form.getByRole('button', { name: 'Send to finance' }).click();
    await expect(page.getByText('is waiting for finance to confirm it')).toBeVisible();

    api.currentUserId = farah.id;
    await page.goto(`${base}/finance/transfers`);
    await expect(page.getByRole('list', { name: 'Bank transfers' })).toContainText(
      'Note: Utilities for this month',
    );
    await page.getByRole('button', { name: 'Reject: PKR 1,200.00 for unit 101' }).click();
    await page.getByRole('button', { name: 'Reject transfer' }).click();
    await expect(page.getByText('Tell the resident why')).toBeVisible();
    await page
      .getByLabel('Reason (shown to the resident)')
      .fill('Not in our account yet; please send the bank slip');
    await page.getByRole('button', { name: 'Reject transfer' }).click();
    await expect(page.getByText('No transfers here.')).toBeVisible();

    api.currentUserId = tenant.id;
    await page.goto(`${unitPath}/billing`);
    const reported = page.getByRole('list', { name: 'Bank transfers you reported' });
    await expect(reported).toContainText('not confirmed');
    await expect(reported).toContainText(
      'Finance: Not in our account yet; please send the bank slip',
    );
    await expectAccessible(page);
    await expectNoHorizontalScroll(page);

    // Someone else's invoice does not exist for this tenant, even by its address.
    await page.goto(`${unitPath}/billing/invoices/${invoice.id}`);
    await expect(page.getByRole('heading', { name: 'Invoice not found' })).toBeVisible();
  });

  test('an owner reads an invoice with its charges', async ({ page }) => {
    const { api, owner, unitPath } = setup();
    api.currentUserId = owner.id;
    await api.install(page);
    await page.goto(`${unitPath}/billing`);
    await page.getByRole('link', { name: 'INV-000001' }).click();
    await expect(page.getByRole('heading', { name: 'Invoice INV-000001', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Summary' })).toContainText('Ana Owner');
    await expect(page.getByRole('group', { name: 'Charges' })).toContainText('Service charge');
    await expectAccessible(page);
    await expectNoHorizontalScroll(page);
  });
});
