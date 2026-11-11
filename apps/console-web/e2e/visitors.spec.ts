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

const appAlert = (page: Page) => page.locator('.alert[role="alert"]');

function setup() {
  const api = new FakeApi();
  const admin = api.addUser('admin@example.test', PASSWORD, 'Ada Admin');
  const org = api.addOrganisation('Harbour Group', admin.id);
  const property = api.addProperty(org.id, 'Harbour View', 'HVR');
  const unit = api.addUnit(property.id, '101');
  // Ana owns unit 101 and has linked her login.
  const ana = api.addPerson(org.id, 'Ana Owner', 'ana@example.test');
  api.addOwnership(unit.id, ana, '2026-01-01');
  const owner = api.addUser('ana@example.test', PASSWORD, 'Ana Owner');
  api.linkPerson(ana.id, owner.id);
  const guard = api.addUser('guard@example.test', PASSWORD, 'Gil Guard');
  api.addMembership(org.id, guard.id, 'SECURITY_GUARD', property.id);
  const base = `/organisations/${org.id}/properties/${property.id}`;
  return {
    api,
    admin,
    org,
    property,
    unit,
    owner,
    guard,
    base,
    unitUrl: `${base}/units/${unit.id}`,
  };
}

/** A registered visitor with a known reference code, valid from an hour ago for three hours. */
function seedInvitation(
  ctx: ReturnType<typeof setup>,
  name: string,
  code: string,
  overrides: Partial<{ maxEntries: number; status: 'ACTIVE' | 'REVOKED' }> = {},
) {
  const { api, property, unit, owner } = ctx;
  const id = crypto.randomUUID();
  api.visitorInvitations.push({
    id,
    propertyId: property.id,
    unitId: unit.id,
    unitNumber: unit.number,
    category: 'GUEST',
    visitorName: name,
    visitorPhone: '+923001112222',
    vehiclePlate: 'LEA1234',
    validFrom: new Date(Date.now() - 3_600_000).toISOString(),
    validUntil: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    maxEntries: overrides.maxEntries ?? 1,
    entriesUsed: 0,
    status: overrides.status ?? 'ACTIVE',
    revokedAt: null,
    createdByMe: false,
    createdAt: new Date().toISOString(),
    token: 'T'.repeat(43),
    code: code.replace('-', ''),
    createdByUserId: owner.id,
    hostUserId: owner.id,
  });
  return id;
}

test.describe('residents', () => {
  test('an owner registers a visitor, gets the pass once and can cancel it', async ({ page }) => {
    const ctx = setup();
    const { api, owner, org } = ctx;
    api.currentUserId = owner.id;
    page.on('dialog', (dialog) => void dialog.accept());
    await api.install(page);

    await page.goto(`/organisations/${org.id}`);
    await page
      .getByRole('region', { name: 'Your homes' })
      .getByRole('link', { name: 'Unit 101' })
      .click();
    await expect(page.getByRole('heading', { name: 'Unit 101', level: 1 })).toBeVisible();
    const visitors = page.getByRole('region', { name: 'Visitors', exact: true });
    await expect(visitors).toContainText('No visitors registered.');
    await expect(page.getByRole('region', { name: 'Visitors at the gate' })).toContainText(
      'Nobody is waiting',
    );

    await visitors.getByLabel("Visitor's name").fill('Vera Visitor');
    await visitors.getByLabel('Visitor type').selectOption({ label: 'Guest' });
    await visitors.getByLabel('Vehicle plate (optional)').fill('lea 1234');
    await visitors.getByRole('button', { name: 'Register visitor' }).click();

    await expect(visitors.getByRole('img', { name: 'QR code for Vera Visitor' })).toBeVisible();
    await expect(
      visitors.getByText(/Reference code [2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}/),
    ).toBeVisible();
    const list = visitors.getByRole('list', { name: 'Registered visitors' });
    await expect(list).toContainText('Vera Visitor');
    await expect(list).toContainText('LEA1234');
    await expect(list.getByText('active', { exact: true })).toBeVisible();
    await expectAccessible(page);
    await expectNoHorizontalScroll(page);

    // The pass is shown once: after "Done" it is gone, and the list never shows it.
    await visitors.getByRole('button', { name: 'Done' }).click();
    await expect(visitors.getByRole('img', { name: /QR code/ })).toHaveCount(0);

    await visitors.getByRole('button', { name: 'Cancel visitor Vera Visitor' }).click();
    await expect(list.getByText('cancelled', { exact: true })).toBeVisible();
    expect(api.visitorInvitations[0]?.status).toBe('REVOKED');
  });
});

