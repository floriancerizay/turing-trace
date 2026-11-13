// Gestes tactiles : des tapes injectées (Playwright) sont signalées, de vrais gestes irréguliers ne le sont pas.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createApp } from '../server.js';
import { humanTap, humanSwipe } from '../redteam/human.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let server, base, browser;

before(async () => {
  server = await new Promise((r) => {
    const s = createApp({ secret: 'touch' }).listen(0, () => r(s));
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

async function mobilePage() {
  const ctx = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  await page.goto(`${base}/?mode=server`);
  await page.waitForFunction(() => document.querySelector('#gaugeVal').textContent !== '–');
  return { ctx, page, cdp: await ctx.newCDPSession(page) };
}
const hitRules = (page) =>
  page.$$eval('#rules details.hit .name', (n) => n.map((x) => x.textContent.trim()));
const touchRules = (hits) =>
  hits.filter((h) => /swipes|Taps of identical|Instant taps|contact area/.test(h));

test('tactile : des tapes injectées par Playwright (durée nulle, aucune surface de contact) sont signalées', async () => {
  const { ctx, page } = await mobilePage();
  for (const [x, y] of [
    [100, 300],
    [200, 420],
    [60, 500],
    [250, 350],
    [150, 600],
    [90, 250],
  ]) {
    await page.touchscreen.tap(x, y);
    await wait(250 + Math.random() * 300);
  }
  await wait(800);
  const hits = await hitRules(page);
  // Durée quasi nulle : la règle « tapes instantanées » ne dépend pas de la gigue de quelques millisecondes entre les tapes.
  assert.ok(
    hits.some((h) => h.startsWith('Instant taps')),
    hits.join(' | '),
  );
  assert.ok(
    hits.some((h) => h.startsWith('No contact area')),
    hits.join(' | '),
  );
  await ctx.close();
});

test('tactile : de vrais gestes irréguliers (durée, surface, pression variables) ne sont pas signalés', async () => {
  const { ctx, page, cdp } = await mobilePage();
  for (const [x, y] of [
    [100, 300],
    [200, 420],
    [60, 500],
    [250, 350],
    [150, 600],
  ]) {
    await humanTap(cdp, x, y);
    await wait(300 + Math.random() * 400);
  }
  await humanSwipe(cdp, 80, 700, 300, 400);
  await wait(400);
  await humanSwipe(cdp, 300, 300, 100, 560);
  await wait(400);
  await humanSwipe(cdp, 120, 650, 280, 330);
  await wait(800);
  const hits = await hitRules(page);
  assert.deepEqual(touchRules(hits), [], hits.join(' | '));
  assert.ok(
    !hits.some((h) => h.startsWith('No pointer interaction')),
    'de vrais gestes tactiles lèvent la pénalité « aucune interaction »',
  );
  const tile = await page.evaluate(
    () =>
      [...document.querySelectorAll('.tile')].find((t) => /Touch \(swipes/.test(t.textContent))
        ?.textContent,
  );
  assert.match(tile, /3 \/ 5/, 'le tableau de bord compte 3 glissements et 5 tapes');
  await ctx.close();
});
