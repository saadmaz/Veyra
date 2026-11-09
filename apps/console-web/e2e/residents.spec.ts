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

/** The app's own alerts (Next.js's route announcer also has role=alert). */
const appAlert = (page: Page) => page.locator('.alert[role="alert"]');

/** An organisation with one active property holding unit 101. Names are fictional. */
function setup() {
  const api = new FakeApi();
  const admin = api.addUser('admin@example.test', PASSWORD, 'Ada Admin');
  const org = api.addOrganisation('Harbour Group', admin.id);
  const property = api.addProperty(org.id, 'Harbour View', 'HVR');
  property.status = 'ACTIVE';
  const unit = api.addUnit(property.id, '101');
  return { api, admin, org, property, unit };
}

test.describe('property staff', () => {
  test('adds residents, sets the owner, moves in a tenant and registers a vehicle', async ({
    page,
  }) => {
    const { api, admin, org, property } = setup();
    api.currentUserId = admin.id;
    await api.install(page);

    await page.goto(`/organisations/${org.id}/properties/${property.id}`);
    const residents = page.getByRole('region', { name: 'Residents' });
    await expect(residents).toContainText('No current residents');
    await residents.getByLabel('Full name').fill('Sara Owner');
    await residents.getByLabel('Email (optional)').fill('sara@example.test');
    await residents.getByRole('button', { name: 'Add resident' }).click();
    await expect(page.getByRole('status')).toContainText('Sara Owner was added');
    await residents.getByLabel('Full name').fill('Tariq Tenant');
    await residents.getByLabel('Phone (optional)').fill('0300 123');
    await residents.getByRole('button', { name: 'Add resident' }).click();
    await expect(residents.getByLabel('Phone (optional)')).toHaveAttribute('aria-invalid', 'true');
    await residents.getByLabel('Phone (optional)').fill('+923001234567');
    await residents.getByRole('button', { name: 'Add resident' }).click();
    await expect(page.getByRole('status')).toContainText('Tariq Tenant was added');
    await expectAccessible(page);

    // Unit numbers lead to the unit page.
    await page.getByRole('region', { name: 'Units' }).getByRole('link', { name: '101' }).click();
    await expect(page.getByRole('heading', { name: 'Unit 101', level: 1 })).toBeVisible();
    await expectAccessible(page);

    // Shares must add up to exactly one: the API's message is shown as is.
    const owners = page.getByRole('form', { name: 'Set owners' });
    await owners
      .getByLabel('Owner 1', { exact: true })
      .selectOption({ label: 'Sara Owner (sara@example.test)' });
    await owners.getByLabel('Share of owner 1: denominator').fill('2');
    await owners.getByRole('button', { name: 'Save owners' }).click();
    await expect(appAlert(page)).toContainText('Shares must add up to exactly one');
    await owners.getByLabel('Share of owner 1: denominator').fill('1');
    await owners.getByRole('button', { name: 'Save owners' }).click();
    await expect(page.getByRole('table', { name: 'Ownership history' })).toContainText(
      'Sara Owner',
    );
    await expect(page.getByRole('table', { name: 'Ownership history' })).toContainText('Current');

    const tenancies = page.getByRole('region', { name: 'Tenancies' });
    await tenancies.getByLabel('Primary tenant').selectOption({ label: 'Tariq Tenant' });
    await tenancies.getByRole('button', { name: 'Move in' }).click();
    await expect(tenancies.getByRole('list', { name: 'Tenancies' })).toContainText(
      'Tariq Tenant (primary)',
    );
    // A second overlapping tenancy is refused.
    await tenancies.getByLabel('Primary tenant').selectOption({ label: 'Tariq Tenant' });
    await tenancies.getByRole('button', { name: 'Move in' }).click();
    await expect(appAlert(page)).toContainText('already has a tenancy in that period');

    const vehicles = page.getByRole('region', { name: 'Vehicles' });
    await vehicles.getByLabel('Plate').fill('abc 123');
    await vehicles.getByRole('button', { name: 'Add vehicle' }).click();
    await expect(vehicles.getByRole('list', { name: 'Vehicles' })).toContainText('ABC123');
    await expectAccessible(page);

    // An occupied unit cannot be archived from the property page.
    page.on('dialog', (dialog) => void dialog.accept());
    await page.getByRole('link', { name: 'Harbour View' }).click();
    await page.getByRole('button', { name: 'Archive unit 101' }).click();
    await expect(appAlert(page)).toContainText('still owned, rented or lived in');
    await expect(page.getByRole('list', { name: 'Current residents' })).toContainText(
      'Unit 101: Owner',
    );
  });

  test('edits a profile, adds an emergency contact and invites the resident to the app', async ({
    page,
    context,
  }) => {
    const { api, admin, org, property, unit } = setup();
    const sara = api.addPerson(org.id, 'Sara Owner', 'sara@example.test');
    api.addOwnership(unit.id, sara.id);
    const saraUser = api.addUser('sara@example.test', PASSWORD, 'Sara');
    api.currentUserId = admin.id;
    await api.install(page);

    await page.goto(`/organisations/${org.id}/properties/${property.id}`);
    await page.getByRole('link', { name: 'Sara Owner' }).click();
    await expect(page.getByRole('heading', { name: 'Sara Owner', level: 1 })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Records' })).toContainText('Owner of unit 101');

    await page.getByRole('button', { name: 'Edit details' }).click();
    await page.getByLabel('Phone', { exact: true }).fill('+923001112233');
    await page.getByRole('button', { name: 'Save details' }).click();
    await expect(page.getByRole('region', { name: 'Details' })).toContainText('+923001112233');

    const contacts = page.getByRole('region', { name: 'Emergency contacts' });
    await contacts.getByLabel('Contact name').fill('Bilal Contact');
    await contacts.getByLabel('Contact phone').fill('+923004445566');
    await contacts.getByRole('button', { name: 'Add contact' }).click();
    await expect(contacts.getByRole('list', { name: 'Emergency contacts' })).toContainText(
      'Bilal Contact',
    );
    await expectAccessible(page);

    await page.getByRole('button', { name: 'Invite to the app' }).click();
    const linkField = page.getByLabel('Resident invitation link');
    await expect(linkField).toHaveValue(/\/invitations\/accept#token=[A-Za-z0-9_-]{43}$/);
    const link = await linkField.inputValue();

    // The resident accepts while signed in with the invited address.
    api.currentUserId = saraUser.id;
    const resident = await context.newPage();
    await api.install(resident);
    await resident.goto(link);
    await resident.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(resident.getByRole('status')).toContainText('You joined Harbour Group');
    await expect(resident.getByRole('status')).toContainText('Your role: Resident');
    await resident.getByRole('link', { name: 'Open organisation' }).click();
    await expect(resident.getByRole('region', { name: 'Your homes' })).toContainText('Unit 101');
  });
});

test.describe('residents', () => {
  test('a resident sees their home and who lives there, with no staff controls', async ({
    page,
  }) => {
    const { api, org, property, unit } = setup();
    const residentUser = api.addUser('rida@example.test', PASSWORD, 'Rida');
    const rida = api.addPerson(org.id, 'Rida Resident', 'rida@example.test', residentUser.id);
    const zain = api.addPerson(org.id, 'Zain Resident');
    api.addOwnership(unit.id, rida.id);
    api.addHouseholdMember(unit.id, zain.id);
    api.currentUserId = residentUser.id;
    await api.install(page);

    await page.goto('/organisations');
    await expect(page.getByRole('list', { name: 'Organisations' })).toContainText('Owner');
    await page.goto(`/organisations/${org.id}`);
    const homes = page.getByRole('region', { name: 'Your homes' });
    await expect(homes).toContainText('Harbour View');
    await expect(page.getByRole('region', { name: 'Properties' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Members' })).toHaveCount(0);
    await expectAccessible(page);

    await homes.getByRole('link', { name: 'Unit 101' }).click();
    await expect(page.getByRole('heading', { name: 'Unit 101', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'About this unit' })).toContainText('Owner');
    const who = page.getByRole('list', { name: 'Current residents' });
    await expect(who).toContainText('Rida Resident');
    await expect(who).toContainText('Owner (1/1)');
    await expect(who).toContainText('Zain Resident');
    await expect(page.getByRole('region', { name: 'Owners' })).toHaveCount(0);
    await expect(page.getByRole('form', { name: 'Set owners' })).toHaveCount(0);
    await expectAccessible(page);

    // The property itself stays closed to residents.
    await page.goto(`/organisations/${org.id}/properties/${property.id}`);
    await expect(page.getByRole('heading', { name: 'Property not found' })).toBeVisible();
  });

  test('a household member sees the unit but not who lives there', async ({ page }) => {
    const { api, org, property, unit } = setup();
    const user = api.addUser('zain@example.test', PASSWORD, 'Zain');
    const zain = api.addPerson(org.id, 'Zain Resident', 'zain@example.test', user.id);
    api.addHouseholdMember(unit.id, zain.id);
    api.currentUserId = user.id;
    await api.install(page);

    await page.goto(`/organisations/${org.id}/properties/${property.id}/units/${unit.id}`);
    await expect(page.getByRole('heading', { name: 'Unit 101', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'About this unit' })).toContainText(
      'Household member',
    );
    await expect(page.getByRole('region', { name: 'Who lives here' })).toHaveCount(0);
    expect(api.log).not.toContain(
      `GET /organisations/${org.id}/properties/${property.id}/units/${unit.id}/residents`,
    );
  });

  test('a finance officer sees no resident information', async ({ page }) => {
    const { api, org, property, unit } = setup();
    const sara = api.addPerson(org.id, 'Sara Owner');
    api.addOwnership(unit.id, sara.id);
    const finance = api.addUser('fin@example.test', PASSWORD, 'Farah Finance');
    api.addMembership(org.id, finance.id, 'FINANCE_OFFICER');
    api.currentUserId = finance.id;
    await api.install(page);

    await page.goto(`/organisations/${org.id}/properties/${property.id}`);
    await expect(page.getByRole('heading', { name: 'Harbour View', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Units' })).toContainText('101');
    await expect(page.getByRole('region', { name: 'Residents' })).toHaveCount(0);

    await page.getByRole('region', { name: 'Units' }).getByRole('link', { name: '101' }).click();
    await expect(page.getByRole('heading', { name: 'Unit 101', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Owners' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Who lives here' })).toHaveCount(0);
    await expect(page.getByText('Sara Owner')).toHaveCount(0);
  });
});
