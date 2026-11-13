import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { FakeApi } from './fake-api';

/*
 * Communications (Phase 10): a property manager publishes an urgent announcement that asks to be
 * acknowledged; a tenant finds it in their inbox and confirms they read it, and the manager sees
 * the figures; the tenant reads the documents meant for their home (not the owners' ones). The
 * API's own tests prove the rules; these prove the screens.
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
  const unit = api.addUnit(property.id, '101');
  const tia = api.addPerson(org.id, 'Tia Tenant', 'tia@example.test');
  api.addTenancy(unit.id, tia, '2026-01-01');
  const tenant = api.addUser('tia@example.test', PASSWORD, 'Tia Tenant');
  api.linkPerson(tia.id, tenant.id);
  const manager = api.addUser('pam@example.test', PASSWORD, 'Pam Manager');
  api.addMembership(org.id, manager.id, 'PROPERTY_MANAGER', property.id);
  api.comms.addDocument(property.id, 'House rules', 'EVERYONE');
  api.comms.addDocument(property.id, 'AGM minutes', 'OWNERS');
  const base = `/organisations/${org.id}/properties/${property.id}`;
  return { api, tenant, manager, org, base, unitPath: `${base}/units/${unit.id}` };
}

test.describe('communications', () => {
  test('an urgent announcement reaches the tenant, who acknowledges it', async ({ page }) => {
    const { api, tenant, manager, org, base } = setup();
    api.currentUserId = manager.id;
    await api.install(page);

    await page.goto(base);
    await page.getByRole('main').getByRole('link', { name: 'Announcements' }).click();
    await expect(page.getByRole('heading', { name: 'Announcements', level: 1 })).toBeVisible();
    const compose = page.getByRole('form', { name: 'New announcement' });
    await compose.getByLabel('Title').fill('Water off on Friday');
    await compose.getByLabel('Message').fill('From 10:00 to 14:00 for pump repairs.');
    await compose.getByLabel('Urgent (also sent by email)').check();
    await compose.getByLabel('Ask people to confirm they have read it').check();
    await compose.getByRole('button', { name: 'Publish now' }).click();
    await expect(page.getByText('Published to 1 people.')).toBeVisible();
    await expectAccessible(page);

    api.currentUserId = tenant.id;
    await page.goto(`/organisations/${org.id}`);
    await page.getByRole('link', { name: 'Open inbox' }).click();
    const item = page.getByRole('article', { name: 'Water off on Friday' });
    await expect(item.getByText('urgent')).toBeVisible();
    await expect(item.getByText('From 10:00 to 14:00 for pump repairs.')).toBeVisible();
    await item.getByRole('button', { name: 'I have read this' }).click();
    await expect(item.getByText(/acknowledged/)).toBeVisible();
    await expectAccessible(page);

    api.currentUserId = manager.id;
    await page.goto(`${base}/announcements`);
    await expect(page.getByText(/reached 1, read by 1, acknowledged by 1/)).toBeVisible();
  });

  test("a tenant reads the documents for their home, not the owners' ones", async ({ page }) => {
    const { api, tenant, unitPath } = setup();
    api.currentUserId = tenant.id;
    await api.install(page);

    await page.goto(unitPath);
    await page.getByRole('link', { name: 'Read documents' }).click();
    await expect(page.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible();
    const list = page.getByRole('list', { name: 'Documents' });
    await expect(list.getByText('House rules', { exact: false }).first()).toBeVisible();
    await expect(list.getByText('AGM minutes')).toHaveCount(0);
    await expect(list.getByRole('button', { name: 'Open' })).toBeVisible();
    await expectAccessible(page);
  });
});
