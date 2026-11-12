import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { FakeApi } from './fake-api';

/*
 * Plan and support access (Phase 13): an organisation admin sees the plan, its limits and what it
 * includes; approves a support request from VEYRA staff and ends it; a property manager does not
 * see the page. The API's own tests prove the rules; these prove the screens.
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
  const manager = api.addUser('pam@example.test', PASSWORD, 'Pam Manager');
  api.addMembership(org.id, manager.id, 'PROPERTY_MANAGER', property.id);
  return { api, admin, manager, org };
}

test.describe('plan and support access', () => {
  test('an admin sees the plan and decides support access', async ({ page }) => {
    const { api, admin, org } = setup();
    api.platform.askForSupport(org, 'A resident cannot see their invoice', 2);
    api.currentUserId = admin.id;
    await api.install(page);

    await page.goto(`/organisations/${org.id}`);
    await page.getByRole('link', { name: 'Plan and support' }).click();
    await expect(page.getByRole('heading', { name: 'Enterprise plan' })).toBeVisible();
    await expect(page.getByText(/Trial until/)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Included features' })).toContainText('Webhooks');

    const request = page.getByRole('article', { name: 'Request from Sam from VEYRA' });
    await expect(request).toContainText('A resident cannot see their invoice');
    await request.getByRole('button', { name: 'Approve' }).click();
    await expect(request).toContainText('open');
    await expect(request).toContainText('approved by Ada Admin');
    await request.getByRole('button', { name: 'End access now' }).click();
    await expect(request).toContainText('revoked');
    await expect(request.getByRole('button')).toHaveCount(0);
    await expectAccessible(page);
  });

  test('a property manager does not see the page', async ({ page }) => {
    const { api, manager, org } = setup();
    api.currentUserId = manager.id;
    await api.install(page);
    await page.goto(`/organisations/${org.id}/plan`);
    await expect(page.getByText('For organisation admins')).toBeVisible();
  });
});
