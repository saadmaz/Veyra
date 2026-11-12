import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { FakeApi } from './fake-api';

/*
 * Account recovery (Phase 14 Part 1): someone who forgot their password asks for a link from the
 * sign-in page and chooses a new password from it; a link confirms an email address; people who
 * have not confirmed theirs are reminded and can have the link sent again. The API's own tests
 * prove the rules; these prove the screens.
 */

const PASSWORD = 'correct horse battery staple';
const TOKEN = 'a'.repeat(43);

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test.describe('account recovery', () => {
  test('a forgotten password is replaced through the emailed link', async ({ page }) => {
    const api = new FakeApi();
    await api.install(page);

    await page.goto('/sign-in');
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible();
    await page.getByLabel('Email').fill('ada@example.test');
    await page.getByRole('button', { name: 'Send the link' }).click();
    await expect(page.getByText('Check your email')).toBeVisible();
    expect(api.accountCalls).toContainEqual({
      path: '/auth/password-reset',
      body: { email: 'ada@example.test' },
    });
    await expectAccessible(page);

    await page.goto(`/reset-password#token=${TOKEN}`);
    await expect(page).toHaveURL(/\/reset-password$/);
    await page.getByLabel('New password').fill('a much better passphrase');
    await page.getByLabel('Repeat it').fill('a different passphrase!!');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('The two passwords differ.')).toBeVisible();
    await page.getByLabel('Repeat it').fill('a much better passphrase');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Your password is changed')).toBeVisible();
    await expectAccessible(page);

    await page.goto('/sign-in');
    await page.goto('/reset-password#token=wrong');
    await expect(page.getByText('This link is incomplete')).toBeVisible();
  });

  test('an email address is confirmed from its link, with a reminder until then', async ({
    page,
  }) => {
    const api = new FakeApi();
    const ada = api.addUser('ada@example.test', PASSWORD, 'Ada Admin');
    api.addOrganisation('Harbour Group', ada.id);
    api.unverified.add(ada.id);
    api.currentUserId = ada.id;
    await api.install(page);

    await page.goto('/organisations');
    const banner = page.locator('.alert').filter({ hasText: 'Confirm your email address' });
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'Send it again' }).click();
    await expect(banner).toContainText('We have sent the link again');
    expect(api.accountCalls.map((c) => c.path)).toContain('/auth/verify-email/resend');

    api.unverified.delete(ada.id);
    await page.goto(`/verify-email#token=${TOKEN}`);
    await expect(page.getByText('Your email address is confirmed.')).toBeVisible();
    await expectAccessible(page);
    await page.goto('/organisations');
    await expect(page.getByText('Confirm your email address')).toHaveCount(0);
  });
});
