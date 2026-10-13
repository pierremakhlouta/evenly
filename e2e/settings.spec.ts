import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { addExpense, householdGroup, samPhone } from './db';

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await page.screenshot({
    path: `e2e/screenshots/${test.info().project.name}-${name}.png`,
    fullPage: true,
  });
}

async function settingsAs(page: Page, token: string): Promise<void> {
  await page.addInitScript((t) => {
    localStorage.setItem('evenly.device-token', t);
  }, token);
  await page.goto('./#/settings');
}

const sheet = (page: Page) => page.locator('dialog.sheet');
const person = (page: Page, name: string) =>
  page.getByRole('button', { name: new RegExp(`^${name}`) });

test('an admin renames and moves a person', async ({ page }) => {
  const group = householdGroup();
  await settingsAs(page, group.alexToken);
  await person(page, 'Sam').click();
  await page.getByLabel('Name').fill('Samira');
  await sheet(page).getByRole('radio', { name: 'Main floor' }).click();
  await shot(page, '30-person');
  await page.getByRole('button', { name: 'Save changes' }).click();

  const mainFloor = page
    .locator('.stack', { has: page.getByRole('heading', { name: 'Main floor', exact: true }) })
    .last();
  await expect(mainFloor.getByRole('button', { name: /^Samira/ })).toBeVisible();
});

test('admins, PIN reset and removing someone', async ({ page }) => {
  const group = householdGroup();
  samPhone(group);
  await settingsAs(page, group.alexToken);

  await person(page, 'Sam').click();
  await sheet(page).getByRole('button', { name: 'Make admin' }).click();
  await expect(person(page, 'Sam')).toContainText('Admin');

  page.once('dialog', (d) => void d.accept());
  await person(page, 'Sam').click();
  await sheet(page).getByRole('button', { name: 'Reset PIN' }).click();
  await expect(person(page, 'Sam')).toContainText('No PIN yet');

  page.once('dialog', (d) => void d.accept());
  await person(page, 'Sam').click();
  await sheet(page).getByRole('button', { name: 'Remove from group' }).click();
  await expect(person(page, 'Sam')).toHaveCount(0);
  await page.getByText('Removed people (1)').click();
  await expect(page.locator('details .list-item', { hasText: 'Sam' })).toBeVisible();
});

test('the last admin cannot step down, and nobody can remove themselves', async ({ page }) => {
  const group = householdGroup();
  await settingsAs(page, group.alexToken);
  await person(page, 'Alex').click();
  await expect(sheet(page).getByText("You can't remove yourself.")).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Remove admin' }).click();
  await expect(sheet(page).getByRole('alert')).toHaveText(
    'The group needs at least one admin. Make someone else admin first.',
  );
});

test('a non-admin sees people but cannot change them', async ({ page }) => {
  const group = householdGroup();
  await settingsAs(page, samPhone(group));
  await expect(page.getByText('Only an admin can add or change people.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Alex/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add person' })).toHaveCount(0);
});

test('phones: list and revoke', async ({ page }) => {
  const group = householdGroup();
  samPhone(group, 'Kitchen iPad');
  await settingsAs(page, group.alexToken);

  const phones = page.locator('section', { has: page.getByRole('heading', { name: 'Phones' }) });
  await expect(phones.locator('.device-row')).toHaveCount(2);
  await expect(phones.getByText('Alex · This phone')).toBeVisible();
  await expect(phones.locator('.device-row', { hasText: 'Kitchen iPad' })).toContainText(
    'Sam · Last seen',
  );
  await shot(page, '31-phones');

  page.once('dialog', (d) => void d.accept());
  await phones.getByRole('button', { name: 'Revoke Kitchen iPad' }).click();
  await expect(phones.locator('.device-row')).toHaveCount(1);
});

test('export downloads a CSV of every entry', async ({ page }) => {
  const group = householdGroup();
  addExpense(group, 'Hydro, October', 10001);
  await settingsAs(page, group.alexToken);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all entries (CSV)' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^evenly-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync(await file.path(), 'utf8');
  expect(csv).toContain('Date,Description,Type,Total,Paid by');
  expect(csv).toContain('"Hydro, October",Expense,100.01,Main floor,Alex,1/3,66.67,33.34,Alex');
});

test('the notifications switch explains why it is off when push is not available', async ({
  page,
}) => {
  const group = householdGroup();
  await settingsAs(page, group.alexToken);
  const section = page.locator('section', {
    has: page.getByRole('heading', { name: 'Notifications' }),
  });
  await expect(section.getByLabel('Notifications on this phone')).toBeDisabled();
  // The dev server has no service worker and no push key, so it says so plainly.
  await expect(section.locator('.field-hint')).toHaveText(
    /set up|can't show notifications|Home Screen/,
  );
});
