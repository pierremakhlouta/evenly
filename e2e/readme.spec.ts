/**
 * README screenshots, taken from the fake seed data only (Maple Street, signed in as
 * Alex). Run with `npm run screenshots`, which resets the local database first.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const OUT = 'docs/screenshots';

async function snap(page: Page, name: string): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

async function signInAsAlex(page: Page): Promise<void> {
  await page.goto('./');
  await page.getByLabel('Group code').fill('HHHH-2222');
  await page.getByLabel('PIN').fill('1234');
  await page.getByLabel('Name this phone').fill('Alex’s iPhone');
  await page.getByRole('button', { name: 'Join' }).click();
  await page.getByRole('button', { name: 'Alex' }).click();
  await page.getByLabel('PIN', { exact: true }).fill('1234');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.balance-amount')).toBeVisible();
}

test('light mode screens', async ({ page }) => {
  await signInAsAlex(page);
  await snap(page, 'home');

  await page.getByRole('button', { name: 'Add expense' }).click();
  await page.getByLabel('Description').fill('Dinner');
  await page.getByLabel('Amount', { exact: true }).fill('90');
  await page.getByRole('radio', { name: 'More' }).click();
  await page.locator('[name="share-amount"]').fill('35');
  await page.locator('[name="share-amount"]').blur();
  await page.locator('.preview').evaluate((el) => {
    el.scrollIntoView({ block: 'center' });
  });
  await snap(page, 'add-expense');
  await page.keyboard.press('Escape');

  await page.locator('.entry-row', { hasText: 'Hydro' }).first().click();
  await page.getByText(/^Edited by/).waitFor();
  await page.locator('dialog.sheet').evaluate((d) => {
    d.scrollTo(0, d.scrollHeight);
  });
  await snap(page, 'entry-details');
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'History', exact: true }).click();
  await page.getByRole('link', { name: /Deleted entries/ }).waitFor();
  await snap(page, 'history');
});

test.describe('dark mode', () => {
  test.use({ colorScheme: 'dark' });

  test('dark home and payment', async ({ page }) => {
    await signInAsAlex(page);
    await page.getByRole('button', { name: 'Record payment' }).click();
    await page.getByRole('button', { name: 'Settle full balance' }).click();
    await snap(page, 'settle-up-dark');
  });
});
