import { expect, test, type Page } from '@playwright/test';
import { addBill, householdGroup } from './db';

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await page.screenshot({
    path: `e2e/screenshots/${test.info().project.name}-${name}.png`,
    fullPage: true,
  });
}

async function asPhone(page: Page, token: string, hash = ''): Promise<void> {
  await page.addInitScript((t) => {
    localStorage.setItem('evenly.device-token', t);
  }, token);
  await page.goto(`./${hash}`);
}

const sheet = (page: Page) => page.locator('dialog.sheet');
const chips = (page: Page) => page.getByRole('group', { name: 'Saved bills' }).getByRole('button');

test('a bill shortcut pre-fills Add expense', async ({ page }) => {
  const group = householdGroup();
  addBill(group, 'Hydro', 'third');
  addBill(group, 'Wifi', 'half', 8500);
  addBill(group, 'Rent', 'third', 240000, true);
  await asPhone(page, group.alexToken);

  // Automatic bills add themselves, so only shortcuts get a button.
  await expect(chips(page)).toHaveText(['Hydro', 'Wifi']);
  await shot(page, '20-bill-chips');

  await chips(page).filter({ hasText: 'Hydro' }).click();
  await expect(sheet(page).locator('.sheet-title')).toHaveText('Hydro');
  await expect(page.getByLabel('Description')).toHaveValue('Hydro');
  await expect(page.getByRole('radio', { name: '1/3' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('Amount', { exact: true })).toBeFocused();
  await page.getByLabel('Amount', { exact: true }).fill('134.12');
  await expect(sheet(page).locator('.preview')).toHaveText('Basement suite owes you $44.71');
  await page.getByRole('button', { name: 'Add expense' }).last().click();
  await expect(page.locator('.balance-amount')).toHaveText('$44.71');

  await chips(page).filter({ hasText: 'Wifi' }).click();
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('85.00');
  await expect(page.getByRole('radio', { name: '1/2' })).toHaveAttribute('aria-checked', 'true');
});

test('add an automatic bill and a shortcut in Settings', async ({ page }) => {
  const group = householdGroup();
  await asPhone(page, group.alexToken, '#/settings');

  await page.getByRole('button', { name: 'Add bill' }).click();
  await page.getByLabel('Name').fill('Rent');
  await page
    .getByRole('switch', { name: 'Add automatically every month' })
    .or(page.getByLabel('Add automatically every month'))
    .check();
  await page.getByRole('button', { name: 'Add bill' }).last().click();
  await expect(sheet(page).getByRole('alert')).toHaveText(
    'An automatic bill needs its usual amount.',
  );

  await page.getByLabel('Usual amount').fill('2400');
  await expect(sheet(page).getByRole('alert')).toBeHidden();
  await page.getByLabel('Day of the month').selectOption('5');
  await expect(sheet(page).locator('.preview')).toHaveText(
    'Basement suite owes you $800.00, added on the 5th of every month.',
  );
  await shot(page, '21-bill-form');
  await page.getByRole('button', { name: 'Add bill' }).last().click();
  await expect(page.locator('.bill-row', { hasText: 'Rent' })).toContainText(
    'Added on the 5th · $2,400.00',
  );

  await page.getByRole('button', { name: 'Add bill' }).click();
  await page.getByLabel('Name').fill('Gas');
  await page.getByRole('radio', { name: 'Basement suite' }).click();
  await page.getByRole('radio', { name: '1/2' }).click();
  await page.getByRole('button', { name: 'Add bill' }).last().click();
  await expect(page.locator('.bill-row', { hasText: 'Gas' })).toContainText('Shortcut');
  await shot(page, '22-bills-settings');

  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(chips(page)).toHaveText(['Gas']);
  await chips(page).click();
  await expect(sheet(page).getByText('Your share')).toBeVisible();
});

test('reorder and archive bills', async ({ page }) => {
  const group = householdGroup();
  addBill(group, 'Hydro', 'third');
  addBill(group, 'Water', 'third');
  await asPhone(page, group.alexToken, '#/settings');

  const names = page.locator('.bill-row .entry-title');
  await expect(names).toHaveText(['Hydro', 'Water']);
  await page.getByRole('button', { name: 'Move down Hydro' }).click();
  await expect(names).toHaveText(['Water', 'Hydro']);

  await page
    .locator('.bill-row', { hasText: 'Water' })
    .getByRole('button', { name: /Water/ })
    .first()
    .click();
  page.once('dialog', (d) => void d.accept());
  await sheet(page).getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText('Archived bills (1)')).toBeVisible();

  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(chips(page)).toHaveText(['Hydro']);
});
