import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { FakeApi } from './fake-api';

const PASSWORD = 'correct horse battery staple';

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

/** The app's own alerts (Next.js's route announcer also has role=alert). */
const appAlert = (page: Page) => page.locator('.alert[role="alert"]');

function setup() {
  const api = new FakeApi();
  const admin = api.addUser('admin@example.test', PASSWORD, 'Ada Admin');
  const org = api.addOrganisation('Harbour Group', admin.id);
  return { api, admin, org };
}

test.describe('organisation admin', () => {
  test('adds a property, builds its structure and activates it', async ({ page }) => {
    const { api, admin, org } = setup();
    api.currentUserId = admin.id;
    // Accept every confirmation dialog (archive buttons).
    page.on('dialog', (dialog) => void dialog.accept());
    await api.install(page);

    await page.goto(`/organisations/${org.id}`);
    await expect(page.getByRole('region', { name: 'Properties' })).toContainText(
      'No properties yet',
    );
    await page.getByRole('link', { name: 'Add property' }).click();

    await page.getByLabel('Property name').fill('Harbour View');
    await page.getByLabel('Property code').fill('hvr');
    await page.getByLabel('Address line 1', { exact: true }).fill('1 Shore Road');
    await page.getByLabel('City').fill('Karachi');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Add property' }).click();

    await expect(page.getByRole('heading', { name: 'Harbour View', level: 1 })).toBeVisible();
    await expect(page.getByText('This property is being set up.')).toBeVisible();

    const buildings = page.getByRole('region', { name: 'Buildings' });
    await buildings.getByLabel('Building name').fill('Tower A');
    await buildings.getByLabel('Building code').fill('A');
    await buildings.getByRole('button', { name: 'Add building' }).click();
    await expect(buildings.getByRole('link', { name: 'Tower A' })).toBeVisible();
    await expectAccessible(page);

    // Floors and units live on the building page.
    await buildings.getByRole('link', { name: 'Tower A' }).click();
    await expect(page.getByRole('heading', { name: 'Tower A', level: 1 })).toBeVisible();
    const floors = page.getByRole('region', { name: 'Floors' });
    await floors.getByLabel('Level').fill('1');
    await floors.getByLabel('Floor name').fill('First');
    await floors.getByRole('button', { name: 'Add floor' }).click();
    await expect(floors.getByText('Level 1')).toBeVisible();

    const units = page.getByRole('region', { name: 'Units in this building' });
    await units.getByLabel('Unit number').fill('101');
    await units.getByLabel('Floor').selectOption({ label: 'First (level 1)' });
    await units.getByLabel('Area in m² (optional)').fill('85.5');
    await units.getByRole('button', { name: 'Add unit' }).click();
    await expect(units.getByRole('table')).toContainText('85.50');
    await expectAccessible(page);

    // Back on the property: a building with active units cannot be archived.
    await page.getByRole('link', { name: 'Harbour View' }).click();
    await page
      .getByRole('region', { name: 'Buildings' })
      .getByRole('button', { name: 'Archive' })
      .click();
    await expect(appAlert(page)).toContainText('still has active units');
    await expect(page.getByRole('region', { name: 'Units' }).getByRole('table')).toContainText(
      'Tower A',
    );

    await page.getByRole('button', { name: 'Activate property' }).click();
    // The badge text is lower case in the DOM (capitalised by CSS).
    await expect(page.getByText('active', { exact: true })).toBeVisible();
    await expect(page.getByText('This property is being set up.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Activate property' })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test('invites a property manager for one property and gets a one-time link', async ({ page }) => {
    const { api, admin, org } = setup();
    const property = api.addProperty(org.id, 'Harbour View', 'HVR');
    api.currentUserId = admin.id;
    await api.install(page);

    await page.goto(`/organisations/${org.id}/properties/${property.id}`);
    const card = page.getByRole('region', { name: 'Property managers' });
    await card.getByLabel("Manager's email").fill('pm@example.test');
    await card.getByRole('button', { name: 'Invite manager' }).click();
    await expect(card.getByLabel('Manager invitation link')).toHaveValue(
      /#token=[A-Za-z0-9_-]{43}$/,
    );
    expect(api.invitations[0]).toMatchObject({ role: 'PROPERTY_MANAGER', propertyId: property.id });
  });

  test('archiving a property freezes it after confirmation', async ({ page }) => {
    const { api, admin, org } = setup();
    const property = api.addProperty(org.id, 'Old Block', 'OLD');
    api.currentUserId = admin.id;
    page.on('dialog', (dialog) => void dialog.accept());
    await api.install(page);

    await page.goto(`/organisations/${org.id}/properties/${property.id}`);
    await page.getByRole('button', { name: 'Archive property' }).click();
    await expect(page.getByText('This property is archived.')).toBeVisible();
    // Write controls disappear because the API's permissions no longer include them.
    await expect(page.getByRole('button', { name: 'Add building' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Archive property' })).toHaveCount(0);
  });
});

test.describe('scoped roles', () => {
  test('a property manager sees only their property and cannot change its lifecycle', async ({
    page,
  }) => {
    const { api, org } = setup();
    const mine = api.addProperty(org.id, 'Harbour View', 'HVR');
    const other = api.addProperty(org.id, 'Lakeside', 'LKS');
    const manager = api.addUser('pm@example.test', PASSWORD, 'Pat Manager');
    api.addMembership(org.id, manager.id, 'PROPERTY_MANAGER', mine.id);
    api.currentUserId = manager.id;
    await api.install(page);

    await page.goto(`/organisations/${org.id}`);
    const list = page.getByRole('list', { name: 'Properties' });
    await expect(list).toContainText('Harbour View');
    await expect(list).not.toContainText('Lakeside');
    await expect(page.getByRole('link', { name: 'Add property' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Members' })).toHaveCount(0);

    await list.getByRole('link', { name: 'Harbour View' }).click();
    await expect(page.getByRole('button', { name: 'Add building' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Activate property' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Property managers' })).toHaveCount(0);

    await page.goto(`/organisations/${org.id}/properties/${other.id}`);
    await expect(page.getByRole('heading', { name: 'Property not found' })).toBeVisible();
  });

  test('a finance officer can read the structure but sees no change controls', async ({ page }) => {
    const { api, org } = setup();
    const property = api.addProperty(org.id, 'Harbour View', 'HVR');
    const finance = api.addUser('fin@example.test', PASSWORD, 'Farah Finance');
    api.addMembership(org.id, finance.id, 'FINANCE_OFFICER');
    api.buildings.push({
      id: crypto.randomUUID(),
      propertyId: property.id,
      name: 'Tower A',
      code: 'A',
      status: 'ACTIVE',
      archivedAt: null,
      createdAt: new Date().toISOString(),
    });
    api.currentUserId = finance.id;
    await api.install(page);

    await page.goto(`/organisations/${org.id}/properties/${property.id}`);
    await expect(page.getByRole('link', { name: 'Tower A' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Add|Archive|Activate/ })).toHaveCount(0);
    await expectAccessible(page);
  });
});
