// D3 : un score limite déclenche une vérification supplémentaire au lieu d'un refus (tableau de bord, mode démo).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createApp } from '../server.js';
import { humanClick, humanType, wander, normalBrowserIdentity } from '../redteam/human.mjs';

let server, base, browser;
before(async () => {
  server = await new Promise((r) => {
    const s = createApp({ secret: 'palier' }).listen(0, () => r(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'],
  });
});
after(async () => {
  await browser?.close();
  server?.close();
});

test('palier : seuil relevé à 80, un visiteur à 70 est accepté après vérification supplémentaire (seuil abaissé à 60)', async () => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = {};
    Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    speechSynthesis.getVoices = () => [{ name: 'v', lang: 'en' }];
  });
  const page = await ctx.newPage();
  await (
    await ctx.newCDPSession(page)
  ).send('Emulation.setUserAgentOverride', normalBrowserIdentity());
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/?mode=demo`);
  await page.waitForFunction(
    () => document.querySelector('#powStatus').textContent.includes('solved'),
    null,
    { timeout: 30000 },
  );

  // Seuil à 80 : le visiteur (70, GPU logiciel) tombe dans la bande [60, 80[.
  await page.evaluate(() => {
    const el = document.querySelector('#thr');
    el.value = 80;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wander(page, 4);
  await humanClick(page, '#typing');
  await page.waitForTimeout(400);
  await humanType(page, 'bonjour le monde ceci est un test');
  await page.waitForTimeout(2500);
  await humanClick(page, '#btnSubmit');
  await page.waitForSelector('.final', { timeout: 60000 });

  assert.match(await page.textContent('.final'), /accepted/);
  assert.match(
    await page.textContent('#result'),
    /threshold of 60/,
    'le seuil appliqué est le seuil abaissé (80 − 20)',
  );
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('palier : un robot (webdriver) dans la même bande est refusé sans palier', async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/?mode=demo`);
  await page.waitForFunction(
    () => document.querySelector('#powStatus').textContent.includes('solved'),
    null,
    { timeout: 30000 },
  );
  await page.evaluate(() => {
    const el = document.querySelector('#thr');
    el.value = 100;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(2300);
  await page.click('#btnSubmit');
  await page.waitForSelector('.final');
  assert.match(await page.textContent('.final'), /rejected/);
  assert.doesNotMatch(await page.textContent('#result'), /extra check/);
  await page.close();
});
