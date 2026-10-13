import { expect, test, type Page } from '@playwright/test';
import { addExpense, addPayment, emptyGroup, GROUP_PIN, householdGroup, PERSONAL_PIN } from './db';

/** Saves a screenshot to e2e/screenshots for review. */
async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await page.screenshot({
    path: `e2e/screenshots/${test.info().project.name}-${name}.png`,
    fullPage: true,
  });
}

/** Opens the app as a phone that already joined (skips the join screen). */
async function asPhone(page: Page, token: string): Promise<void> {
  await page.addInitScript((t) => {
    localStorage.setItem('evenly.device-token', t);
  }, token);
  await page.goto('./');
}

const balance = (page: Page) => page.locator('.balance-label');

test('the refresh button icon is visible', async ({ page }) => {
  const group = householdGroup();
  await asPhone(page, group.alexToken);
  const box = await page.getByRole('button', { name: 'Refresh' }).locator('svg').boundingBox();
  expect(box?.width).toBe(24);
  expect(box?.height).toBe(24);
});
const sheet = (page: Page) => page.locator('dialog.sheet');

test('the first person joins an empty group and becomes admin', async ({ page }) => {
  const code = emptyGroup();
  await page.goto('./');
  await shot(page, '01-join');
  await page.getByLabel('Group code').fill(code.toLowerCase());
  await page.getByLabel('PIN').fill(GROUP_PIN);
  await page.getByRole('button', { name: 'Join' }).click();

  await expect(page.getByText("so you'll be its admin")).toBeVisible();
  await page.getByLabel('Your name').fill('Alex');
  await page.getByRole('radio', { name: 'Household 1' }).click();
  await page.getByLabel('Your PIN').fill(PERSONAL_PIN);
  await page.getByLabel('Repeat the PIN').fill(PERSONAL_PIN);
  await shot(page, '02-first-person');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(balance(page)).toHaveText('All settled up');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.list-item', { hasText: 'Alex' }).getByText('Admin')).toBeVisible();
});

test('a wrong group PIN is refused', async ({ page }) => {
  const code = emptyGroup();
  await page.goto('./');
  await page.getByLabel('Group code').fill(code);
  await page.getByLabel('PIN').fill('0000');
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.getByRole('alert')).toHaveText("That group code and PIN don't match.");
});

test('a person added by the admin creates their PIN on first pick', async ({ page }) => {
  const group = householdGroup();
  await page.goto('./');
  await page.getByLabel('Group code').fill(group.code);
  await page.getByLabel('PIN').fill(GROUP_PIN);
  await page.getByRole('button', { name: 'Join' }).click();

  await page.getByRole('button', { name: 'Sam' }).click();
  await expect(page.getByText('Create a PIN for Sam')).toBeVisible();
  await page.getByLabel('New PIN').fill('8642');
  await page.getByLabel('Repeat the PIN').fill('8642');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(balance(page)).toHaveText('All settled up');

  // Switching to Alex needs Alex's PIN.
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /You are/ }).click();
  await page.getByRole('button', { name: 'Alex' }).click();
  await page.getByLabel('PIN', { exact: true }).fill('0000');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toHaveText("That PIN isn't right.");
});

test('add expense: dinner $90, I paid, their share $35', async ({ page }) => {
  const group = householdGroup();
  await asPhone(page, group.alexToken);
  await page.getByRole('button', { name: 'Add expense' }).click();

  await page.getByLabel('Description').fill('Dinner');
  await page.getByLabel('Amount', { exact: true }).fill('90');
  await page.getByRole('radio', { name: 'More' }).click();
  await page.locator('[name="share-amount"]').fill('35');
  await expect(sheet(page).locator('.preview')).toHaveText('Basement suite owes you $35.00');
  await shot(page, '03-add-expense');
  await page.getByRole('button', { name: 'Add expense' }).last().click();

  await expect(balance(page)).toHaveText('Basement suite owes you');
  await expect(page.locator('.balance-amount')).toHaveText('$35.00');
  await expect(page.locator('.entry-row', { hasText: 'Dinner' })).toContainText(
    "You're owed $35.00",
  );
  await shot(page, '04-home');
});

test('add expense when the other household paid uses "your share"', async ({ page }) => {
  const group = householdGroup();
  await asPhone(page, group.alexToken);
  await page.getByRole('button', { name: 'Add expense' }).click();
  await page.getByLabel('Description').fill('Dinner');
  await page.getByLabel('Amount', { exact: true }).fill('90');
  await page.getByRole('radio', { name: 'Basement suite' }).click();
  await page.getByRole('radio', { name: 'More' }).click();
  await page.locator('[name="share-amount"]').fill('40');
  await expect(sheet(page).getByText('Your share')).toBeVisible();
  await expect(sheet(page).locator('.preview')).toHaveText('You owe Basement suite $40.00');
  await page.getByRole('button', { name: 'Add expense' }).last().click();
  await expect(balance(page)).toHaveText('You owe Basement suite');
});

