import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { FakeApi } from './fake-api';

/*
 * Operations (Phase 9): an admin registers a vendor and its insurance; a security supervisor sets
 * up a department, plans a guard's shift and gives a checklist; the guard starts the shift, fills
 * in the checklist (a problem needs a note), hands it in and ends the shift with a handover; the
 * supervisor verifies it. The API's own tests prove the rules; these prove the screens.
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
  const supervisor = api.addUser('sam@example.test', PASSWORD, 'Sam Supervisor');
  api.addMembership(org.id, supervisor.id, 'SECURITY_SUPERVISOR', property.id);
  const guard = api.addUser('gus@example.test', PASSWORD, 'Gus Guard');
  api.addMembership(org.id, guard.id, 'SECURITY_GUARD', property.id);
  return {
    api,
    admin,
    supervisor,
    guard,
    org,
    base: `/organisations/${org.id}/properties/${property.id}`,
  };
}

test.describe('operations', () => {
  test('an admin registers a vendor with its insurance', async ({ page }) => {
    const { api, admin, org } = setup();
    api.currentUserId = admin.id;
    await api.install(page);

    await page.goto(`/organisations/${org.id}`);
    await page.getByRole('link', { name: 'Open vendors' }).click();
    await expect(page.getByRole('heading', { name: 'Vendors', level: 1 })).toBeVisible();
    await expect(page.getByText('No vendors yet.')).toBeVisible();
    const add = page.getByRole('form', { name: 'Add a vendor' });
    await add.getByLabel('Name').fill('AquaFix Plumbing');
    await add.getByLabel('Phone (optional)').fill('+92 300 0000000');
    await add.getByRole('button', { name: 'Add vendor' }).click();
    await expect(page.getByRole('heading', { name: /AquaFix Plumbing/, level: 1 })).toBeVisible();
    await expect(page.getByText('no papers on file')).toBeVisible();

    const doc = page.getByRole('form', { name: 'Add a document' });
    await doc.getByLabel('Title').fill('Public liability');
    await doc.getByLabel('Valid until (optional)').fill('2030-12-31');
    await doc.getByRole('button', { name: 'Add document' }).click();
    await expect(page.getByText('Insurance: Public liability')).toBeVisible();
    await expect(page.getByText('papers in order')).toBeVisible();
    await expectAccessible(page);
  });

  test('a guard works a planned shift with a checklist the supervisor verifies', async ({
    page,
  }) => {
    const { api, supervisor, guard, base } = setup();
    api.currentUserId = supervisor.id;
    await api.install(page);

    // The supervisor sets up the department, the shift and the checklist.
    await page.goto(base);
    await page.getByRole('link', { name: 'Plan staff' }).click();
    await expect(page.getByRole('heading', { name: 'Staff', level: 1 })).toBeVisible();
    await page.getByLabel('New department').fill('Security');
    await page.getByRole('button', { name: 'Add department' }).click();
    const departments = page.getByRole('list', { name: 'Departments' });
    await departments.getByLabel('Add to Security').selectOption({ label: 'Gus Guard' });
    await departments.getByRole('button', { name: 'Add member' }).click();
    await expect(departments.locator('.list__meta')).toHaveText('Gus Guard');

    const plan = page.getByRole('form', { name: 'Plan a shift' });
    await plan.getByLabel('Starts').fill('2026-12-01T08:00');
    await plan.getByLabel('Ends').fill('2026-12-01T16:00');
    await plan.getByRole('button', { name: 'Plan shift' }).click();
    await expect(page.getByRole('list', { name: 'Shifts' }).getByText(/Gus Guard/)).toBeVisible();

    const template = page.getByRole('form', { name: 'New checklist template' });
    await template.getByLabel('Template title').fill('Night patrol');
    await template.getByLabel('Checks (one per line)').fill('Gate 1 locked\nFire exits clear');
    await template.getByRole('button', { name: 'Save template' }).click();
    const give = page.getByRole('form', { name: 'Give a checklist' });
    await give.getByLabel('To').selectOption({ label: 'Gus Guard' });
    await give.getByLabel('Due').fill('2026-12-01');
    await give.getByRole('button', { name: 'Give checklist' }).click();
    await expectAccessible(page);

    // The guard works the shift.
    api.currentUserId = guard.id;
    await page.goto(base);
    await page.getByRole('main').getByRole('link', { name: 'My shifts' }).click();
    await expect(page.getByRole('heading', { name: 'My shifts', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Start shift' }).click();
    await expect(page.getByText('on shift')).toBeVisible();

    const checklist = page.getByRole('region', { name: 'Night patrol' });
    const gate = checklist.getByRole('group', { name: 'Answer for Gate 1 locked' });
    await gate.getByRole('button', { name: 'OK' }).click();
    const exits = checklist.getByRole('group', { name: 'Answer for Fire exits clear' });
    await exits.getByRole('button', { name: 'Problem' }).click();
    await expect(
      checklist.getByText('Say what was wrong in the note before marking a problem.'),
    ).toBeVisible();
    await checklist
      .getByLabel('Note for "Fire exits clear" (needed for a problem)')
      .fill('Boxes at exit B');
    await exits.getByRole('button', { name: 'Problem' }).click();
    await checklist.getByRole('button', { name: 'Hand in (2 of 2 answered)' }).click();
    await expect(checklist.getByText('handed in')).toBeVisible();

    const end = page.getByRole('form', { name: 'End shift' });
    await end.getByLabel('Handover for the next shift').fill('Exit B blocked; caretaker told.');
    await end.getByRole('button', { name: 'End shift' }).click();
    await expect(page.getByText('No shifts coming up.')).toBeVisible();
    await expectAccessible(page);

    // The supervisor verifies it.
    api.currentUserId = supervisor.id;
    await page.goto(`${base}/staff`);
    const toCheck = page.getByRole('list', { name: 'Checklists to check' });
    await expect(toCheck.getByText('Fire exits clear: problem (Boxes at exit B)')).toBeVisible();
    await toCheck.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByText('Nothing to check.')).toBeVisible();
    await expect(page.getByText(/Handover: Exit B blocked/)).toBeVisible();
  });
});
