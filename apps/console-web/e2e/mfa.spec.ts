import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { FakeApi } from './fake-api';

/** Below 60rem the sidebar collapses into a menu; open it before using its links. */
async function openNavigation(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) >= 960) return;
  await page.locator('summary[aria-label="Open navigation"]').click();
}

/*
 * Two-step sign-in (Phase 14 Part 2): an organisation admin turns it on with an authenticator
 * app and sees the recovery codes once; a later session asks for a code before changes, accepts
 * a recovery code, and the prompt goes away. The API's own tests prove the rules (time steps,
 * one-time use, enforcement); these prove the screens.
 */

const PASSWORD = 'correct horse battery staple';

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test('an admin turns on two-step sign-in and verifies a later session', async ({ page }) => {
  const api = new FakeApi();
  const ada = api.addUser('ada@example.test', PASSWORD, 'Ada Admin');
  api.addOrganisation('Harbour Group', ada.id);
  api.currentUserId = ada.id;
  await api.install(page);

  await page.goto('/organisations');
  await openNavigation(page);
  await page.getByRole('link', { name: 'Two-step sign-in' }).click();
  await page.getByRole('button', { name: 'Set up an authenticator app' }).click();
  await expect(page.getByText('JBSWY3DPEHPK3PXP')).toBeVisible();
  await page.getByLabel('6-digit code').fill('000000');
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByText('That code is not right. Try the current one.')).toBeVisible();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(
    page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem'),
  ).toHaveCount(10);
  await expectAccessible(page);
  await page.getByRole('button', { name: 'I have saved them' }).click();
  await expect(page.getByText('10 recovery codes left. This session is verified.')).toBeVisible();

  // A later session: not verified yet.
  const state = api.mfa.get(ada.id);
  if (state) state.verified = false;
  await page.goto('/organisations');
  const prompt = page.getByRole('form', { name: 'Verify with a code' });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Use a recovery code' }).click();
  await prompt.getByLabel('Recovery code').fill('AAAA-BBBB');
  await prompt.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('form', { name: 'Verify with a code' })).toHaveCount(0);
  await expectAccessible(page);
});
