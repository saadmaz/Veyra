import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { FakeApi } from './fake-api';

/** On narrow screens the sidebar is a menu; open it before using its links. */
async function openNavigation(page: Page) {
  const menu = page.locator('summary[aria-label="Open navigation"]');
  if (await menu.isVisible()) await menu.click();
}

const PASSWORD = 'correct horse battery staple';

/** WCAG 2.2 AA automated checks. Manual review is still required for full conformance. */
async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/**
 * The app's own alerts. Next.js adds an invisible route announcer that also has role=alert,
 * so a bare getByRole('alert') would match two elements.
 */
const appAlert = (page: Page) => page.locator('.alert[role="alert"]');

/** No sideways scrolling at the current viewport width (phone layouts). */
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function signIn(page: Page, email: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('signed-out visitors', () => {
  test('are sent to sign-in, then back to the page they wanted', async ({ page }) => {
    const api = new FakeApi();
    const admin = api.addUser('admin@example.test', PASSWORD, 'Ada Admin');
    const org = api.addOrganisation('Harbour View', admin.id);
    await api.install(page);

    await page.goto(`/organisations/${org.id}`);
    await expect(page).toHaveURL(/\/sign-in\?next=/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expectAccessible(page);

    await signIn(page, 'admin@example.test');
    await expect(page.getByRole('heading', { name: 'Harbour View' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/organisations/${org.id}$`));
  });

  test('see a clear error for wrong credentials, announced to screen readers', async ({ page }) => {
    const api = new FakeApi();
    api.addUser('admin@example.test', PASSWORD, 'Ada Admin');
    await api.install(page);

    await page.goto('/sign-in');
    await page.getByLabel('Email').fill('admin@example.test');
    await page.getByLabel('Password').fill('not the password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(appAlert(page)).toContainText('The email or password is incorrect.');
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('cannot be redirected off-site through the next parameter', async ({ page }) => {
    const api = new FakeApi();
    api.addUser('admin@example.test', PASSWORD, 'Ada Admin');
    await api.install(page);

    await page.goto('/sign-in?next=https://evil.example/phish');
    await signIn(page, 'admin@example.test');
    await expect(page).toHaveURL(/localhost:3000\/organisations$/);
  });
});

test.describe('new account', () => {
  test('signs up, creates an organisation and lands on it', async ({ page }) => {
    const api = new FakeApi();
    await api.install(page);

    await page.goto('/sign-up');
    await expectAccessible(page);
    await page.getByLabel('Full name').fill('Nadia Noor');
    await page.getByLabel('Email').fill('nadia@example.test');
    await page.getByLabel('Password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByLabel('Password')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Use at least 12 characters.')).toBeVisible();

    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(
      page.getByRole('heading', { name: 'You are not part of any organisation yet' }),
    ).toBeVisible();
    await expectAccessible(page);
    await expectNoHorizontalScroll(page);

    await page.getByRole('link', { name: 'Create an organisation' }).click();
    await page.getByLabel('Organisation name').fill('Lakeside Towers');
    await expect(page.getByLabel('Web address')).toHaveValue('lakeside-towers');
    await page.getByLabel('Country code').fill('LK');
    await page.getByLabel('Currency').fill('LKR');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Create organisation' }).click();

    await expect(page.getByRole('heading', { name: 'Lakeside Towers' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Members and their roles' })).toContainText(
      'nadia@example.test',
    );
    await expect(page.getByLabel('Switch organisation')).toHaveValue(/[0-9a-f-]{36}/);
    expect(api.log).toContain('POST /organisations');
    await expectAccessible(page);
    await expectNoHorizontalScroll(page);
  });
});

test.describe('invitations', () => {
  test('admin invites, the invitee signs in from the link and joins', async ({ page, context }) => {
    const api = new FakeApi();
    const admin = api.addUser('admin@example.test', PASSWORD, 'Ada Admin');
    api.addUser('fin@example.test', PASSWORD, 'Farah Finance');
    const org = api.addOrganisation('Harbour View', admin.id);
    api.currentUserId = admin.id;
    await api.install(page);

    await page.goto(`/organisations/${org.id}`);
    const invitations = page.getByRole('region', { name: 'Invitations' });
    await invitations.getByLabel('Email').fill('fin@example.test');
    await invitations.getByRole('button', { name: 'Invite' }).click();
    const linkField = page.getByLabel('Invitation link');
    await expect(linkField).toHaveValue(/\/invitations\/accept#token=[A-Za-z0-9_-]{43}$/);
    const link = await linkField.inputValue();
    await expect(page.getByRole('list', { name: 'Pending invitations' })).toContainText(
      'fin@example.test',
    );
    await expectAccessible(page);

    // The invitee opens the link in a fresh, signed-out tab.
    api.currentUserId = null;
    const invitee = await context.newPage();
    await api.install(invitee);
    await invitee.goto(link);
    // The token leaves the address bar immediately.
    await expect(invitee).toHaveURL(/\/invitations\/accept$/);
    await expectAccessible(invitee);
    await invitee.getByRole('link', { name: 'Sign in' }).click();
    await signIn(invitee, 'fin@example.test');

    await expect(invitee).toHaveURL(/\/invitations\/accept$/);
    await invitee.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(invitee.getByRole('status')).toContainText('You joined Harbour View');
    await invitee.getByRole('link', { name: 'Open organisation' }).click();

    // A finance officer sees the organisation, but not member management.
    await expect(invitee.getByRole('heading', { name: 'Harbour View' })).toBeVisible();
    await expect(invitee.getByRole('region', { name: 'Members' })).toHaveCount(0);
    await expect(invitee.getByRole('region', { name: 'Invitations' })).toHaveCount(0);
  });

  test('explains when the invitation belongs to another email address', async ({ page }) => {
    const api = new FakeApi();
    const admin = api.addUser('admin@example.test', PASSWORD, 'Ada Admin');
    const other = api.addUser('other@example.test', PASSWORD, 'Omar Other');
    const org = api.addOrganisation('Harbour View', admin.id);
    api.invitations.push({
      id: crypto.randomUUID(),
      organisationId: org.id,
      email: 'someone@example.test',
      role: 'FINANCE_OFFICER',
      token: 'T'.repeat(43),
      status: 'PENDING',
    });
    api.currentUserId = other.id;
    await api.install(page);

    await page.goto(`/invitations/accept#token=${'T'.repeat(43)}`);
    await page.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(appAlert(page)).toContainText('different email address');
  });

  test('rejects malformed links without calling the API', async ({ page }) => {
    const api = new FakeApi();
    await api.install(page);
    await page.goto('/invitations/accept#token=broken');
    await expect(appAlert(page)).toContainText('not valid');
    expect(api.log.filter((entry) => entry.includes('/invitations/accept'))).toEqual([]);
  });
});

test.describe('error and empty states', () => {
  test('organisations the user cannot access look like missing ones', async ({ page }) => {
    const api = new FakeApi();
    const user = api.addUser('admin@example.test', PASSWORD, 'Ada Admin');
    api.currentUserId = user.id;
    await api.install(page);

    await page.goto(`/organisations/${crypto.randomUUID()}`);
    await expect(page.getByRole('heading', { name: 'Organisation not found' })).toBeVisible();
  });

  test('an unreachable API shows a retry instead of a blank page', async ({ page }) => {
    const api = new FakeApi();
    const user = api.addUser('admin@example.test', PASSWORD, 'Ada Admin');
    api.currentUserId = user.id;
    api.offline = true;
    await api.install(page);

    await page.goto('/organisations');
    await expect(appAlert(page)).toContainText('could not reach VEYRA');
    api.offline = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: 'Your organisations' })).toBeVisible();
  });

  test('signing out returns to sign-in and protected pages stay protected', async ({ page }) => {
    const api = new FakeApi();
    const user = api.addUser('admin@example.test', PASSWORD, 'Ada Admin');
    api.addOrganisation('Harbour View', user.id);
    api.currentUserId = user.id;
    await api.install(page);

    await page.goto('/organisations');
    await openNavigation(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in/);
    await page.goto('/organisations');
    await expect(page).toHaveURL(/\/sign-in\?next=%2Forganisations/);
  });

  test('keyboard users can skip straight to the content', async ({ page }) => {
    const api = new FakeApi();
    const user = api.addUser('admin@example.test', PASSWORD, 'Ada Admin');
    api.currentUserId = user.id;
    await api.install(page);

    await page.goto('/organisations');
    await expect(page.getByRole('heading', { name: 'Your organisations' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  });
});
