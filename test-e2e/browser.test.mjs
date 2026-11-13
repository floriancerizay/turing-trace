// Non-régression en vrai navigateur : un headless naïf doit être refusé, un profil normal accepté.
// Local : CHROMIUM_PATH=/chemin/vers/chrome npm run test:e2e   (CI : navigateur installé par playwright-core)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createApp } from '../server.js';
import { humanClick, humanType, wander, normalBrowserIdentity } from '../redteam/human.mjs';

let server, base, browser;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  server = await new Promise((r) => {
    const s = createApp({ secret: 'e2e', minScore: 60 }).listen(0, () => r(s));
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

async function interact(page) {
  await page.waitForFunction(
    () => document.querySelector('#powStatus').textContent.includes('solved'),
    null,
    { timeout: 30000 },
  );
  await wander(page, 4);
  await humanClick(page, '#typing');
  await wait(400);
  await humanType(page, 'bonjour le monde ceci est un test');
  await wait(2500); // dépasse aussi l'âge minimum du jeton (2 s)
}

test('headless naïf : refusé, avec les bonnes règles déclenchées', async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/?mode=server`);
  await interact(page);
  const hits = await page.$$eval('#rules details.hit .name', (n) => n.map((x) => x.textContent));
  assert.ok(
    hits.some((h) => h.includes('webdriver')),
    'webdriver détecté',
  );
  assert.ok(
    hits.some((h) => h.includes('Headless')),
    'UA headless détecté',
  );
  assert.ok(Number(await page.textContent('#gaugeVal')) < 40);
  await page.click('#btnSubmit');
  await page.waitForSelector('.final');
  assert.match(await page.textContent('.final'), /rejected/g);
  await page.close();
});

test('profil navigateur normal : accepté, rejeu et score forgé refusés', async () => {
  // Fixture sur notre propre page : masque les indicateurs d'automatisation pour tester le chemin d'acceptation.
  const ctx = await browser.newContext();
  // Le GPU logiciel (SwiftShader) n'est pas masqué : le profil doit passer malgré ce malus de 30 points.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = {};
    Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    speechSynthesis.getVoices = () => [{ name: 'Test voice', lang: 'en-US' }];
  });
  const page = await ctx.newPage();
  // Identité réécrite au niveau du moteur (DevTools), donc cohérente entre JavaScript et en-têtes HTTP.
  await (
    await ctx.newCDPSession(page)
  ).send('Emulation.setUserAgentOverride', normalBrowserIdentity());
  await page.goto(`${base}/?mode=server`);
  await interact(page);
  const hits = await page.$$eval('#rules details.hit .name', (n) =>
    n.map((x) => x.textContent.trim()),
  );
  await humanClick(page, '#btnSubmit');
  await page.waitForSelector('.final');
  const failed = await page.$$eval('#result li', (n) =>
    n.filter((li) => li.className === 'ko').map((li) => li.textContent.trim()),
  );
  assert.match(
    await page.textContent('.final'),
    /accepted/,
    `règles : ${hits.join(' | ')} ; étape refusée : ${failed.join(' ; ')}`,
  );
  await page.click('#btnReplay');
  await wait(500);
  assert.match(await page.textContent('.final'), /rejected/g);
  await ctx.close();
});