test.describe('the gate', () => {
  test('a guard checks a code, admits the visitor and records that they left', async ({ page }) => {
    const ctx = setup();
    const { api, guard, base } = ctx;
    seedInvitation(ctx, 'Vera Visitor', 'K7Q2-M9XA');
    api.currentUserId = guard.id;
    await api.install(page);

    await page.goto(base);
    await page.getByRole('link', { name: 'Open the gate screen' }).click();
    await expect(page.getByRole('heading', { name: 'Gate', level: 1 })).toBeVisible();
    await page.getByLabel('This gate').fill('Main gate');

    const check = page.getByRole('region', { name: 'Check a pass' });
    await check.getByLabel('Reference code', { exact: true }).fill('k7q2 m9xa');
    await check.getByRole('button', { name: 'Check code' }).click();
    await expect(check).toContainText('Valid pass');
    await expect(check).toContainText('Vera Visitor');
    await expect(check).toContainText('101');
    // The guard never sees the visitor's phone number.
    await expect(check).not.toContainText('3001112222');
    await expectAccessible(page);

    await check.getByRole('button', { name: 'Admit' }).click();
    await expect(check).toContainText('Vera Visitor admitted to unit 101.');
    expect(api.visits[0]).toMatchObject({ decision: 'ADMITTED', gate: 'Main gate' });

    // Used up: checking again is refused.
    await check.getByLabel('Reference code', { exact: true }).fill('K7Q2-M9XA');
    await check.getByRole('button', { name: 'Check code' }).click();
    await expect(appAlert(page)).toContainText('already been used');

    const inside = page.getByRole('region', { name: 'Inside now' });
    await expect(inside.getByRole('list', { name: 'Visitors inside' })).toContainText(
      'Vera Visitor',
    );
    await inside.getByRole('button', { name: 'Record that Vera Visitor left' }).click();
    await expect(inside).toContainText('No visitors are inside.');
    await expectNoHorizontalScroll(page);
  });

  test('a guard refuses entry with a reason, and is told when a code is unknown', async ({
    page,
  }) => {
    const ctx = setup();
    const { api, guard, base } = ctx;
    seedInvitation(ctx, 'Rex Refused', 'ABCD-EFGH');
    api.currentUserId = guard.id;
    await api.install(page);
    await page.goto(`${base}/gate`);

    const check = page.getByRole('region', { name: 'Check a pass' });
    await check.getByLabel('Reference code', { exact: true }).fill('ZZZZ-ZZZZ');
    await check.getByRole('button', { name: 'Check code' }).click();
    await expect(appAlert(page)).toContainText('No pass matches this code');

    await check.getByLabel('Reference code', { exact: true }).fill('ABCD-EFGH');
    await check.getByRole('button', { name: 'Check code' }).click();
    await check.getByRole('button', { name: 'Refuse' }).click();
    await check.getByLabel('Reason for refusing').fill('Could not show ID');
    await check.getByRole('button', { name: 'Record refusal' }).click();
    await expect(check).toContainText('Entry refused for Rex Refused.');
    expect(api.visits[0]).toMatchObject({ decision: 'DENIED', denialReason: 'Could not show ID' });
  });

  test('a walk-in to a unit waits for the resident, who lets them in from their unit page', async ({
    page,
  }) => {
    const ctx = setup();
    const { api, guard, owner, base, unitUrl } = ctx;
    api.currentUserId = guard.id;
    await api.install(page);
    await page.goto(`${base}/gate`);

    const walkIn = page.getByRole('region', { name: 'Visitor without a pass' });
    await walkIn.getByLabel('Going to').selectOption({ label: 'Unit 101' });
    await walkIn.getByLabel("Visitor's name").fill('Wally Walkin');
    await walkIn.getByRole('button', { name: 'Continue' }).click();
    await expect(walkIn).toContainText('Request sent');
    const waiting = walkIn.getByRole('list', { name: 'Waiting for residents' });
    await expect(waiting).toContainText('Waiting for the resident');
    await expect(waiting.getByRole('button', { name: 'Admit Wally Walkin' })).toHaveCount(0);

    // The owner answers on their unit page.
    api.currentUserId = owner.id;
    await page.goto(unitUrl);
    const atGate = page.getByRole('region', { name: 'Visitors at the gate' });
    await expect(atGate.getByRole('list', { name: 'Waiting at the gate' })).toContainText(
      'Wally Walkin',
    );
    await expectAccessible(page);
    await atGate.getByRole('button', { name: 'Let in Wally Walkin' }).click();
    await expect(atGate.getByRole('list', { name: 'Recent walk-in requests' })).toContainText(
      'Approved',
    );

    // Back at the gate the approval shows up (the screen checks for updates) and admits once.
    api.currentUserId = guard.id;
    await page.goto(`${base}/gate`);
    await walkIn.getByRole('button', { name: 'Admit Wally Walkin' }).click();
    await expect(
      page
        .getByRole('region', { name: 'Inside now' })
        .getByRole('list', { name: 'Visitors inside' }),
    ).toContainText('Wally Walkin');
    expect(api.visits[0]?.walkInRequestId).toBe(api.walkIns[0]?.id);
  });

  test('staff see walk-in requests on a unit but cannot answer for the residents', async ({
    page,
  }) => {
    const ctx = setup();
    const { api, admin, guard, unit, property, unitUrl } = ctx;
    api.walkIns.push({
      id: crypto.randomUUID(),
      propertyId: property.id,
      unitId: unit.id,
      unitNumber: unit.number,
      category: 'DELIVERY',
      visitorName: 'Courier',
      visitorPhone: null,
      vehiclePlate: null,
      gate: 'Main gate',
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      decidedAt: null,
      approvalValidUntil: null,
      used: false,
    });
    void guard;
    api.currentUserId = admin.id;
    await api.install(page);
    await page.goto(unitUrl);
    const atGate = page.getByRole('region', { name: 'Visitors at the gate' });
    await expect(atGate).toContainText('Courier');
    await expect(atGate).toContainText("Only the unit's residents can answer");
    await expect(atGate.getByRole('button', { name: /Let in|Refuse/ })).toHaveCount(0);
  });
});

