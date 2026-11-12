import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { FakeApi } from './fake-api';

/*
 * Maintenance (Phase 7): a resident reports a problem with a photo; the maintenance manager
 * accepts it and gives the work to a technician; the technician does it, records a cost and
 * finishes; the manager marks it done; the resident confirms. Plus targets, role limits and a file
 * that is not what it claims. The API's own tests prove the rules; these prove the screens.
 */

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

const PNG = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...new Array(200).fill(1),
]);

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
  const manager = api.addUser('mia@example.test', PASSWORD, 'Mia Manager');
  api.addMembership(org.id, manager.id, 'MAINTENANCE_MANAGER', property.id);
  const tech = api.addUser('theo@example.test', PASSWORD, 'Theo Technician');
  api.addMembership(org.id, tech.id, 'TECHNICIAN', property.id);
  const base = `/organisations/${org.id}/properties/${property.id}`;
  return { api, tenant, manager, tech, base, unitPath: `${base}/units/${unit.id}` };
}

test.describe('maintenance', () => {
  test('a problem goes from the resident to the technician and back, with a photo and a cost', async ({
    page,
  }) => {
    const { api, tenant, manager, tech, base, unitPath } = setup();
    api.currentUserId = tenant.id;
    await api.install(page);

    // The resident reports it and adds a photo.
    await page.goto(unitPath);
    await page.getByRole('link', { name: 'Report or follow a problem' }).click();
    await expect(page.getByRole('heading', { name: 'Maintenance', level: 1 })).toBeVisible();
    const report = page.getByRole('form', { name: 'Report a problem' });
    await report.getByRole('button', { name: 'Send report' }).click();
    await expect(report.getByText('Say in a few words what is wrong.')).toBeVisible();
    await report.getByLabel('In a few words').fill('Kitchen tap leaks');
    await report.getByLabel('What is wrong').fill('Drips all night.\nThe cupboard is wet.');
    await report.getByLabel('Where exactly (optional)').fill('Kitchen');
    await report.getByRole('button', { name: 'Send report' }).click();
    await expect(page.getByRole('heading', { name: 'Kitchen tap leaks', level: 1 })).toBeVisible();
    await expect(page.getByText('MR-000001')).toBeVisible();
    const upload = page.getByRole('form', { name: 'Add a file' });
    await upload
      .getByLabel('Photo or PDF')
      .setInputFiles({ name: 'tap.png', mimeType: 'image/png', buffer: PNG });
    await upload.getByRole('button', { name: 'Upload' }).click();
    await expect(page.getByText('tap.png was added.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Photos and files' })).toContainText('tap.png');
    await expectAccessible(page);
    await expectNoHorizontalScroll(page);

    // The manager accepts it, tells the resident, and gives the work to the technician.
    api.currentUserId = manager.id;
    await page.goto(base);
    await page.getByRole('link', { name: 'Open maintenance' }).click();
    await expect(page.getByRole('group', { name: 'Queue' })).toContainText('Kitchen tap leaks');
    await expectAccessible(page);
    await page.getByRole('link', { name: 'Kitchen tap leaks' }).click();
    const accept = page.getByRole('form', { name: 'Accept' });
    await accept.getByLabel('Priority').selectOption('HIGH');
    await accept.getByLabel('Message to the resident (optional)').fill('A plumber comes tomorrow');
    await accept.getByRole('button', { name: 'Accept' }).click();
    await expect(page.getByText('in hand').first()).toBeVisible();
    const work = page.getByRole('form', { name: 'New work order' });
    await work.getByLabel('Give it to').selectOption({ label: 'Theo Technician' });
    await work.getByRole('button', { name: 'Create work order' }).click();
    await expect(page.getByRole('heading', { name: 'WO-000001: Kitchen tap leaks' })).toBeVisible();
    await expectAccessible(page);

    // The technician sees only their work, does it, records a cost and finishes.
    api.currentUserId = tech.id;
    await page.goto(base);
    await page.getByRole('link', { name: 'My work' }).click();
    await page.getByRole('link', { name: 'Kitchen tap leaks' }).click();
    await page.getByRole('button', { name: 'Start work' }).click();
    await expect(page.getByText('in progress').first()).toBeVisible();
    const cost = page.getByRole('form', { name: 'Record a cost' });
    await cost.getByLabel('What').fill('Washer and seal');
    await cost.getByLabel('Amount (PKR)').fill('1,250');
    await cost.getByRole('button', { name: 'Record cost' }).click();
    await expect(page.getByRole('group', { name: 'Costs' })).toContainText('PKR 1,250.00');
    const after = page.getByRole('form', { name: 'Add a file' });
    await after
      .getByLabel('Photo or PDF')
      .setInputFiles({ name: 'fixed.png', mimeType: 'image/png', buffer: PNG });
    await after.getByLabel('This is').selectOption('AFTER');
    await after.getByLabel('Who sees it').selectOption('RESIDENT');
    await after.getByRole('button', { name: 'Upload' }).click();
    await expect(page.getByText('fixed.png was added.')).toBeVisible();
    await page.getByRole('button', { name: 'Finish' }).click();
    await page.getByLabel('What was done').fill('Replaced the washer');
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByText('completed').first()).toBeVisible();
    await expectAccessible(page);
    await expectNoHorizontalScroll(page);

    // The manager marks the request done.
    api.currentUserId = manager.id;
    await page.goto(`${base}/maintenance`);
    await page.getByRole('link', { name: 'Kitchen tap leaks' }).click();
    await page.getByRole('button', { name: 'Mark as done' }).click();
    await page.getByLabel('Message to the resident (optional)').fill('Please check and confirm');
    await page.getByRole('button', { name: 'Mark as done' }).click();
    await expect(page.getByText('done, to confirm').first()).toBeVisible();

    // The resident sees the updates and the after photo (not internal notes) and confirms.
    api.currentUserId = tenant.id;
    await page.goto(`${unitPath}/maintenance`);
    await page.getByRole('link', { name: 'Kitchen tap leaks' }).click();
    const history = page.getByRole('list', { name: 'History' });
    await expect(history).toContainText('A plumber comes tomorrow');
    await expect(history).toContainText('Please check and confirm');
    await expect(history).not.toContainText('WO-000001');
    await expect(page.getByRole('list', { name: 'Photos and files' })).toContainText('fixed.png');
    await page.getByRole('button', { name: 'Confirm it is fixed' }).click();
    await expect(page.getByText('closed').first()).toBeVisible();
    await expectAccessible(page);
  });

  test('managers set targets; technicians see their work but not the queue', async ({ page }) => {
    const { api, manager, tech, base } = setup();
    api.currentUserId = manager.id;
    await api.install(page);
    await page.goto(`${base}/maintenance`);
    await page.getByRole('button', { name: 'Targets' }).click();
    const targets = page.getByRole('form', { name: 'Targets' });
    const urgent = targets.getByRole('group', { name: 'Urgent' });
    await urgent.getByLabel('Respond within (hours)').fill('8');
    await urgent.getByLabel('Fix within (hours)').fill('2');
    await targets.getByRole('button', { name: 'Save targets' }).click();
    await expect(
      targets.getByText('Fixing cannot be due before the first response.'),
    ).toBeVisible();
    await urgent.getByLabel('Fix within (hours)').fill('24');
    await targets.getByRole('button', { name: 'Save targets' }).click();
    await expect(page.getByText('Targets saved.')).toBeVisible();
    await expectAccessible(page);

    api.currentUserId = tech.id;
    await page.goto(`${base}/maintenance`);
    await expect(page.getByRole('heading', { name: 'You cannot view maintenance' })).toBeVisible();
    await page.goto(`${base}/my-work`);
    await expect(page.getByText('Nothing to do right now.')).toBeVisible();
  });

  test('a file that is not what it claims is refused', async ({ page }) => {
    const { api, tenant, unitPath } = setup();
    api.currentUserId = tenant.id;
    await api.install(page);
    await page.goto(`${unitPath}/maintenance`);
    const report = page.getByRole('form', { name: 'Report a problem' });
    await report.getByLabel('In a few words').fill('Broken window');
    await report.getByLabel('What is wrong').fill('Cracked pane');
    await report.getByRole('button', { name: 'Send report' }).click();
    const upload = page.getByRole('form', { name: 'Add a file' });
    await upload.getByLabel('Photo or PDF').setInputFiles({
      name: 'photo.png',
      mimeType: 'image/png',
      buffer: Buffer.from('<html><script>alert(1)</script></html>'),
    });
    await upload.getByRole('button', { name: 'Upload' }).click();
    await expect(upload.getByText('This file is not a photo or PDF we can accept')).toBeVisible();
    await expect(page.getByText('No files yet.')).toBeVisible();
    await upload.getByLabel('Photo or PDF').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello'),
    });
    await upload.getByRole('button', { name: 'Upload' }).click();
    await expect(
      upload.getByText('Choose a photo (JPEG, PNG, WebP or HEIC) or a PDF.'),
    ).toBeVisible();
  });
});