test('settle full balance starts a new period', async ({ page }) => {
  const group = householdGroup();
  addExpense(group, 'Hydro', 9000);
  await asPhone(page, group.alexToken);
  await expect(page.locator('.balance-amount')).toHaveText('$30.00');

  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.getByRole('button', { name: 'Settle full balance' }).click();
  await expect(page.locator('[name="amount"]')).toHaveValue('30.00');
  await shot(page, '05-settle');
  await page.getByRole('button', { name: 'Settle up' }).click();

  await expect(balance(page)).toHaveText('All settled up');
  await expect(
    page.locator('.section-title', { hasText: 'Since you settled up on' }),
  ).toBeVisible();
  await expect(page.getByText('Nothing new since you settled up.')).toBeVisible();

  await page.getByRole('link', { name: 'Settings', exact: true }).click(); // leave and come back through History
  await page.getByRole('link', { name: 'History', exact: true }).click();
  await expect(page.locator('.period', { hasText: 'Settled $30.00' })).toBeVisible();
  await shot(page, '06-history');
});

test('entry details: change log, delete and restore', async ({ page }) => {
  const group = householdGroup();
  addExpense(group, 'Water', 6000);
  await asPhone(page, group.alexToken);

  await page.locator('.entry-row', { hasText: 'Water' }).click();
  await expect(sheet(page).locator('.detail-total')).toHaveText('$60.00');
  await expect(sheet(page).getByText(/^Added by Alex/)).toBeVisible();
  await shot(page, '07-details');

  page.once('dialog', (d) => void d.accept());
  await sheet(page).getByRole('button', { name: 'Delete' }).click();
  await expect(balance(page)).toHaveText('All settled up');
  await expect(page.locator('.entry-row', { hasText: 'Water' })).toHaveCount(0);

  await page.getByRole('link', { name: 'History', exact: true }).click();
  await page.getByRole('link', { name: /Deleted entries/ }).click();
  await page.locator('.entry-row', { hasText: 'Water' }).click();
  await sheet(page).getByRole('button', { name: 'Restore' }).click();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.locator('.balance-amount')).toHaveText('$20.00');
});

test('offline shows a banner', async ({ page, context }) => {
  const group = householdGroup();
  await asPhone(page, group.alexToken);
  await expect(balance(page)).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByRole('status')).toHaveText(
    "You're offline. Changes are paused until you reconnect.",
  );
  await context.setOffline(false);
  await expect(page.getByRole('status')).toBeHidden();
});

test.describe('dark mode', () => {
  test.use({ colorScheme: 'dark' });

  test('home and the expense sheet render in dark mode', async ({ page }) => {
    const group = householdGroup();
    addExpense(group, 'Hydro', 13412);
    await asPhone(page, group.alexToken);
    await expect(page.locator('.balance-amount')).toHaveText('$44.71');
    await shot(page, '08-dark-home');
    await page.getByRole('button', { name: 'Add expense' }).click();
    await shot(page, '09-dark-sheet');
  });
});

test('edit an expense: the form is pre-filled and the change log shows the difference', async ({
  page,
}) => {
  const group = householdGroup();
  addExpense(group, 'Hydro', 9000);
  await asPhone(page, group.alexToken);
  await expect(page.locator('.balance-amount')).toHaveText('$30.00');

  await page.locator('.entry-row', { hasText: 'Hydro' }).click();
  await sheet(page).getByRole('button', { name: 'Edit' }).click();
  await expect(sheet(page).locator('.sheet-title')).toHaveText('Edit expense');
  await expect(page.getByLabel('Description')).toHaveValue('Hydro');
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('90.00');
  await expect(page.getByRole('radio', { name: '1/3' })).toHaveAttribute('aria-checked', 'true');

  await page.getByLabel('Amount', { exact: true }).fill('120');
  await page.getByRole('radio', { name: '1/2' }).click();
  await expect(sheet(page).locator('.preview')).toHaveText('Basement suite owes you $60.00');
  await shot(page, '10-edit');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.locator('.balance-amount')).toHaveText('$60.00');
  await page.locator('.entry-row', { hasText: 'Hydro' }).click();
  await expect(sheet(page).getByText('Amount: $90.00 → $120.00')).toBeVisible();
  await expect(sheet(page).getByText('Split: 1/3 → 1/2')).toBeVisible();
  await shot(page, '11-change-log');
});

test('edit keeps a custom $ share pre-filled', async ({ page }) => {
  const group = householdGroup();
  addExpense(group, 'Dinner', 9000, 'amount', 3500);
  await asPhone(page, group.alexToken);
  await page.locator('.entry-row', { hasText: 'Dinner' }).click();
  await sheet(page).getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('radio', { name: 'More' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[name="share-amount"]')).toHaveValue('35.00');
  await expect(sheet(page).locator('.preview')).toHaveText('Basement suite owes you $35.00');
});

test('edit a payment', async ({ page }) => {
  const group = householdGroup();
  addExpense(group, 'Rent', 30000);
  addPayment(group, 'E-transfer', 5000);
  await asPhone(page, group.alexToken);
  await expect(page.locator('.balance-amount')).toHaveText('$50.00');

  await page.locator('.entry-row', { hasText: 'E-transfer' }).click();
  await sheet(page).getByRole('button', { name: 'Edit' }).click();
  await expect(sheet(page).locator('.sheet-title')).toHaveText('Edit payment');
  await expect(sheet(page).locator('.settle-card')).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Basement suite paid' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByLabel('Amount', { exact: true }).fill('80');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('.balance-amount')).toHaveText('$20.00');
});
