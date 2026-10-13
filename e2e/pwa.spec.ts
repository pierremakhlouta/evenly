import { expect, test } from '@playwright/test';

interface Manifest {
  name: string;
  display: string;
  start_url: string;
  icons: { src: string; sizes: string; purpose: string }[];
}

test('the manifest and every icon load', async ({ page, request }) => {
  await page.goto('./');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifestUrl = new URL(href ?? '', page.url()).toString();
  const manifest = (await (await request.get(manifestUrl)).json()) as Manifest;
  expect([manifest.name, manifest.display, manifest.start_url]).toEqual([
    'Evenly',
    'standalone',
    './',
  ]);
  expect(manifest.icons.map((i) => i.purpose)).toContain('maskable');

  for (const icon of manifest.icons) {
    const res = await request.get(new URL(icon.src, manifestUrl).toString());
    expect(res.headers()['content-type']).toBe('image/png');
  }
  const touch = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  expect((await request.get(new URL(touch ?? '', page.url()).toString())).ok()).toBe(true);
});

test('the app opens offline after the first visit, and never caches data', async ({
  page,
  context,
}) => {
  await page.goto('./');
  await expect(page.getByLabel('Group code')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload(); // now controlled by the service worker
  await expect(page.getByLabel('Group code')).toBeVisible();

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByLabel('Group code')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(
    "You're offline. Changes are paused until you reconnect.",
  );

  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const urls: string[] = [];
    for (const key of keys) {
      for (const req of await (await caches.open(key)).keys()) urls.push(req.url);
    }
    return urls;
  });
  expect(cached.length).toBeGreaterThan(0);
  expect(cached.every((u) => u.startsWith('http://localhost:5175/evenly/'))).toBe(true);
  await context.setOffline(false);
});
