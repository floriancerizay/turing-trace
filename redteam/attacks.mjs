// Tests d'intrusion contre SON PROPRE déploiement : un attaquant qui connaît tout le protocole (le code client est public)
// tente de se faire passer pour un humain. Cible limitée à localhost.
//   node redteam/attacks.mjs [http://localhost:3000]      (CHROMIUM_PATH=… pour l'attaque navigateur)
//
// Serveur de test à lancer avec :  RATE_LIMIT=1000 SCORE_API=1 npm start
//   RATE_LIMIT=1000 : sinon le limiteur de débit (30 requêtes/min) interrompt le script ;
//   SCORE_API=1     : active l'oracle /api/score (désactivé par défaut) pour tester l'attaque qui l'exploite.
import crypto from 'node:crypto';
import { encodeToken, powInput, leadingZeroBits } from '../docs/js/verify.js';
import { evaluate } from '../docs/js/scoring.js';
import { makeTrace, perturbTrace } from './trace.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error('Refusé : ces attaques ne ciblent que localhost (votre propre instance de test).');
  process.exit(2);
}
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => new Uint8Array(crypto.createHash('sha256').update(s).digest());

async function api(path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({ status: r.status }));
  if (r.status === 429) {
    rateLimited++;
    j.rateLimited = true;
  }
  return j;
}
let rateLimited = 0;

function solve(nonce, bits) {
  for (let c = 0; ; c++) if (leadingZeroBits(sha(powInput(nonce, c))) >= bits) return c;
}

// Profil « Chrome sous Windows » plausible et cohérent avec l'en-tête User-Agent envoyé.
const humanSignals = (over = {}) => ({
  ua: UA,
  webdriver: false,
  headlessUA: false,
  automationGlobals: [],
  mathNative: true,
  softwareGpu: false,
  noWebgl: false,
  gpuRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)',
  canvasBlank: false,
  cores: 12,
  memory: 8,
  refreshHz: 60,
  inconsistencies: [],
  languagesEmpty: false,
  canvasHash: crypto.randomBytes(8).toString('hex'),
  audioHash: crypto.randomBytes(8).toString('hex'),
  fonts: 14,
  touch: false,
  untrustedEvents: 0,
  timing: { focusToFirstKey: 412, blurs: 1, scrolls: 6, pageMs: 18000 },
  ...over,
});

// Résumés de comportement qu'un attaquant déclare quand il n'a pas (ou ne veut pas fournir) de données brutes.
const inventedBehavior = {
  mouse: { n: 140, length: 1450, linearity: 0.41, jitter: 0.83, speedCV: 0.74, intervalCV: 0.38 },
  keys: {
    count: 24,
    pasted: false,
    dwellMean: 98,
    dwellCV: 0.31,
    flightMean: 143,
    flightCV: 0.52,
    downMean: 141,
  },
};
let traceSeed = 1000;

/**
 * Construit un jeton complet : défi réel + preuve de travail + signaux au choix.
 * `trace` : trajectoire brute à joindre (par défaut une nouvelle, différente à chaque jeton) ; `null` : aucune donnée brute.
 */
async function forge(signals, { score, patch, pow = true, trace } = {}) {
  const t = trace === undefined ? makeTrace(traceSeed++) : trace;
  if (t) signals = { ...signals, mouse: t.mouse, keys: t.keys };
  const ch = await api('/api/challenge');
  if (!ch.nonce)
    throw new Error(
      'défi refusé (limiteur de débit ?) : relancez avec RATE_LIMIT=1000 sur le serveur de test',
    );
  const counter = pow ? solve(ch.nonce, ch.bits) : -1;
  const claimed = score ?? evaluate({ ...signals, powSolved: true }).score;
  const payload = {
    ...ch,
    score: claimed,
    signals,
    pow: pow ? { counter } : null,
    raw: t ? t.raw : undefined,
    ...patch,
  };
  return encodeToken(payload);
}

const results = [];
const record = (name, res, expect) => {
  const failed = res.steps.find((s) => s.ok === false);
  results.push({
    name,
    ok: res.ok,
    score: res.score ?? '–',
    stoppedAt: failed ? failed.id : '—',
    expect,
  });
};

async function attempt(name, signals, opts = {}, { wait: w = 2200, website = '', expect } = {}) {
  const token = await forge(signals, opts);
  await wait(w);
  const res = await api('/api/verify', { name: 'x', website, cf_token: token });
  record(name, res, expect);
  return res;
}

