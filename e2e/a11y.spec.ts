/**
 * Automated accessibility checks (axe-core, WCAG 2.2 A and AA) on every screen and
 * sheet, in light and dark mode.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  addBill,
  addExpense,
  addGroupExpense,
  emptyGroup,
  householdGroup,
  peopleGroup,
} from './db';

async function audit(page: Page, label: string): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const problems = results.violations.map(
    (v) =>
      `${label}: ${v.id} (${v.impact ?? ''}) ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`,
  );
  expect(problems, problems.join('\n\n')).toEqual([]);
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test('join and who-are-you screens', async ({ page }) => {
      const group = householdGroup();
      await page.goto('./');
      await audit(page, 'join');
      await page.getByLabel('Group code').fill(group.code);
      await page.getByLabel('PIN').fill('2468');
      await page.getByRole('button', { name: 'Join' }).click();
      await page.getByRole('button', { name: 'Sam' }).waitFor();
      await audit(page, 'who');
      await page.getByRole('button', { name: 'Sam' }).click();
      await audit(page, 'create PIN');
    });

    test('first person form', async ({ page }) => {
      const code = emptyGroup();
      await page.goto('./');
      await page.getByLabel('Group code').fill(code);
      await page.getByLabel('PIN').fill('2468');
      await page.getByRole('button', { name: 'Join' }).click();
      await page.getByLabel('Your name').waitFor();
      await audit(page, 'first person');
    });

    test('people mode: home, split picker, payment and settle up', async ({ page }) => {
      const group = peopleGroup();
      addGroupExpense(group, 'Cabin', 12000);
      await page.addInitScript((t) => {
        localStorage.setItem('evenly.device-token', t);
      }, group.danaToken);
      await page.goto('./');
      await page.locator('.balance-amount').waitFor();
      await audit(page, 'people home');

      await page.getByRole('button', { name: 'Add expense' }).click();
      await page.getByLabel('Amount', { exact: true }).fill('90');
      await page.getByRole('radio', { name: 'Amounts' }).click();
      await audit(page, 'people expense');
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Record payment' }).click();
      await audit(page, 'people payment');
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Settle up everyone' }).click();
      await audit(page, 'settle up everyone');
    });

    test('home, sheets, history and settings', async ({ page }) => {
      const group = householdGroup();
      addExpense(group, 'Hydro', 13412);
      addBill(group, 'Wifi', 'half', 8500);
      await page.addInitScript((t) => {
        localStorage.setItem('evenly.device-token', t);
      }, group.alexToken);
      await page.goto('./');
      await page.locator('.balance-amount').waitFor();
      await audit(page, 'home');

      await page.getByRole('button', { name: 'Add expense' }).click();
      await page.getByRole('radio', { name: 'More' }).click();
      await audit(page, 'add expense');
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Record payment' }).click();
      await audit(page, 'record payment');
      await page.keyboard.press('Escape');

      await page.locator('.entry-row').first().click();
      await page.getByText(/^Added by/).waitFor();
      await audit(page, 'entry details');
      await page.keyboard.press('Escape');

      await page.getByRole('link', { name: 'History', exact: true }).click();
      await page.getByRole('link', { name: /Deleted entries/ }).waitFor();
      await audit(page, 'history');

      await page.getByRole('link', { name: 'Settings', exact: true }).click();
      await page.locator('.device-row').first().waitFor();
      await audit(page, 'settings');

      await page.getByRole('button', { name: 'Add bill' }).click();
      await audit(page, 'bill form');
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: /^Sam/ }).click();
      await audit(page, 'person sheet');
    });
  });
}
