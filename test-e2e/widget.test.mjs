// Intégration de bout en bout : un site tiers (autre port) utilise le widget et le middleware.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createApp } from '../server.js';
import { createSite } from '../examples/site/server.js';
import { humanClick, humanType, wander, normalBrowserIdentity } from '../redteam/human.mjs';

const listen = (app) =>
  new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
let nc, site, siteUrl, browser;

before(async () => {
  const origins = []; // le serveur Turing Trace garde la référence : l'origine du site est ajoutée une fois son port connu
  nc = await listen(createApp({ secret: 'w', allowedOrigins: origins }));
  site = await listen(createSite({ turingTraceUrl: `http://localhost:${nc.address().port}` }));
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
  nc?.close();
});

test('widget : un visiteur au profil normal envoie le formulaire, le backend valide le jeton', async () => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = {};
    Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    speechSynthesis.getVoices = () => [{ name: 'Test voice', lang: 'en-US' }];
  });
  const page = await ctx.newPage();
  await (
    await ctx.newCDPSession(page)
  ).send('Emulation.setUserAgentOverride', normalBrowserIdentity());
  await page.goto(siteUrl);
  await page.waitForTimeout(1500);
  await wander(page, 4);
  await humanClick(page, 'input[name=name]');
  await page.waitForTimeout(350);
  await humanType(page, 'alice');
  await humanClick(page, 'textarea');
  await page.waitForTimeout(300);
  await humanType(page, 'bonjour je voudrais un devis');
  await page.waitForTimeout(2500);
  await humanClick(page, 'button[type=submit]');
  await page.waitForURL(/\/contact$/, { timeout: 15000 });
  assert.match(await page.textContent('#ok'), /^\d+\/100$/);
  await ctx.close();
});

test('widget : un headless naïf est refusé, le formulaire n’est pas envoyé', async () => {
  const page = await browser.newPage();
  await page.goto(siteUrl);
  await page.waitForTimeout(1500);
  await page.fill('input[name=name]', 'bot');
  await page.fill('textarea', 'spam spam spam');
  await page.waitForTimeout(2200);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.getElementById('status').textContent.length > 0, null, {
    timeout: 15000,
  });
  assert.ok(new URL(page.url()).pathname === '/', 'toujours sur la page du formulaire');
  await page.close();
});