test.describe('supervision and access', () => {
  test('a supervisor reads the day’s visits and cancels an expected visitor', async ({ page }) => {
    const ctx = setup();
    const { api, org, property, base } = ctx;
    seedInvitation(ctx, 'Eve Expected', 'EEEE-EEEE');
    api.visits.push({
      id: crypto.randomUUID(),
      propertyId: property.id,
      unitId: null,
      unitNumber: null,
      invitationId: null,
      category: 'DELIVERY',
      visitorName: 'Dan Delivery',
      vehiclePlate: null,
      decision: 'ADMITTED',
      denialReason: null,
      gate: 'Main gate',
      arrivedAt: new Date().toISOString(),
      departedAt: null,
      source: 'ONLINE',
      reviewReason: null,
      reviewedAt: null,
      reviewNote: null,
      walkInRequestId: null,
    });
    const supervisor = api.addUser('sup@example.test', PASSWORD, 'Sue Supervisor');
    api.addMembership(org.id, supervisor.id, 'SECURITY_SUPERVISOR', property.id);
    api.currentUserId = supervisor.id;
    page.on('dialog', (dialog) => void dialog.accept());
    await api.install(page);

    await page.goto(base);
    await page.getByRole('link', { name: 'Visit log' }).click();
    await expect(page.getByRole('heading', { name: 'Visitors', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Visit log' }).getByRole('table')).toContainText(
      'Dan Delivery',
    );
    const expected = page.getByRole('region', { name: 'Expected visitors' });
    await expect(expected).toContainText('Eve Expected');
    await expectAccessible(page);
    await expected.getByRole('button', { name: 'Cancel pass of Eve Expected' }).click();
    await expect(expected.getByText('cancelled', { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('a guard has the gate but not the log; a finance officer has neither', async ({ page }) => {
    const ctx = setup();
    const { api, org, guard, base, unitUrl } = ctx;
    api.currentUserId = guard.id;
    await api.install(page);
    await page.goto(base);
    await expect(page.getByRole('link', { name: 'Open the gate screen' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Visit log' })).toHaveCount(0);
    await page.goto(`${base}/visitors`);
    await expect(
      page.getByRole('heading', { name: 'You cannot view the visit log' }),
    ).toBeVisible();

    const finance = api.addUser('fin@example.test', PASSWORD, 'Farah Finance');
    api.addMembership(org.id, finance.id, 'FINANCE_OFFICER');
    api.currentUserId = finance.id;
    await page.goto(base);
    await expect(page.getByRole('region', { name: 'Visitors and gate' })).toHaveCount(0);
    await page.goto(`${base}/gate`);
    await expect(page.getByRole('heading', { name: 'You cannot operate the gate' })).toBeVisible();
    await page.goto(unitUrl);
    await expect(page.getByRole('heading', { name: 'Unit 101', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Visitors', exact: true })).toHaveCount(0);
    expect(api.log.filter((line) => /visitor-invitations|walk-in-requests/.test(line))).toEqual([]);
  });
});

test.describe('offline gate and paper log', () => {
  test('without a connection the guard checks against the saved list, admits, and the entry is sent later', async ({
    page,
    context,
  }) => {
    const ctx = setup();
    const { api, guard, base } = ctx;
    seedInvitation(ctx, 'Olive Offline', 'OFFL-INE2');
    api.currentUserId = guard.id;
    await api.install(page);
    await page.goto(`${base}/gate`);
    // The gate saves the offline list while it still has a connection.
    await expect.poll(() => api.log.some((line) => line.endsWith('/gate/offline-list'))).toBe(true);

    await context.setOffline(true);
    await expect(page.getByText('No connection')).toBeVisible();
    const check = page.getByRole('region', { name: 'Check a pass' });
    await check.getByLabel('Reference code', { exact: true }).fill('offl ine2');
    await check.getByRole('button', { name: 'Check code' }).click();
    await expect(check).toContainText('Valid pass (offline check)');
    await expect(check).toContainText('Olive Offline');
    await check.getByRole('button', { name: 'Admit' }).click();
    await expect(check).toContainText('Saved on this device');
    await expect(page.getByText('1 entry is waiting to be sent.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Admitted while offline' })).toContainText(
      'Olive Offline',
    );

    // Walk-ins to a unit need a resident's approval, which is impossible offline.
    const walkIn = page.getByRole('region', { name: 'Visitor without a pass' });
    await walkIn.getByLabel('Going to').selectOption({ label: 'Unit 101' });
    await walkIn.getByLabel("Visitor's name").fill('Wanda Waiting');
    await walkIn.getByRole('button', { name: 'Continue' }).click();
    await expect(appAlert(page)).toContainText('Follow the paper procedure');
    await expectAccessible(page);

    await context.setOffline(false);
    await expect(page.getByText('Offline entries sent')).toBeVisible();
    await expect(page.getByText('1 recorded')).toBeVisible();
    expect(api.visits).toHaveLength(1);
    expect(api.visits[0]).toMatchObject({ source: 'OFFLINE_SYNC', visitorName: 'Olive Offline' });
    await expect(page.getByText(/waiting to be sent/)).toHaveCount(0);
  });

  test('a supervisor reviews a flagged entry and types in the paper log', async ({ page }) => {
    const ctx = setup();
    const { api, org, property, unit, base } = ctx;
    api.visits.push({
      id: crypto.randomUUID(),
      propertyId: property.id,
      unitId: unit.id,
      unitNumber: unit.number,
      invitationId: null,
      category: 'GUEST',
      visitorName: 'Rita Revoked',
      vehiclePlate: null,
      decision: 'ADMITTED',
      denialReason: null,
      gate: 'Main gate',
      arrivedAt: new Date(Date.now() - 3_600_000).toISOString(),
      departedAt: null,
      source: 'OFFLINE_SYNC',
      reviewReason: 'REVOKED',
      reviewedAt: null,
      reviewNote: null,
      walkInRequestId: null,
      clientRef: crypto.randomUUID(),
    });
    const supervisor = api.addUser('sup@example.test', PASSWORD, 'Sue Supervisor');
    api.addMembership(org.id, supervisor.id, 'SECURITY_SUPERVISOR', property.id);
    api.currentUserId = supervisor.id;
    await api.install(page);
    await page.goto(`${base}/visitors`);

    const review = page.getByRole('region', { name: 'Needs review' });
    await expect(review).toContainText('Rita Revoked');
    await expect(review).toContainText('This pass was cancelled.');
    await expectAccessible(page);
    await review.getByRole('button', { name: 'Review entry for Rita Revoked' }).click();
    await review.getByLabel('What you found (optional)').fill('Resident confirmed by phone');
    await review.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(page.getByRole('region', { name: 'Needs review' })).toHaveCount(0);
    expect(api.visits[0]?.reviewNote).toBe('Resident confirmed by phone');

    const paper = page.getByRole('region', { name: 'Enter from the paper log' });
    await paper.getByLabel('What happened').selectOption({ label: 'Admitted without a pass' });
    await paper.getByLabel("Visitor's name").fill('Paul Paper');
    await paper.getByLabel('Going to').selectOption({ label: 'Unit 101' });
    await paper.getByRole('button', { name: 'Record entry' }).click();
    await expect(paper).toContainText('It needs a review');
    expect(api.visits.at(-1)).toMatchObject({
      source: 'PAPER',
      reviewReason: 'WALK_IN_WITHOUT_APPROVAL',
    });
    await expectNoHorizontalScroll(page);
  });
});
