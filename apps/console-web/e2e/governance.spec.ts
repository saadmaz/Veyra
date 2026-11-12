import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { FakeApi } from './fake-api';

/*
 * Incidents and governance (Phase 11): a guard reports an incident and the manager runs the
 * response to closure; the manager holds a committee meeting, records a resolution and approves
 * the minutes, which a committee member then reads; a maintenance manager asks for an approval
 * that the manager grants. The API's own tests prove the rules; these prove the screens.
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
  const people = {
    manager: api.addUser('pam@example.test', PASSWORD, 'Pam Manager'),
    guard: api.addUser('gus@example.test', PASSWORD, 'Gus Guard'),
    member: api.addUser('cleo@example.test', PASSWORD, 'Cleo Committee'),
    maintenance: api.addUser('max@example.test', PASSWORD, 'Max Maintenance'),
  };
  api.addMembership(org.id, people.manager.id, 'PROPERTY_MANAGER', property.id);
  api.addMembership(org.id, people.guard.id, 'SECURITY_GUARD', property.id);
  api.addMembership(org.id, people.member.id, 'COMMITTEE_MEMBER', property.id);
  api.addMembership(org.id, people.maintenance.id, 'MAINTENANCE_MANAGER', property.id);
  api.governance.addContact(property.id, 'City Fire Station', 'Fire brigade', '+92 21 16');
  const board = api.governance.addCommittee(property.id, 'Management board', [
    { userId: people.member.id, name: 'Cleo Committee' },
  ]);
  return { api, people, board, base: `/organisations/${org.id}/properties/${property.id}` };
}

test.describe('incidents and governance', () => {
  test('a guard reports an incident and the manager runs it to closure', async ({ page }) => {
    const { api, people, base } = setup();
    api.currentUserId = people.guard.id;
    await api.install(page);

    await page.goto(base);
    await page.getByRole('link', { name: 'Incidents' }).click();
    await expect(page.getByRole('heading', { name: 'Incidents', level: 1 })).toBeVisible();
    const form = page.getByRole('form', { name: 'Report an incident' });
    await form.getByLabel('What happened').fill('Smoke in the car park');
    await form.getByLabel('Kind').selectOption('FIRE');
    await form.getByLabel('Severity').selectOption('CRITICAL');
    await form.getByLabel('Details').fill('Smoke from a parked car near bay 12.');
    await form.getByRole('button', { name: 'Report' }).click();
    await expect(
      page.getByText(/Reported as IN-000001\. The managers have been alerted\./),
    ).toBeVisible();
    await expect(page.getByRole('list', { name: 'Escalation contacts' })).toContainText(
      'City Fire Station',
    );
    await expectAccessible(page);

    api.currentUserId = people.manager.id;
    await page.goto(`${base}/incidents`);
    await page.getByRole('link', { name: /IN-000001 Smoke in the car park/ }).click();
    await page.getByRole('button', { name: 'Start responding' }).click();
    await expect(page.getByText('Open → Responding')).toBeVisible();
    await page.getByRole('button', { name: 'Resolve' }).click();
    await expect(page.getByText('Say how the incident ended to resolve it.')).toBeVisible();
    await page.getByLabel('How it ended (needed to resolve)').fill('Fire put out; car towed.');
    await page.getByRole('button', { name: 'Resolve' }).click();
    await expect(page.getByText('Outcome: Fire put out; car towed.')).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByText('Resolved → Closed')).toBeVisible();
    await expect(page.getByRole('form', { name: 'Add a note' })).toHaveCount(0);
    await expectAccessible(page);
  });

  test('the manager holds a meeting, records a resolution and approves the minutes', async ({
    page,
  }) => {
    const { api, people, base } = setup();
    api.currentUserId = people.manager.id;
    await api.install(page);

    await page.goto(base);
    await page.getByRole('link', { name: 'Committees and meetings' }).click();
    await expect(page.getByRole('list', { name: 'Members of Management board' })).toContainText(
      'Cleo Committee · Chair',
    );
    const schedule = page.getByRole('form', { name: 'Schedule a meeting of Management board' });
    await schedule.getByLabel('Meeting').fill('Annual meeting');
    await schedule.getByLabel('Agenda (one item per line)').fill('Budget\nLobby repaint');
    await schedule.getByRole('button', { name: 'Schedule meeting' }).click();
    await page.getByRole('link', { name: 'Annual meeting' }).click();
    await expect(page.getByRole('list', { name: 'Agenda' })).toContainText('2. Lobby repaint');
    await page.getByRole('button', { name: 'Mark as held' }).click();

    const resolution = page.getByRole('form', { name: 'Record a resolution' });
    await resolution.getByLabel('Resolution').fill('Repaint the lobby');
    await resolution.getByLabel('Text').fill('The lobby is repainted within budget.');
    await resolution.getByLabel('For', { exact: true }).fill('4');
    await resolution.getByRole('button', { name: 'Record resolution' }).click();
    await expect(page.getByRole('list', { name: 'Resolutions' })).toContainText(
      'Repaint the lobby',
    );

    await page.getByRole('textbox', { name: 'Minutes' }).fill('Present: all members.');
    await page.getByRole('button', { name: 'Save minutes' }).click();
    await page.getByRole('button', { name: 'Approve minutes' }).click();
    await expect(page.getByText(/Approved by Pam Manager/)).toBeVisible();
    await expect(page.getByRole('form', { name: 'Record a resolution' })).toHaveCount(0);
    await expectAccessible(page);

    api.currentUserId = people.member.id;
    await page.reload();
    await expect(page.getByText('Present: all members.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve minutes' })).toHaveCount(0);
  });

  test('a maintenance manager asks for approval and the manager approves', async ({ page }) => {
    const { api, people, base } = setup();
    api.currentUserId = people.maintenance.id;
    await api.install(page);

    await page.goto(`${base}/approvals`);
    const ask = page.getByRole('form', { name: 'Ask for approval' });
    await ask.getByLabel('What for').fill('New water pump');
    await ask.getByLabel('Amount in PKR (optional)').fill('85,000');
    await ask.getByLabel('Why').fill('The old pump failed this morning.');
    await ask.getByRole('button', { name: 'Send for approval' }).click();
    await expect(
      page.getByText(/Sent as AR-000001: needs 1 approval from the managers\./),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expectAccessible(page);

    api.currentUserId = people.manager.id;
    await page.reload();
    const item = page.getByRole('article', { name: 'AR-000001 New water pump' });
    await expect(item).toContainText('0 of 1 approvals from managers');
    await item.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('Nothing is waiting.')).toBeVisible();
    await page.getByLabel('Show settled requests too').check();
    await expect(page.getByRole('article', { name: 'AR-000001 New water pump' })).toContainText(
      'Pam Manager approved',
    );
    await expectAccessible(page);
  });
});