// ── Niveau 0 : bots naïfs ──────────────────────────────────────────────────
await attempt(
  '0a  headless naïf (signaux honnêtes)',
  humanSignals({ webdriver: true, headlessUA: true, softwareGpu: true }),
  {},
  { expect: 'refusé' },
);
await attempt(
  '0b  bot aveugle remplissant le honeypot',
  humanSignals(),
  {},
  { website: 'http://spam.example', expect: 'refusé' },
);
await (async () => {
  const token = await forge(humanSignals());
  await wait(2200);
  const form = { name: 'x', website: '', cf_token: token };
  await api('/api/verify', form);
  record("0c  rejeu d'un jeton déjà accepté", await api('/api/verify', form), 'refusé');
})();
await attempt(
  '0d  jeton sans preuve de travail',
  humanSignals(),
  { pow: false },
  { expect: 'refusé' },
);
await attempt(
  '0e  soumission instantanée (< 2 s)',
  humanSignals(),
  {},
  { wait: 0, expect: 'refusé' },
);

// ── Niveau 1 : mensonge naïf sur le score ──────────────────────────────────
await attempt(
  '1   signaux de bot, score client forgé à 100',
  humanSignals({ webdriver: true, softwareGpu: true }),
  { score: 100 },
  { expect: 'refusé' },
);
await attempt(
  '1b  signature du défi trafiquée',
  humanSignals(),
  { patch: { csig: 'AAAA' } },
  { expect: 'refusé' },
);
await attempt(
  '1c  UA déclaré ≠ en-tête HTTP',
  humanSignals({ ua: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0' }),
  {},
  { expect: 'refusé' },
);

// ── Niveau 2 : l'attaquant lit le code client et fabrique ses propres signaux ──
// Aucun navigateur : juste des requêtes HTTP. Depuis que le serveur recalcule le comportement à partir de données brutes,
// il ne suffit plus d'inventer des résumés : il faut fabriquer une trajectoire et un rythme de frappe plausibles.
await attempt(
  '2a  résumés de comportement inventés, sans données brutes',
  humanSignals({ ...inventedBehavior }),
  { trace: null },
  { expect: 'refusé (behavior : données brutes manquantes)' },
);
await attempt(
  '2b  trajectoire et frappe générées par un script (Bézier, bruit, rythme irrégulier)',
  humanSignals(),
  {},
  { expect: 'ACCEPTÉ ← limite connue' },
);
{
  // Rejeu d'un enregistrement : la même trajectoire exacte sous deux identités (deux fingerprints différents).
  const recorded = makeTrace(31337);
  const t1 = await forge(humanSignals(), { trace: recorded });
  const t2 = await forge(humanSignals(), { trace: recorded });
  const noisy = await forge(humanSignals(), { trace: perturbTrace(recorded, 7) });
  await wait(2200);
  await api('/api/verify', { name: 'x', website: '', cf_token: t1 });
  record(
    '2c  même trajectoire enregistrée rejouée sous une autre identité',
    await api('/api/verify', { name: 'x', website: '', cf_token: t2 }),
    'refusé (behavior : rejeu)',
  );
  // Variante : la même trajectoire avec un bruit de ±1 px, pour échapper à la comparaison exacte.
  record(
    '2d  même trajectoire rejouée avec un bruit de ±1 px',
    await api('/api/verify', { name: 'x', website: '', cf_token: noisy }),
    'ACCEPTÉ ← limite connue (seul le rejeu exact est détecté)',
  );
}

// ── Niveau 3 : oracle de score pour calibrer l'attaque ─────────────────────
{
  const sig = humanSignals({
    webdriver: true,
    headlessUA: true,
    softwareGpu: true,
    mouse: { n: 0, length: 0 },
    keys: { count: 0 },
  });
  const t0 = await forge(sig);
  const probe = await api('/api/score', { cf_token: t0 });
  if (probe.status === 404) {
    results.push({
      name: "3   oracle /api/score (calibrage de l'attaque par le score détaillé)",
      ok: false,
      score: '–',
      stoppedAt: 'désactivé',
      expect: 'bloqué (SCORE_API absent)',
    });
  } else {
    results.push({
      name: '3a  oracle /api/score : ce qui trahit le profil nu',
      ok: false,
      score: probe.score,
      stoppedAt: probe.rules?.map((r) => r.id).join(','),
      expect: "fuite d'information",
    });
    // L'attaquant retire une règle à la fois jusqu'à passer le seuil.
    const removable = { webdriver: false, headlessUA: false, softwareGpu: false };
    let cur = { ...sig },
      tries = 1;
    for (const k of Object.keys(removable)) {
      cur = { ...cur, [k]: false };
      tries++;
      const r = await api('/api/score', { cf_token: await forge(cur) });
      if (r.score >= r.minScore) break;
    }
    const reached = (await api('/api/score', { cf_token: await forge(cur) })).score >= 60;
    results.push({
      name: "3b  recalibrage guidé par l'oracle",
      ok: reached,
      score: reached ? `seuil atteint en ${tries} requêtes` : 'non atteint',
      stoppedAt: '—',
      expect: "ACCEPTÉ si l'oracle est exposé",
    });
  }
}

// ── Niveau 5 : vrai navigateur (Playwright) ────────────────────────────────
const CHROME = process.env.CHROMIUM_PATH;
let pw = null;
try {
  pw = (await import('playwright-core')).chromium;
} catch {
  /* non installé */
}
const { humanClick, humanType, wander, normalBrowserIdentity } = await import('./human.mjs');

/** `stealth` : 'light' (webdriver, window.chrome), 'deep' (+ Client Hints réécrits en JS, permissions, voix, codecs)
 *  ou 'engine' (comme deep, mais identité réécrite dans le moteur via DevTools : en-têtes HTTP cohérents). */
async function browserRun(name, { stealth, agent = false, expect }) {
  if (!pw) {
    results.push({
      name,
      ok: null,
      score: '–',
      stoppedAt: '—',
      expect: 'ignoré (playwright-core absent)',
    });
    return;
  }
  const browser = await pw.launch({
    headless: true,
    executablePath: CHROME || undefined,
    args: ['--no-sandbox'],
  });
  try {
    const ctx = await browser.newContext({
      userAgent: UA,
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
    });
    await ctx.addInitScript((mode) => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 12 });
      if (mode === 'light') return;
      Object.defineProperty(Notification, 'permission', { get: () => 'default' });
      speechSynthesis.getVoices = () => [{ name: 'Microsoft David', lang: 'en-US' }];
      const uad = navigator.userAgentData;
      if (uad && mode === 'deep') {
        const brands = [
          { brand: 'Google Chrome', version: '130' },
          { brand: 'Chromium', version: '130' },
        ];
        Object.defineProperty(navigator, 'userAgentData', {
          get: () => ({
            brands,
            mobile: false,
            platform: 'Windows',
            getHighEntropyValues: async () => ({
              platform: 'Windows',
              platformVersion: '15.0.0',
              architecture: 'x86',
              bitness: '64',
              model: '',
              fullVersionList: brands,
            }),
          }),
        });
      }
      const cpt = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function (t) {
        return /avc1|mp4a/.test(t) ? 'probably' : cpt.call(this, t);
      };
    }, stealth);
    const page = await ctx.newPage();
    if (stealth === 'engine') {
      await (
        await ctx.newCDPSession(page)
      ).send(
        'Emulation.setUserAgentOverride',
        normalBrowserIdentity({
          platform: 'Windows',
          uaPlatform: 'Windows NT 10.0; Win64; x64',
          navPlatform: 'Win32',
          platformVersion: '15.0.0',
        }),
      );
    }
    await page.goto(`${BASE}/?mode=server`);
    await page.waitForFunction(
      () => document.querySelector('#powStatus').textContent.includes('solved'),
      null,
      { timeout: 60000 },
    );
    if (agent) {
      // Agent IA typique : clic direct sur la cible (centre), remplissage du champ d'un bloc, pauses de « réflexion ».
      await wait(1800);
      await page.click('#typing');
      await wait(2200);
      await page.fill('#typing', 'Hello, I would like more information about your product.');
      await wait(1900);
      await page.click('#name');
      await page.fill('#name', 'John Smith');
      await wait(2500);
    } else {
      await wander(page, 5);
      await humanClick(page, '#typing');
      await wait(380);
      await humanType(page, 'hello this is definitely a real person typing');
      await humanClick(page, '#name');
      await wait(300);
      await humanType(page, 'john');
      await wait(1500);
    }
    const hits = await page.$$eval('#rules details.hit .name', (n) =>
      n.map((e) => e.textContent.trim().split(/\s{2,}| = |\d+ /)[0]).join(' | '),
    );
    const score = Number(await page.textContent('#gaugeVal'));
    if (agent) await page.click('#btnSubmit');
    else await humanClick(page, '#btnSubmit');
    await page.waitForSelector('.final');
    const ok = /accepted/.test(await page.textContent('.final'));
    const stop = await page.$$eval('#result li.ko strong', (n) =>
      n.map((e) => e.textContent).join(', '),
    );
    results.push({ name, ok, score, stoppedAt: ok ? '—' : stop, expect, hits });
  } finally {
    await browser.close();
  }
}

