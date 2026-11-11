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

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());

function setup() {
  const api = new FakeApi();
  const admin = api.addUser('admin@example.test', PASSWORD, 'Ada Admin');
  const org = api.addOrganisation('Harbour Group', admin.id);
  const property = api.addProperty(org.id, 'Harbour View', 'HVR');
  const unit = api.addUnit(property.id, '101');
  const unitUrl = `/organisations/${org.id}/properties/${property.id}/units/${unit.id}`;
  return { api, admin, org, property, unit, unitUrl };
}

/** Adds a person through the unit page's "Add a person" card. */
async function addPerson(page: Page, fullName: string, email?: string) {
  const card = page.getByRole('region', { name: 'Add a person' });
  await card.getByLabel('Full name').fill(fullName);
  if (email) await card.getByLabel('Email (optional)').fill(email);
  await card.getByRole('button', { name: 'Add person' }).click();
  await expect(card.getByText(`${fullName} was added`)).toBeVisible();
}

test.describe('organisation admin', () => {
  test('records owners, a tenant, household and a vehicle on a unit', async ({ page }) => {
    const { api, admin, org, property } = setup();
    api.currentUserId = admin.id;
    await api.install(page);

    await page.goto(`/organisations/${org.id}/properties/${property.id}`);
    await page.getByRole('link', { name: 'Unit 101' }).click();
    await expect(page.getByRole('heading', { name: 'Unit 101', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Owners' })).toContainText(
      'No owners recorded yet',
    );
    await expectAccessible(page);

    await addPerson(page, 'Ana Owner', 'ana@example.test');
    await addPerson(page, 'Ben Owner');

    // Two owners whose shares do not add up: refused before anything is sent.
    const owners = page.getByRole('region', { name: 'Owners' });
    await owners.getByRole('button', { name: 'Add another owner' }).click();
    await owners.getByLabel('Owner 1', { exact: true }).selectOption({ label: 'Ana Owner' });
    await owners.getByLabel('Share of owner 1').fill('1/2');
    await owners.getByLabel('Owner 2', { exact: true }).selectOption({ label: 'Ben Owner' });
    await owners.getByLabel('Share of owner 2').fill('1/3');
    await owners.getByRole('button', { name: 'Record owners' }).click();
    await expect(appAlert(page)).toContainText('Shares must add up to exactly one');
    expect(api.log.some((line) => line.endsWith('/owners'))).toBe(false);

    await owners.getByLabel('Share of owner 2').fill('1/2');
    await owners.getByRole('button', { name: 'Record owners' }).click();
    const history = owners.getByRole('list', { name: 'Ownership history' });
    await expect(history).toContainText('Ana Owner');
    await expect(history).toContainText('Ben Owner');
    await expect(history).toContainText('(1/2)');
    await expect(history.getByText('current', { exact: true })).toBeVisible();

    // Move-in.
    await addPerson(page, 'Tia Tenant');
    const tenancies = page.getByRole('region', { name: 'Tenancies' });
    await tenancies.getByLabel('Primary tenant').selectOption({ label: 'Tia Tenant' });
    await tenancies.getByRole('button', { name: 'Record move-in' }).click();
    await expect(tenancies.getByRole('list', { name: 'Tenancy history' })).toContainText(
      'Tia Tenant (primary)',
    );

    // Household.
    await addPerson(page, 'Kit Child');
    const household = page.getByRole('region', { name: 'Household members' });
    await household
      .getByLabel('Household member', { exact: true })
      .selectOption({ label: 'Kit Child' });
    await household.getByLabel('Relationship').selectOption({ label: 'Child' });
    await household.getByRole('button', { name: 'Add household member' }).click();
    await expect(household.getByRole('list', { name: 'Household members' })).toContainText('Child');

    // Vehicle: the plate is normalised by the API.
    const vehicles = page.getByRole('region', { name: 'Vehicles' });
    await vehicles.getByLabel('Number plate').fill('abc 123');
    await vehicles.getByLabel('Colour (optional)').fill('Blue');
    await vehicles.getByRole('button', { name: 'Add vehicle' }).click();
    await expect(vehicles.getByRole('list', { name: 'Vehicles' })).toContainText('ABC123');
    await expectAccessible(page);
    await expectNoHorizontalScroll(page);

    // The property's resident list shows everyone with their role on the unit.
    await page.getByRole('link', { name: 'Harbour View' }).click();
    await page.getByRole('link', { name: 'View residents' }).click();
    await expect(page.getByRole('heading', { name: 'Residents', level: 1 })).toBeVisible();
    const table = page.getByRole('table');
    await expect(table.getByRole('row', { name: /Ana Owner/ })).toContainText('101 (Owner)');
    await expect(table.getByRole('row', { name: /Tia Tenant/ })).toContainText('(Tenant)');
    await expect(table.getByRole('row', { name: /Kit Child/ })).toContainText('(Household member)');
    await expectAccessible(page);
    await expectNoHorizontalScroll(page);
  });

  test('manages a resident profile, emergency contacts and app invitation', async ({ page }) => {
    const { api, admin, org, property, unit } = setup();
    const ana = api.addPerson(org.id, 'Ana Owner', 'ana@example.test');
    api.addOwnership(unit.id, ana, '2026-01-01');
    api.currentUserId = admin.id;
    page.on('dialog', (dialog) => void dialog.accept());
    await api.install(page);

    await page.goto(`/organisations/${org.id}/properties/${property.id}/residents`);
    await page.getByRole('link', { name: 'Ana Owner' }).click();
    await expect(page.getByRole('heading', { name: 'Ana Owner', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Units and records' })).toContainText(
      'Owner (Share: Whole unit)',
    );

    // Edit: only changed fields are sent.
    const profile = page.getByRole('region', { name: 'Profile' });
    await profile.getByRole('button', { name: 'Edit profile' }).click();
    await profile.getByLabel('Phone').fill('+92 300 1234567');
    await profile.getByLabel('Language').fill('ur-PK');
    await profile.getByRole('button', { name: 'Save profile' }).click();
    await expect(profile.getByText('Profile saved.')).toBeVisible();
    await expect(profile).toContainText('ur-PK');

    const contacts = page.getByRole('region', { name: 'Emergency contacts' });
    await contacts.getByLabel('Contact name').fill('Eve Contact');
    await contacts.getByLabel('Contact phone').fill('+923009876543');
    await contacts.getByLabel('Relationship (optional)').fill('Sister');
    await contacts.getByRole('button', { name: 'Add contact' }).click();
    await expect(contacts.getByRole('list', { name: 'Emergency contacts' })).toContainText(
      'Sister · +923009876543',
    );
    await contacts.getByRole('button', { name: 'Remove emergency contact Eve Contact' }).click();
    await expect(contacts.getByText('No emergency contacts.')).toBeVisible();
    expect(api.log).toContainEqual(expect.stringMatching(/^DELETE .*\/emergency-contacts\//));

    const access = page.getByRole('region', { name: 'App access' });
    await access.getByRole('button', { name: 'Create invitation link' }).click();
    await expect(access.getByLabel('Resident invitation link')).toHaveValue(
      /#token=[A-Za-z0-9_-]{43}$/,
    );
    await expectAccessible(page);
    await expectNoHorizontalScroll(page);
  });

  test('records a move-out, voids mistakes and shows the API refusing a backdated transfer', async ({
    page,
  }) => {
    const { api, admin, org, unit, unitUrl } = setup();
    const ana = api.addPerson(org.id, 'Ana Owner');
    const tia = api.addPerson(org.id, 'Tia Tenant');
    api.addOwnership(unit.id, ana, '2026-01-01');
    api.addTenancy(unit.id, tia, '2026-02-01');
    api.currentUserId = admin.id;
    // Void asks for a reason (prompt); other dialogs are confirmations.
    page.on(
      'dialog',
      (dialog) =>
        void (dialog.type() === 'prompt' ? dialog.accept('Entered by mistake') : dialog.accept()),
    );
    await api.install(page);
    await page.goto(unitUrl);

    // Move-out on today's date: the end date is inclusive, so the tenancy is still current.
    const tenancies = page.getByRole('region', { name: 'Tenancies' });
    await tenancies.getByLabel('Last day of the tenancy').fill(today());
    await tenancies.getByRole('button', { name: 'Record move-out of Tia Tenant' }).click();
    await expect(tenancies.getByRole('list', { name: 'Tenancy history' })).toContainText(' to ');
    expect(api.tenancies[0]?.endDate).toBe(today());

    await tenancies.getByRole('button', { name: 'Void tenancy of Tia Tenant' }).click();
    await expect(tenancies.getByText('voided', { exact: true })).toBeVisible();
    await expect(tenancies).toContainText('Voided: Entered by mistake');
    await expect(tenancies.getByRole('button', { name: /Record move-out/ })).toHaveCount(0);

    // A transfer dated before the current owners started is refused by the API.
    const owners = page.getByRole('region', { name: 'Owners' });
    await owners.getByLabel('Owners from', { exact: true }).fill('2025-06-01');
    await owners.getByLabel('Owner', { exact: true }).selectOption({ label: 'Ana Owner' });
    await owners.getByRole('button', { name: 'Record owners' }).click();
    await expect(appAlert(page)).toContainText('Owners are already recorded from this date');

    await owners.getByRole('button', { name: 'Void owners from 1 Jan 2026' }).click();
    await expect(owners.getByText('voided', { exact: true })).toBeVisible();
    expect(api.ownerships[0]?.voidReason).toBe('Entered by mistake');
  });
});

test.describe('scoped roles', () => {
  test('a property manager manages residents of their property only', async ({ page }) => {
    const { api, org, property, unitUrl } = setup();
    const other = api.addProperty(org.id, 'Lakeside', 'LKS');
    const otherUnit = api.addUnit(other.id, '9');
    const manager = api.addUser('pm@example.test', PASSWORD, 'Pat Manager');
    api.addMembership(org.id, manager.id, 'PROPERTY_MANAGER', property.id);
    api.currentUserId = manager.id;
    await api.install(page);

    await page.goto(unitUrl);
    await expect(page.getByRole('button', { name: 'Record owners' })).toBeVisible();
    await addPerson(page, 'Ana Owner');

    await page.goto(`/organisations/${org.id}/properties/${other.id}/units/${otherUnit.id}`);
    await expect(page.getByRole('heading', { name: 'Unit not found' })).toBeVisible();
  });

  test('a finance officer sees unit details but no resident data', async ({ page }) => {
    const { api, org, property, unit, unitUrl } = setup();
    api.addOwnership(unit.id, api.addPerson(org.id, 'Ana Owner'), '2026-01-01');
    const finance = api.addUser('fin@example.test', PASSWORD, 'Farah Finance');
    api.addMembership(org.id, finance.id, 'FINANCE_OFFICER');
    api.currentUserId = finance.id;
    await api.install(page);

    await page.goto(unitUrl);
    await expect(page.getByRole('heading', { name: 'Unit 101', level: 1 })).toBeVisible();
    await expect(page.getByText('Resident details are not available to your role')).toBeVisible();
    await expect(page.getByText('Ana Owner')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Record|Add|Void/ })).toHaveCount(0);

    await page.goto(`/organisations/${org.id}/properties/${property.id}/residents`);
    await expect(page.getByRole('heading', { name: 'You cannot view residents' })).toBeVisible();
    await expectAccessible(page);
    // Resident data was never requested, not merely hidden.
    expect(
      api.log.filter((line) => /\/(residents|ownerships|persons|vehicles)/.test(line)),
    ).toEqual([]);
  });

  test('an archived unit keeps its records visible but read-only', async ({ page }) => {
    const { api, admin, org, unit, unitUrl } = setup();
    api.addOwnership(unit.id, api.addPerson(org.id, 'Ana Owner'), '2026-01-01');
    unit.status = 'ARCHIVED';
    api.currentUserId = admin.id;
    await api.install(page);

    await page.goto(unitUrl);
    await expect(page.getByText('This unit is archived.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Owners' })).toContainText('Ana Owner');
    await expect(page.getByRole('button', { name: /Record|Add|Void|Archive/ })).toHaveCount(0);
  });
});
