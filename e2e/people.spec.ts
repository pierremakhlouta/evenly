import { expect, test, type Page } from '@playwright/test';
import { addGroupExpense, peopleGroup } from './db';

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await page.screenshot({
    path: `e2e/screenshots/${test.info().project.name}-${name}.png`,
    fullPage: true,
  });
}

async function asDana(page: Page, token: string, hash = ''): Promise<void> {
  await page.addInitScript((t) => {
    localStorage.setItem('evenly.device-token', t);
  }, token);
  await page.goto(`./${hash}`);
}

const sheet = (page: Page) => page.locator('dialog.sheet');
const section = (page: Page, title: string) =>
  page.locator('section', { has: page.getByRole('heading', { name: title, exact: true }) });

test('home shows everyone and the fewest payments to settle', async ({ page }) => {
  const group = peopleGroup();
  addGroupExpense(group, 'Cabin', 12000);
  await asDana(page, group.danaToken);

  await expect(page.locator('.balance-label')).toHaveText("You're owed");
  await expect(page.locator('.balance-amount')).toHaveText('$80.00');
  await expect(section(page, 'Everyone').locator('.list-item')).toHaveText([
    'Dana (you)owed $80.00',
    'Eliowes $40.00',
    'Finnowes $40.00',
  ]);
  await expect(section(page, 'To settle up').locator('.list-item')).toHaveText([
    'Eli pays Dana$40.00',
    'Finn pays Dana$40.00',
  ]);
  await shot(page, '40-people-home');
});

test('add expense: everyone equally by default, then untick and switch methods', async ({
  page,
}) => {
  const group = peopleGroup();
  await asDana(page, group.danaToken);
  await page.getByRole('button', { name: 'Add expense' }).click();
  await page.getByLabel('Description').fill('Groceries');
  await page.getByLabel('Amount', { exact: true }).fill('90');
  await expect(sheet(page).locator('.split-share')).toHaveText(['$30.00', '$30.00', '$30.00']);
  await expect(sheet(page).locator('.preview')).toHaveText("You're owed $60.00");

  await sheet(page).getByLabel('Finn', { exact: true }).uncheck();
  await expect(sheet(page).locator('.preview')).toHaveText("You're owed $45.00");

  await page.getByRole('radio', { name: 'Percent' }).click();
  await page.getByLabel("Dana's value").fill('60');
  await page.getByLabel("Eli's value").fill('30');
  await expect(sheet(page).locator('.preview')).toHaveText('The percentages must add up to 100%.');
  await page.getByLabel("Eli's value").fill('40');
  await expect(sheet(page).locator('.preview')).toHaveText("You're owed $36.00");
  await shot(page, '41-people-expense');

  await page.getByRole('button', { name: 'Add expense' }).last().click();
  await expect(page.locator('.balance-amount')).toHaveText('$36.00');
  await expect(section(page, 'To settle up').locator('.list-item')).toHaveText([
    'Eli pays Dana$36.00',
  ]);
});

test('an expense someone else paid', async ({ page }) => {
  const group = peopleGroup();
  await asDana(page, group.danaToken);
  await page.getByRole('button', { name: 'Add expense' }).click();
  await page.getByLabel('Description').fill('Gas');
  await page.getByLabel('Amount', { exact: true }).fill('90');
  await page.getByLabel('Paid by').selectOption({ label: 'Eli' });
  await expect(sheet(page).locator('.preview')).toHaveText('You owe Eli $30.00');
  await page.getByRole('button', { name: 'Add expense' }).last().click();
  await expect(page.locator('.balance-label')).toHaveText('You owe');
});