test('backend : un envoi direct sans widget (bot qui poste le formulaire) est refusé', async () => {
  const r = await fetch(`${siteUrl}/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=bot&message=spam',
  });
  assert.equal(r.status, 403);
});

// ── D4 : panne du serveur Turing Trace après le chargement de la page ───────────────────────────────
async function sitePair(siteOptions, ttOptions = {}) {
  const origins = [];
  const ttServer = await listen(
    createApp({ secret: 'panne', allowedOrigins: origins, ...ttOptions }),
  );
  const ttUrl = `http://localhost:${ttServer.address().port}`;
  const siteServer = await listen(createSite({ turingTraceUrl: ttUrl, ...siteOptions }));
  const url = `http://localhost:${siteServer.address().port}`;
  origins.push(url);
  return {
    url,
    // Coupe le service : plus de nouvelles connexions, et fermeture des connexions persistantes du navigateur.
    killTuringTrace: () => {
      ttServer.close();
      ttServer.closeAllConnections();
    },
    close: () => {
      siteServer.close();
      ttServer.close();
      ttServer.closeAllConnections();
    },
  };
}

async function fillAndKill(url, kill) {
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForTimeout(2500); // le widget a préchargé le défi et la preuve de travail
  await page.fill('input[name=name]', 'visiteur');
  await page.fill('textarea', 'bonjour');
  kill();
  await page.click('button[type=submit]');
  return page;
}

test('D4 : serveur Turing Trace coupé, mode par défaut : le formulaire n’est pas envoyé et le visiteur est prévenu', async () => {
  const pair = await sitePair({});
  try {
    const page = await fillAndKill(pair.url, pair.killTuringTrace);
    await page.waitForFunction(
      () => document.getElementById('status').textContent.length > 0,
      null,
      { timeout: 15000 },
    );
    assert.match(await page.textContent('#status'), /indisponible/);
    assert.equal(new URL(page.url()).pathname, '/', 'toujours sur le formulaire');
    await page.close();
  } finally {
    pair.close();
  }
});

test('D4 : serveur Turing Trace coupé, repli « submit » + failOpen : le message part, marqué non vérifié', async () => {
  const pair = await sitePair({ fallback: 'submit', failOpen: true });
  try {
    const page = await fillAndKill(pair.url, pair.killTuringTrace);
    await page.waitForURL(/\/contact$/, { timeout: 15000 });
    assert.match(await page.textContent('#unverified'), /sans contrôle anti-robot/);
    await page.close();
  } finally {
    pair.close();
  }
});

test('D4 : repli « submit » mais site fail-closed : le backend du site refuse le message sans jeton', async () => {
  const pair = await sitePair({ fallback: 'submit', failOpen: false });
  try {
    const page = await fillAndKill(pair.url, pair.killTuringTrace);
    await page.waitForURL(/\/contact$/, { timeout: 15000 });
    assert.match(await page.textContent('h1'), /Envoi refusé/);
    await page.close();
  } finally {
    pair.close();
  }
});

test('D3 : widget avec un serveur à seuil 80 : le visiteur à 70 passe par la vérification supplémentaire puis envoie le formulaire', async () => {
  const pair = await sitePair({}, { minScore: 80 });
  try {
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
    await page.goto(pair.url);
    await page.waitForTimeout(1500);
    await wander(page, 4);
    await humanClick(page, 'input[name=name]');
    await page.waitForTimeout(350);
    await humanType(page, 'alice');
    await humanClick(page, 'textarea');
    await page.waitForTimeout(300);
    await humanType(page, 'bonjour je voudrais un devis');
    await page.waitForTimeout(2500);
    await humanClick(page, 'button[type=submit]');
    await page.waitForURL(/\/contact$/, { timeout: 40000 });
    assert.match(await page.textContent('#ok'), /^70\/100$/);
    await ctx.close();
  } finally {
    pair.close();
  }
});

test('widget absent (ALLOWED_ORIGINS oublié) : le formulaire n’est pas envoyé et la page explique pourquoi', async () => {
  const pair = await sitePair({}, { allowedOrigins: [] }); // blocage CORS du widget : cas réel d'un « npm start » sans la variable
  try {
    const page = await browser.newPage();
    await page.goto(pair.url);
    await page.waitForTimeout(1200);
    await page.fill('input[name=name]', 'alice');
    await page.fill('textarea', 'bonjour');
    await page.click('button[type=submit]');
    await page.waitForFunction(() => document.getElementById('status').textContent.length > 0);
    assert.match(await page.textContent('#status'), /widget Turing Trace .* ALLOWED_ORIGINS/);
    assert.equal(new URL(page.url()).pathname, '/', 'aucun envoi sans jeton');
    await page.close();
  } finally {
    pair.close();
  }
});

test('SRI : une empreinte d’intégrité qui ne correspond pas au fichier empêche le widget de s’exécuter', async () => {
  // Simule un serveur Turing Trace compromis ou un fichier modifié en route : l'empreinte épinglée par le site ne correspond plus.
  const pair = await sitePair({
    widgetIntegrity: `sha384-${Buffer.alloc(48, 1).toString('base64')}`,
  });
  try {
    const page = await browser.newPage();
    const blocked = [];
    page.on('console', (m) => {
      if (/integrity/i.test(m.text())) blocked.push(m.text());
    });
    await page.goto(pair.url);
    await page.waitForTimeout(1200);
    await page.fill('input[name=name]', 'alice');
    await page.fill('textarea', 'bonjour');
    await page.click('button[type=submit]');
    await page.waitForFunction(() => document.getElementById('status').textContent.length > 0);
    assert.match(await page.textContent('#status'), /widget Turing Trace/);
    assert.equal(
      new URL(page.url()).pathname,
      '/',
      'aucun envoi : le widget modifié ne s’est pas exécuté',
    );
    assert.ok(blocked.length > 0, 'le navigateur signale le blocage pour cause d’intégrité');
    await page.close();
  } finally {
    pair.close();
  }
});
