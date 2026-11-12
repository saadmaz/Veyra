import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { FakeApi } from './fake-api';

/*
 * Facilities (Phase 8): a manager makes a common area bookable; a tenant picks a free time and
 * books it, sees it confirmed and cancels it; with approval the manager approves the booking.
 * The API's own tests prove the rules; these prove the screens.
 */

const PASSWORD = 'correct horse battery staple';

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** Tomorrow in Karachi (UTC+5), where the fake properties are. */
const tomorrow = () => new Date(Date.now() + 5 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);

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
  const manager = api.addUser('pam@example.test', PASSWORD, 'Pam Manager');
  api.addMembership(org.id, manager.id, 'PROPERTY_MANAGER', property.id);
  const area = (name: string, type: 'POOL' | 'FUNCTION_ROOM') => {
    const a = {
      id: randomUUID(),
      propertyId: property.id,
      buildingId: null,
      name,
      type,
      status: 'ACTIVE' as const,
      archivedAt: null,
      createdAt: new Date().toISOString(),
    };
    api.commonAreas.push(a);
    return a;
  };
  const base = `/organisations/${org.id}/properties/${property.id}`;
  return {
    api,
    tenant,
    manager,
    property,
    area,
    base,
    unitPath: `${base}/units/${unit.id}`,
  };
}

test.describe('facilities', () => {
  test('a tenant books a free time, sees it confirmed and cancels it', async ({ page }) => {
    const { api, tenant, property, area, unitPath } = setup();
    api.facilities.add(property.id, area('Pool', 'POOL').id, 'Pool');
    api.currentUserId = tenant.id;
    await api.install(page);

    await page.goto(unitPath);
    await page.getByRole('link', { name: 'Book a facility' }).click();
    await expect(page.getByRole('heading', { name: 'Facilities', level: 1 })).toBeVisible();
    await expect(page.getByText('Bookings are confirmed at once.')).toBeVisible();
    await page.getByLabel('Day').fill(tomorrow());
    const picker = page.getByRole('form', { name: 'Book a time' });
    await expect(picker.getByRole('button', { name: /^06:00/ })).toBeVisible();
    await picker.getByRole('button', { name: /^10:00/ }).click();
    await picker.getByLabel('What it is for (optional)').fill('Swimming lesson');
    await picker.getByRole('button', { name: 'Book from 10:00' }).click();
    await expect(page.getByText('BK-000001: confirmed.')).toBeVisible();
    // The time is now taken.
    await expect(picker.getByRole('button', { name: /^10:00/ })).toBeDisabled();
    const list = page.getByRole('list', { name: 'Bookings' });
    await expect(list.getByText('confirmed')).toBeVisible();
    await expect(list.getByText(/Swimming lesson/)).toBeVisible();
    await expectAccessible(page);

    await list.getByRole('button', { name: 'Cancel booking' }).click();
    await list.getByLabel('Reason (optional)').fill('Plans changed');
    await list.getByRole('button', { name: 'Cancel booking' }).click();
    await expect(list.getByText('cancelled')).toBeVisible();
    await expect(list.getByText('Reason: Plans changed')).toBeVisible();

    // Phones: the slot grid fits without sideways scrolling.
    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('a manager makes a room bookable with approval and approves a booking', async ({ page }) => {
    const { api, tenant, manager, area, base, unitPath } = setup();
    area('Party room', 'FUNCTION_ROOM');
    api.currentUserId = manager.id;
    await api.install(page);

    await page.goto(base);
    await page.getByRole('link', { name: 'Open facilities' }).click();
    await expect(page.getByRole('heading', { name: 'Facilities', level: 1 })).toBeVisible();
    await expect(page.getByText('No common area is bookable yet.')).toBeVisible();
    const create = page.getByRole('form', { name: 'Make a common area bookable' });
    await create.getByLabel('Bookings need approval').check();
    await create.getByRole('button', { name: 'Make bookable' }).click();
    await expect(page.getByRole('heading', { name: /Party room/, level: 1 })).toBeVisible();
    await expect(
      page.getByText('Bookings wait for the property team to approve them.'),
    ).toBeVisible();
    await expectAccessible(page);

    // The tenant asks for a time.
    api.currentUserId = tenant.id;
    await page.goto(`${unitPath}/facilities`);
    await page.getByLabel('Day').fill(tomorrow());
    const picker = page.getByRole('form', { name: 'Book a time' });
    await picker.getByRole('button', { name: /^18:00/ }).click();
    await picker.getByRole('button', { name: 'Book from 18:00' }).click();
    await expect(page.getByText('BK-000001: the property team will confirm it.')).toBeVisible();

    // The manager approves it from the queue.
    api.currentUserId = manager.id;
    await page.goto(`${base}/facilities`);
    const queue = page.getByRole('list', { name: 'Facility bookings' });
    await expect(queue.getByText('waiting for approval')).toBeVisible();
    await expect(queue.getByText(/Unit 101/)).toBeVisible();
    await queue.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('No bookings to show.')).toBeVisible();
    await page.getByLabel('Show').selectOption('CONFIRMED');
    await expect(queue.getByText('confirmed')).toBeVisible();
    await expectAccessible(page);
  });
});