await browserRun('5a  navigateur furtif léger + gestes humains', {
  stealth: 'light',
  expect: "refusé depuis l'ajout des Client Hints, permissions et voix",
});
await browserRun('5b  furtif poussé, Client Hints réécrits en JavaScript + gestes humains', {
  stealth: 'deep',
  expect: 'refusé (en-têtes HTTP ≠ JavaScript)',
});
await browserRun(
  '5c  furtif poussé, identité réécrite dans le moteur (DevTools) + gestes humains',
  { stealth: 'engine', expect: 'ACCEPTÉ ← limite connue' },
);
await browserRun('6   agent IA (clic au centre, fill, pauses) sur navigateur furtif moteur', {
  stealth: 'engine',
  agent: true,
  expect: 'refusé (signaux agent)',
});

// ── Niveau 9 : relais de jeton (ferme à CAPTCHA) ─────────────────────────────
{
  // Un humain payé résout le défi sur sa machine (autre IP / langue), le bot réutilise le jeton.
  const ch = await (
    await fetch(`${BASE}/api/challenge`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
    })
  ).json();
  const signals = humanSignals();
  const token = encodeToken({
    ...ch,
    score: evaluate({ ...signals, powSolved: true }).score,
    signals,
    pow: { counter: solve(ch.nonce, ch.bits) },
  });
  await wait(2200);
  record(
    '9   jeton résolu par un humain ailleurs puis relayé au bot',
    await api('/api/verify', { name: 'x', website: '', cf_token: token }),
    'refusé (jeton lié au client)',
  );
}

