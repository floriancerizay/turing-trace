// Page d'administration : saisie du jeton, affichage des statistiques, mauvais jeton.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createApp } from '../server.js';
import { humanClick, humanType, wander, normalBrowserIdentity } from '../redteam/human.mjs';

let server, base, browser;
before(async () => {
  server = await new Promise((r) => {
    const s = createApp({ secret: 'adm', adminToken: 'jeton-admin' }).listen(0, () => r(s));
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

test('admin : une décision réelle apparaît dans les statistiques ; un mauvais jeton est refusé ; FR/EN', async () => {
  // une soumission réelle (refusée : headless naïf) pour alimenter le journal
  const visitor = await browser.newPage();
  await visitor.goto(`${base}/?mode=server`);
  await visitor.waitForFunction(
    () => document.querySelector('#powStatus').textContent.includes('solved'),
    null,
    { timeout: 30000 },
  );
  await visitor.waitForTimeout(2200);
  await visitor.click('#btnSubmit');
  await visitor.waitForSelector('.final');
  await visitor.close();

  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${base}/admin.html`);

  await page.fill('#token', 'mauvais');
  await page.click('#loginForm button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#error').textContent.length > 0);
  assert.match(await page.textContent('#error'), /Wrong token/);
  assert.equal(await page.isHidden('#results'), true);

  await page.fill('#token', 'jeton-admin');
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#results:not([hidden])');
  assert.equal(await page.textContent('#total'), '1');
  assert.equal(await page.textContent('#accepted'), '0');
  assert.match(await page.textContent('#rules'), /navigator\.webdriver/);
  assert.match(await page.textContent('#steps'), /HTTP headers/); // un headless naïf est refusé dès l'étape des en-têtes

  await page.click('[data-lang="fr"]');
  assert.match(await page.textContent('h1'), /Statistiques des décisions/);
  assert.match(await page.textContent('#rules'), /navigator\.webdriver/);
  assert.deepEqual(errs, []);
  await page.close();
});
