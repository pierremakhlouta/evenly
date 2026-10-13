/**
 * Renders public/icon.svg into the PNG icons phones need, using Playwright's
 * Chromium (already a dev dependency), so no image tools are required.
 * Run `npm run icons` after changing the SVG, then commit the PNGs.
 *
 * - apple-touch-icon.png (180): iPhone home screen; iOS rounds the corners itself.
 * - icon-192.png, icon-512.png: Android and the web app manifest.
 * - icon-maskable-512.png: Android adaptive icons; the drawing is shrunk into the
 *   central safe zone so no launcher shape ever cuts it off.
 */
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const svg = readFileSync('public/icon.svg', 'utf8');

const targets = [
  { file: 'public/apple-touch-icon.png', size: 180, maskable: false },
  { file: 'public/icon-192.png', size: 192, maskable: false },
  { file: 'public/icon-512.png', size: 512, maskable: false },
  { file: 'public/icon-maskable-512.png', size: 512, maskable: true },
];

const browser = await chromium.launch();
for (const t of targets) {
  const page = await browser.newPage({ viewport: { width: t.size, height: t.size } });
  // Maskable: keep the blue full bleed, scale the drawing to 72% around the centre.
  const art = t.maskable
    ? svg.replace(/<g /, '<g transform="translate(71.68 71.68) scale(0.72)" ')
    : svg;
  await page.setContent(
    `<html><body style="margin:0">${art.replace('<svg ', `<svg width="${String(t.size)}" height="${String(t.size)}" `)}</body></html>`,
  );
  await page.screenshot({ path: t.file, clip: { x: 0, y: 0, width: t.size, height: t.size } });
  await page.close();
  console.log(`Wrote ${t.file}`);
}
await browser.close();