// ── Niveau 4 : passage à l'échelle avec la MÊME empreinte ──────────────────
{
  const fixed = humanSignals();
  // Forger tous les jetons d'abord, attendre l'âge minimal, puis soumettre : seule l'empreinte identique peut les trahir.
  const tokens = [];
  for (let i = 0; i < 8; i++) tokens.push(await forge({ ...fixed }));
  await wait(2300);
  const outcome = [];
  for (const token of tokens)
    outcome.push(await api('/api/verify', { name: 'x', website: '', cf_token: token }));
  const accepted = outcome.filter((r) => r.ok).length;
  const why = outcome.find((r) => !r.ok)?.steps.find((s) => s.ok === false);
  results.push({
    name: '4   8 jetons avec la MÊME empreinte (canvas/audio identiques)',
    ok: accepted === 8,
    score: `${accepted}/8 acceptés`,
    stoppedAt: why ? `${why.id}:${why.d}` : '—',
    expect: 'bloqué après 5 (FP_MAX)',
  });
}

// ── Niveau 7 : masse depuis une seule IP, empreintes toutes différentes ─────
{
  const tokens = [];
  for (let i = 0; i < 12; i++) tokens.push(await forge(humanSignals()));
  await wait(2300);
  const outcome = [];
  for (const token of tokens)
    outcome.push(await api('/api/verify', { name: 'x', website: '', cf_token: token }));
  const accepted = outcome.filter((r) => r.ok).length;
  const why = outcome.find((r) => !r.ok)?.steps.find((s) => s.ok === false);
  results.push({
    name: '7   12 jetons, empreintes toutes différentes, même IP',
    ok: accepted === 12,
    score: `${accepted}/12 acceptés`,
    stoppedAt: why ? `${why.id}:${why.d}` : '—',
    expect: 'plafonné par PASS_PER_IP (10 / 10 min)',
  });
}

// ── Coût de la preuve de travail adaptative ────────────────────────────────
{
  const ch = await api('/api/challenge');
  const t0 = performance.now();
  solve(ch.nonce, ch.bits);
  results.push({
    name: '8   difficulté du défi après ce martèlement',
    ok: null,
    score: `${ch.bits} bits, ${Math.round(performance.now() - t0)} ms`,
    stoppedAt: '—',
    expect: '14 bits au départ',
  });
}

// ── Rapport ────────────────────────────────────────────────────────────────
console.log('\nRésultats (cible :', BASE + ')\n');
for (const r of results) {
  const verdict = r.ok === null ? 'INFO    ' : r.ok ? 'PASSÉ   ' : 'BLOQUÉ  ';
  console.log(
    `${verdict} ${r.name}\n          score=${r.score}  arrêt=${r.stoppedAt}${r.hits ? `  règles=${r.hits}` : ''}  (attendu : ${r.expect})`,
  );
}
const passed = results.filter((r) => r.ok === true).map((r) => r.name.trim().split(/\s+/)[0]);
console.log(`\nRequêtes bloquées par le limiteur de débit : ${rateLimited}`);
console.log(`Attaques qui passent : ${passed.join(', ') || 'aucune'}`);