test('record one suggested payment, then settle up everyone', async ({ page }) => {
  const group = peopleGroup();
  addGroupExpense(group, 'Cabin', 12000);
  await asDana(page, group.danaToken);

  await section(page, 'To settle up')
    .getByRole('button', { name: /Eli pays Dana/ })
    .click();
  await expect(page.getByLabel('From')).toHaveValue(group.eli);
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('40.00');
  await page.getByRole('button', { name: 'Record payment' }).last().click();
  await expect(section(page, 'To settle up').locator('.list-item')).toHaveText([
    'Finn pays Dana$40.00',
  ]);

  await page.getByRole('button', { name: 'Settle up everyone' }).click();
  await expect(sheet(page).locator('.list-item')).toHaveText(['Finn pays Dana$40.00']);
  await sheet(page).getByRole('button', { name: 'Settle up' }).click();
  await expect(page.locator('.balance-label')).toHaveText('All settled up');
  await expect(section(page, 'To settle up')).toHaveCount(0);

  await page.getByRole('link', { name: 'History', exact: true }).click();
  await expect(page.locator('.period', { hasText: 'settled $40.00' })).toBeVisible();
});

test('settling several payments at once is one period', async ({ page }) => {
  const group = peopleGroup();
  addGroupExpense(group, 'Cabin', 12000);
  await asDana(page, group.danaToken);
  await page.getByRole('button', { name: 'Settle up everyone' }).click();
  await sheet(page).getByLabel('Note').fill('E-transfers');
  await sheet(page).getByRole('button', { name: 'Settle up' }).click();
  await expect(page.locator('.balance-label')).toHaveText('All settled up');

  await page.getByRole('link', { name: 'History', exact: true }).click();
  await expect(section(page, 'Settled').locator('.period')).toHaveCount(1); // one period, not two
  await expect(page.locator('.period', { hasText: 'Settled $80.00 in 2 payments' })).toBeVisible();
  await shot(page, '42-people-history');
});

test('edit keeps the people and amounts', async ({ page }) => {
  const group = peopleGroup();
  await asDana(page, group.danaToken);
  await page.getByRole('button', { name: 'Add expense' }).click();
  await page.getByLabel('Description').fill('Tickets');
  await page.getByLabel('Amount', { exact: true }).fill('100');
  await page.getByRole('radio', { name: 'Amounts' }).click();
  await sheet(page).getByLabel('Finn', { exact: true }).uncheck();
  await page.getByLabel("Dana's value").fill('70');
  await page.getByLabel("Eli's value").fill('30');
  await page.getByRole('button', { name: 'Add expense' }).last().click();

  await page.locator('.entry-row', { hasText: 'Tickets' }).click();
  await expect(sheet(page).getByText('By amount')).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('radio', { name: 'Amounts' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(sheet(page).getByLabel('Finn', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Dana's value")).toHaveValue('70.00');
  await expect(page.getByLabel("Eli's value")).toHaveValue('30.00');
});

test('people-mode bills: a shortcut by shares, and an automatic one', async ({ page }) => {
  const group = peopleGroup();
  await asDana(page, group.danaToken, '#/settings');

  await page.getByRole('button', { name: 'Add bill' }).click();
  await page.getByLabel('Name').fill('Internet');
  await page.getByLabel('Usual amount').fill('90');
  await expect(sheet(page).locator('.preview')).toHaveText('Your part: $30.00 each time.');
  await page.getByRole('button', { name: 'Add bill' }).last().click();

  await page.getByRole('button', { name: 'Add bill' }).click();
  await page.getByLabel('Name').fill('Rent');
  await page.getByLabel('Usual amount').fill('1200');
  await page.getByRole('radio', { name: 'Shares' }).click();
  await page.getByLabel("Dana's value").fill('2');
  await page.getByLabel("Eli's value").fill('1');
  await page.getByLabel("Finn's value").fill('1');
  await page.getByLabel('Add automatically every month').check();
  await expect(sheet(page).locator('.preview')).toHaveText(
    'Your part: $600.00, added on the 1st of every month.',
  );
  await shot(page, '43-people-bill');
  await page.getByRole('button', { name: 'Add bill' }).last().click();
  await expect(page.locator('.bill-row', { hasText: 'Rent' })).toContainText(
    'Added on the 1st · $1,200.00',
  );

  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await page
    .getByRole('group', { name: 'Saved bills' })
    .getByRole('button', { name: 'Internet' })
    .click();
  await expect(page.getByLabel('Description')).toHaveValue('Internet');
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('90.00');
  await expect(sheet(page).locator('.split-share')).toHaveText(['$30.00', '$30.00', '$30.00']);
});
