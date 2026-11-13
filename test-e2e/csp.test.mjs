// E1 : la politique de sécurité (CSP) ne bloque rien de légitime sur la démo, la page d'administration et le site d'exemple.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createApp } from '../server.js';
import { createSite } from '../examples/site/server.js';

const listen = (app) =>
  new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
let tt, site, ttUrl, siteUrl, browser;

before(async () => {
  const origins = [];
  tt = await listen(createApp({ secret: 'csp', adminToken: 'adm', allowedOrigins: origins }));
  ttUrl = `http://localhost:${tt.address().port}`;
  site = await listen(createSite({ turingTraceUrl: ttUrl }));
  siteUrl = `http://localhost:${site.address().port}`;
  origins.push(siteUrl);
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'],
  });
});
after(async () => {
  await browser?.close();
  site?.close();
  tt?.close();
});

/** Page qui enregistre toute violation de CSP (événement du navigateur et message de console). */
async function watchedPage() {
  const page = await browser.newPage();
  const consoleCsp = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) consoleCsp.push(m.text());
  });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  return {
    page,
    violations: async () => [...(await page.evaluate(() => window.__csp)), ...consoleCsp],
  };
}

test('E1 : réponses du serveur : CSP stricte, nosniff, pas d’inclusion dans un cadre, pas de référent', async () => {
  const r = await fetch(`${ttUrl}/`);
  const csp = r.headers.get('content-security-policy');
  for (const d of [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ])
    assert.ok(csp.includes(d), d);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.ok(
    (await fetch(`${ttUrl}/api/challenge`)).headers.get('content-security-policy'),
    'aussi sur l’API',
  );
});

test('E1 : démo : aucune violation en parcourant les fonctions (simulations, langue, panneau labo, IP)', async () => {
  const { page, violations } = await watchedPage();
  await page.goto(`${ttUrl}/?mode=server`);
  await page.waitForFunction(
    () => document.querySelector('#powStatus').textContent.includes('solved'),
    null,
    { timeout: 30000 },
  );
  await page.click('#btnBot');
  await page.click('#btnAgent');
  await page.click('#btnHeadless');
  await page.click('#btnReset');
  await page.click('[data-lang="fr"]');
  await page.click('[data-lang="en"]');
  await page.click('#labToggle');
  await page.fill('#thr', '70');
  await page.click('#labClose');
  await page.click('#btnIp'); // appel à ipify : autorisé par connect-src, qu'il aboutisse ou non
  await page.waitForTimeout(2300);
  await page.click('#btnSubmit');
  await page.waitForSelector('.final');
  assert.deepEqual(await violations(), []);
  // les styles posés par JavaScript (CSSOM) ne sont pas bloqués
  assert.ok(await page.evaluate(() => document.querySelector('#gauge').value >= 0));
  await page.close();
});

test('E1 : page d’administration : aucune violation, les barres (style posé en JavaScript) s’affichent', async () => {
  const { page, violations } = await watchedPage();
  await page.goto(`${ttUrl}/admin.html`);
  await page.fill('#token', 'adm');
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('#results:not([hidden])');
  assert.deepEqual(await violations(), []);
  const w = await page.$$eval('.admin-fill', (n) => n.map((e) => parseFloat(e.style.width)));
  assert.ok(w.length > 0 && w.some((x) => x > 0), 'largeurs appliquées');
  await page.close();
});

test('E1 : site d’exemple (nonce) : aucune violation, widget chargé depuis Turing Trace, honeypot positionné par le widget', async () => {
  const { page, violations } = await watchedPage();
  const r = await page.goto(siteUrl);
  const csp = r.headers()['content-security-policy'];
  assert.match(csp, /script-src 'nonce-[^']+'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  await page.waitForTimeout(2500);
  const hp = await page.evaluate(() => {
    const el = document.querySelector('input[name=nc_website]');
    const s = getComputedStyle(el.parentElement);
    return { position: s.position, left: s.left };
  });
  assert.deepEqual(
    hp,
    { position: 'absolute', left: '-9999px' },
    'le style du honeypot est bien appliqué malgré la CSP',
  );
  await page.fill('input[name=name]', 'bot');
  await page.fill('textarea', 'spam');
  await page.waitForTimeout(2200);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.getElementById('status').textContent.length > 0, null, {
    timeout: 15000,
  });
  assert.deepEqual(await violations(), []);
  await page.close();
});
