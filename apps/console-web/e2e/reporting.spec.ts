import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { FakeApi } from './fake-api';

/*
 * Dashboards, exports and webhooks (Phase 12): a property manager sees every area's figures and
 * downloads an export (recorded); a guard sees only their areas and no exports; an organisation
 * admin connects a webhook endpoint, copies the secret shown once, sends a test and disables it.
 * The API's own tests prove the rules; these prove the screens.
 */

const PASSWORD = 'correct horse battery staple';

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

function setup() {
  const api = new FakeApi();
  const admin = api.addUser('admin@example.test', PASSWORD, 'Ada Admin');
  const org = api.addOrganisation('Harbour Group', admin.id);
  const property = api.addProperty(org.id, 'Harbour View', 'HVR');
  api.addUnit(property.id, '101');
  api.addUnit(property.id, '102');
  const manager = api.addUser('pam@example.test', PASSWORD, 'Pam Manager');
  api.addMembership(org.id, manager.id, 'PROPERTY_MANAGER', property.id);
  const guard = api.addUser('gus@example.test', PASSWORD, 'Gus Guard');
  api.addMembership(org.id, guard.id, 'SECURITY_GUARD', property.id);
  return {
    api,
    admin,
    manager,
    guard,
    org,
    base: `/organisations/${org.id}/properties/${property.id}`,
  };
}

test.describe('dashboards, exports and webhooks', () => {
  test('a manager sees the figures and downloads an export', async ({ page }) => {
    const { api, manager, base } = setup();
    api.currentUserId = manager.id;
    await api.install(page);

    await page.goto(base);
    const finance = page.getByRole('region', { name: 'Finance figures' });
    await expect(finance).toContainText('Overdue invoices');
    await expect(finance).toContainText('3');
    await expect(page.getByRole('region', { name: 'Occupancy figures' })).toContainText('2');
    await expect(page.getByRole('region', { name: 'Incidents figures' })).toBeVisible();

    const exports = page.getByRole('form', { name: 'Download an export' });
    await exports.getByLabel('Report').selectOption('occupancy-by-building');
    const download = page.waitForEvent('download');
    await exports.getByRole('button', { name: 'Download CSV' }).click();
    expect((await download).suggestedFilename()).toMatch(/^HVR-occupancy-by-building-.*\.csv$/);
    expect(api.reporting.exported).toEqual([
      { report: 'occupancy-by-building', userId: manager.id },
    ]);
    await expectAccessible(page);
  });

  test('a guard sees only their areas and no exports', async ({ page }) => {
    const { api, guard, base } = setup();
    api.currentUserId = guard.id;
    await api.install(page);

    await page.goto(base);
    await expect(page.getByRole('region', { name: 'Incidents figures' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Finance figures' })).toHaveCount(0);
    await expect(page.getByRole('form', { name: 'Download an export' })).toHaveCount(0);
  });

  test('an organisation admin connects a webhook endpoint', async ({ page }) => {
    const { api, admin, org } = setup();
    api.currentUserId = admin.id;
    await api.install(page);

    await page.goto(`/organisations/${org.id}`);
    await page.getByRole('link', { name: 'Webhooks' }).click();
    const form = page.getByRole('form', { name: 'Add an endpoint' });
    await form.getByLabel('URL (HTTPS)').fill('https://hooks.example.test/veyra');
    await form.getByLabel('An incident is reported').check();
    await form.getByRole('button', { name: 'Add endpoint' }).click();
    await expect(page.getByText('Copy the signing secret now')).toBeVisible();
    await expect(page.getByText(/whsec_/)).toBeVisible();

    const endpoint = page.getByRole('article', { name: 'https://hooks.example.test/veyra' });
    await endpoint.getByRole('button', { name: 'Send a test' }).click();
    await endpoint.getByRole('button', { name: 'Show deliveries' }).click();
    await expect(endpoint.getByRole('list', { name: /Deliveries to/ })).toContainText('succeeded');
    await endpoint.getByRole('button', { name: 'Disable' }).click();
    await expect(endpoint.getByRole('button', { name: 'Enable' })).toBeVisible();
    await expect(endpoint.getByRole('button', { name: 'Send a test' })).toHaveCount(0);
    await expectAccessible(page);
  });
});
