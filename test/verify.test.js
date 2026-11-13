import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createTokenService } from '../lib/token.js';
import { encodeToken, decodeToken, powInput, leadingZeroBits, LIMITS } from '../docs/js/verify.js';
import { evaluate } from '../docs/js/scoring.js';
import { makeTrace } from '../redteam/trace.mjs';

const UA = 'node-test-agent';
const clean = {
  ua: UA,
  webdriver: false,
  headlessUA: false,
  automationGlobals: [],
  mathNative: true,
  softwareGpu: false,
  noWebgl: false,
  canvasBlank: false,
  cores: 8,
  refreshHz: 60,
  inconsistencies: [],
  languagesEmpty: false,
  touch: false,
  untrustedEvents: 0,
  // mouse et keys : fournis par makeForm à partir d'une trajectoire brute différente à chaque jeton
};

// Résumés inventés : ce qu'un attaquant déclarerait sans données brutes pour les justifier.
const invented = {
  mouse: { n: 120, length: 900, linearity: 0.62, jitter: 0.9, speedCV: 0.7, intervalCV: 0.4 },
  keys: {
    count: 20,
    pasted: false,
    dwellMean: 95,
    dwellCV: 0.3,
    flightMean: 140,
    flightCV: 0.5,
    downMean: 235,
  },
};

async function solve(svc, nonce, bits) {
  for (let c = 0; ; c++)
    if (leadingZeroBits(await svc.sha256(powInput(nonce, c))) >= bits) return c;
}

async function start(opts = {}) {
  const app = createApp({ secret: 's3cret', minScore: 60, ...opts });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const svc = createTokenService('s3cret');
  const post = (body, headers = {}) =>
    fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...headers },
      body: JSON.stringify(body),
    });
  const challenge = async (headers = {}) =>
    (await fetch(`${base}/api/challenge`, { headers: { 'User-Agent': UA, ...headers } })).json();
  let seed = 100;
  const makeForm = async (signals = clean, over = {}, headers = {}) => {
    const ch = await challenge(headers);
    const counter = await solve(svc, ch.nonce, ch.bits);
    const trace = makeTrace(seed++); // trajectoire différente à chaque jeton (sinon : rejeu)
    const sig = {
      ...signals,
      mouse: signals.mouse ?? trace.mouse,
      keys: signals.keys ?? trace.keys,
    };
    const score = evaluate({ ...sig, powSolved: true }).score;
    const payload = { ...ch, score, signals: sig, pow: { counter }, raw: trace.raw, ...over };
    return { form: { name: 'x', website: '', cf_token: encodeToken(payload) }, ch, payload };
  };
  return { base, server, post, makeForm, app };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('API : jeton valide accepté, rejeu refusé', async () => {
  const { base, server, post, makeForm } = await start();
  try {
    const { form } = await makeForm();
    await wait(LIMITS.minAgeMs + 100);
    const ok = await post(form);
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.score, 100);
    // jeton de passage : valide une fois, puis refusé
    const sv = (pass) =>
      fetch(`${base}/api/siteverify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass }),
      });
    assert.deepEqual(await (await sv(okBody.pass)).json(), { success: true, score: 100 });
    assert.equal((await (await sv(okBody.pass)).json()).error, 'already-used');
    assert.equal((await (await sv(okBody.pass.slice(0, -2) + 'xx')).json()).error, 'bad-signature');
    assert.equal((await (await sv('garbage')).json()).error, 'malformed');
    const replay = await post(form);
    assert.equal(replay.status, 403);
    const body = await replay.json();
    assert.equal(body.steps.find((s) => s.ok === false).id, 'replay');
  } finally {
    server.close();
  }
});

test('API : honeypot rempli, jeton trop rapide, jeton falsifié, score forgé', async () => {
  const { server, post, makeForm } = await start();
  try {
    const a = await makeForm();
    assert.equal((await post({ ...a.form, website: 'spam' })).status, 403);

    const fast = await makeForm();
    const r = await (await post(fast.form)).json();
    assert.equal(r.steps.find((s) => s.ok === false).id, 'freshness');

    const b = await makeForm();
    const tampered = { ...b.payload, csig: 'AAAA' };
    assert.equal((await post({ ...b.form, cf_token: encodeToken(tampered) })).status, 403);

    const bot = { ...clean, webdriver: true, softwareGpu: true };
    const c = await makeForm(bot, { score: 100 }); // score client menti
    await wait(LIMITS.minAgeMs + 100);
    const res = await (await post(c.form)).json();
    assert.equal(res.ok, false);
    assert.equal(res.steps.find((s) => s.ok === false).id, 'score');
  } finally {
    server.close();
  }
});

test('API : score honnête mais trop bas refusé ; preuve de travail manquante refusée', async () => {
  const { server, post, makeForm } = await start();
  try {
    const bot = { ...clean, webdriver: true, softwareGpu: true };
    const a = await makeForm(bot);
    await wait(LIMITS.minAgeMs + 100);
    const res = await (await post(a.form)).json();
    assert.equal(res.ok, false);
    assert.equal(res.steps.find((s) => s.ok === false).id, 'threshold');

    const b = await makeForm(clean, { pow: { counter: 0 } });
    await wait(LIMITS.minAgeMs + 100);
    const r2 = await (await post(b.form)).json();
    assert.equal(r2.steps.find((s) => s.ok === false).id, 'pow');
  } finally {
    server.close();
  }
});

test('token : encodage aller-retour et signature', () => {
  const p = { a: 1, é: 'ü' };
  assert.deepEqual(decodeToken(encodeToken(p)), p);
  assert.equal(decodeToken('%%%'), null);
  const svc = createTokenService('k');
  const ch = svc.issueChallenge();
  assert.ok(svc.checkSig(ch.nonce, ch.ts, ch.bits, ch.csig));
  assert.ok(!svc.checkSig(ch.nonce, ch.ts + 1, ch.bits, ch.csig));
  assert.ok(svc.consumeNonce(ch.nonce));
  assert.ok(!svc.consumeNonce(ch.nonce));
});

test('API : la même empreinte acceptée plus de 5 fois est refusée (réputation)', async () => {
  const { server, post, makeForm } = await start();
  try {
    const forms = [];
    for (let i = 0; i < 6; i++) forms.push((await makeForm()).form);
    await wait(LIMITS.minAgeMs + 100);
    const res = [];
    for (const f of forms) res.push(await (await post(f)).json());
    assert.deepEqual(
      res.map((r) => r.ok),
      [true, true, true, true, true, false],
    );
    const step = res[5].steps.find((s) => s.ok === false);
    assert.equal(step.id, 'reputation');
    assert.equal(step.d, 'fpBurst');
  } finally {
    server.close();
  }
});

test('API : jeton résolu par un autre client puis relayé : refusé à la signature', async () => {
  const { server, post, makeForm } = await start();
  try {
    // Défi obtenu par un « humain » avec une autre configuration (Accept-Language différent), jeton utilisé par le bot.
    const { form } = await makeForm(clean, {}, { 'Accept-Language': 'pt-BR' });
    await wait(LIMITS.minAgeMs + 100);
    const r = await (await post(form)).json();
    assert.equal(r.steps.find((s) => s.ok === false).id, 'signature');
  } finally {
    server.close();
  }
});

test('API : en-têtes Client Hints contradictoires : refusé', async () => {
  const { base, server, makeForm } = await start();
  try {
    const signals = {
      ...clean,
      uachPlatform: 'Windows',
      uachBrands: 'Google Chrome 130.0.0.0,Chromium 130.0.0.0',
      lang: 'en-US',
    };
    const { form } = await makeForm(signals);
    await wait(LIMITS.minAgeMs + 100);
    const r = await (
      await fetch(`${base}/api/verify`, {
        method: 'POST',
        body: JSON.stringify(form),
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': UA,
          'Sec-CH-UA': '"Chromium";v="130", "HeadlessChrome";v="130"',
          'Sec-CH-UA-Platform': '"Linux"',
        },
      })
    ).json();
    const step = r.steps.find((s) => s.ok === false);
    assert.equal(step.id, 'headers');
    assert.deepEqual(
      step.p.codes.map((c) => c.split('|')[0]),
      ['headless_brand', 'platform', 'brand_mismatch'],
    );
  } finally {
    server.close();
  }
});

test('A1 : /api/score est désactivé par défaut, actif sur demande', async () => {
  const off = await start();
  const on = await start({ scoreApi: true });
  try {
    assert.equal(
      (
        await fetch(`${off.base}/api/score`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${on.base}/api/score`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      200,
    );
  } finally {
    off.server.close();
    on.server.close();
  }
});

test('A2 : avec trust proxy, le jeton est lié à l’IP transmise par le proxy', async () => {
  const { server, post, makeForm } = await start({ trustProxy: 1 });
  try {
    const a = await makeForm(clean, {}, { 'X-Forwarded-For': '203.0.113.5' });
    const b = await makeForm(clean, {}, { 'X-Forwarded-For': '203.0.113.5' });
    await wait(LIMITS.minAgeMs + 100);
    // même IP côté proxy : accepté ; IP différente : la signature du défi ne correspond plus
    assert.equal((await post(a.form, { 'X-Forwarded-For': '203.0.113.5' })).status, 200);
    const r = await (await post(b.form, { 'X-Forwarded-For': '198.51.100.9' })).json();
    assert.equal(r.steps.find((s) => s.ok === false).id, 'signature');
  } finally {
    server.close();
  }
});

test('A2 : sans trust proxy, X-Forwarded-For est ignoré (non falsifiable)', async () => {
  const { server, post, makeForm } = await start();
  try {
    const a = await makeForm(clean, {}, { 'X-Forwarded-For': '203.0.113.5' });
    await wait(LIMITS.minAgeMs + 100);
    assert.equal((await post(a.form, { 'X-Forwarded-For': '198.51.100.9' })).status, 200);
  } finally {
    server.close();
  }
});

test('A2 : parseTrustProxy', async () => {
  const { parseTrustProxy } = await import('../server.js');
  assert.deepEqual([undefined, '', 'false', 'true', '1', '2', 'loopback', 3].map(parseTrustProxy), [
    false,
    false,
    false,
    true,
    1,
    2,
    'loopback',
    3,
  ]);
});

test('A3 : le limiteur compte par préfixe IPv6 /64, pas par adresse', async () => {
  const { base, server } = await start({ trustProxy: 1, rateLimit: 3 });
  try {
    const get = (ip) => fetch(`${base}/api/challenge`, { headers: { 'X-Forwarded-For': ip } });
    const codes = [];
    for (const ip of [
      '2001:db8:1:2::1',
      '2001:db8:1:2::2',
      '2001:db8:1:2:aaaa::3',
      '2001:db8:1:2:bbbb::4',
    ])
      codes.push((await get(ip)).status);
    assert.deepEqual(
      codes,
      [200, 200, 200, 429],
      'quatre adresses du même /64 partagent le même quota',
    );
    assert.equal((await get('2001:db8:1:3::1')).status, 200, 'un autre /64 a son propre quota');
  } finally {
    server.close();
  }
});

// ── Phase B : le comportement est prouvé par des données brutes, pas seulement déclaré ──────────────

test('B : un résumé de comportement inventé, avec des données brutes différentes, est refusé', async () => {
  const { server, post, makeForm } = await start();
  try {
    const { form } = await makeForm({ ...clean, mouse: invented.mouse });
    await wait(LIMITS.minAgeMs + 100);
    const step = (await (await post(form)).json()).steps.find((s) => s.ok === false);
    assert.equal(step.id, 'behavior');
    assert.equal(step.d, 'mismatch');
    assert.equal(step.p.field, 'mouse');

    const keysLie = await makeForm({ ...clean, keys: invented.keys });
    await wait(LIMITS.minAgeMs + 100);
    const k = (await (await post(keysLie.form)).json()).steps.find((s) => s.ok === false);
    assert.equal(k.d, 'mismatch');
    assert.equal(k.p.field, 'keys');
  } finally {
    server.close();
  }
});

test('B : résumé déclaré sans données brutes : refusé (« missing »)', async () => {
  const { server, post, makeForm } = await start();
  try {
    const { form } = await makeForm({ ...clean, ...invented }, { raw: undefined });
    await wait(LIMITS.minAgeMs + 100);
    const step = (await (await post(form)).json()).steps.find((s) => s.ok === false);
    assert.equal(step.id, 'behavior');
    assert.equal(step.d, 'missing');
  } finally {
    server.close();
  }
});

test('B : données brutes malformées : refusées (« invalid »)', async () => {
  const { server, post, makeForm } = await start();
  try {
    for (const raw of [
      { m: [[1, 2, 'x']], k: [] },
      { m: [[1, 2, -5]], k: [] },
      { m: 'oops', k: [] },
      { m: Array(301).fill([1, 1, 5]), k: [] },
    ]) {
      const { form } = await makeForm(clean, { raw });
      await wait(LIMITS.minAgeMs + 100);
      const step = (await (await post(form)).json()).steps.find((s) => s.ok === false);
      assert.equal(step.d, 'invalid', JSON.stringify(raw).slice(0, 40));
    }
  } finally {
    server.close();
  }
});

test('B : aucune interaction déclarée ni brute : accepté, avec la pénalité « aucune interaction »', async () => {
  const { server, post, makeForm } = await start();
  try {
    const none = {
      mouse: { n: 0, length: 0, linearity: 0, jitter: 0, speedCV: 0, intervalCV: 0 },
      keys: {
        count: 0,
        pasted: false,
        dwellMean: 0,
        dwellCV: 0,
        flightMean: 0,
        flightCV: 0,
        downMean: 0,
      },
    };
    const { form } = await makeForm({ ...clean, ...none }, { raw: undefined });
    await wait(LIMITS.minAgeMs + 100);
    const body = await (await post(form)).json();
    assert.equal(body.ok, true);
    assert.equal(body.score, 90);
  } finally {
    server.close();
  }
});

test('B : une trajectoire identique rejouée sous une autre identité est refusée (« replay »)', async () => {
  const { server, post, makeForm } = await start();
  try {
    const shared = makeTrace(999);
    const a = await makeForm(
      { ...clean, mouse: shared.mouse, keys: shared.keys },
      { raw: shared.raw },
    );
    const b = await makeForm(
      { ...clean, mouse: shared.mouse, keys: shared.keys },
      { raw: shared.raw },
    );
    await wait(LIMITS.minAgeMs + 100);
    assert.equal((await post(a.form)).status, 200);
    const step = (await (await post(b.form)).json()).steps.find((s) => s.ok === false);
    assert.equal(step.id, 'behavior');
    assert.equal(step.d, 'replay');
  } finally {
    server.close();
  }
});

test('B : le score est calculé sur le comportement recalculé, pas sur le résumé déclaré', async () => {
  const { server, post, makeForm } = await start();
  try {
    // Trajectoire de bot réelle (ligne droite, vitesse constante) mais résumé « humain » déclaré, score client 100.
    const { simulateBotMouse } = await import('../docs/js/behavior.js');
    const { behaviorOf, summarizeMouse, summarizeKeys } = await import('../docs/js/signals.js');
    const bot = behaviorOf({}, { mouse: simulateBotMouse(), keys: [] });
    const { form } = await makeForm(
      { ...clean, mouse: invented.mouse },
      { raw: bot.raw, score: 100 },
    );
    await wait(LIMITS.minAgeMs + 100);
    const step = (await (await post(form)).json()).steps.find((s) => s.ok === false);
    assert.equal(
      step.d,
      'mismatch',
      'le mensonge sur le résumé est démasqué par les données brutes',
    );
    // Résumé honnête de cette trajectoire de bot : accepté par l'étape behavior, puis pénalisé par les règles de la souris.
    const honest = await makeForm(
      { ...clean, mouse: summarizeMouse(bot.mouse), keys: summarizeKeys(bot.keys) },
      { raw: bot.raw },
    );
    await wait(LIMITS.minAgeMs + 100);
    const res = await (await post(honest.form)).json();
    assert.equal(res.steps.find((s) => s.id === 'behavior').ok, true);
    assert.ok(res.score <= 65, `trajectoire de bot pénalisée (score ${res.score})`);
  } finally {
    server.close();
  }
});

test('B : un jeton avec la fenêtre complète de données brutes reste sous 15 ko', async () => {
  const { server, makeForm } = await start();
  try {
    const big = makeTrace(5, { points: 300, keys: 100 });
    const { form } = await makeForm(
      { ...clean, mouse: big.mouse, keys: big.keys },
      { raw: big.raw },
    );
    assert.ok(form.cf_token.length < 15000, `jeton de ${form.cf_token.length} caractères`);
  } finally {
    server.close();
  }
});

test('C : le serveur recalcule le résumé tactile ; un résumé tactile inventé est refusé', async () => {
  const { server, post, makeForm } = await start();
  try {
    const { makeTouchTrace } = await import('../redteam/trace.mjs');
    const tr = makeTouchTrace(21);
    const honest = await makeForm(
      { ...clean, mouse: tr.mouse, keys: tr.keys, touchInfo: tr.touchInfo },
      { raw: tr.raw },
    );
    const lie = await makeForm(
      {
        ...clean,
        mouse: tr.mouse,
        keys: tr.keys,
        touchInfo: { ...tr.touchInfo, taps: 9, tapCV: 0.4 },
      },
      { raw: tr.raw },
    );
    await wait(LIMITS.minAgeMs + 100);
    const ok = await (await post(honest.form)).json();
    assert.equal(ok.ok, true);
    assert.equal(ok.score, 100);
    const step = (await (await post(lie.form)).json()).steps.find((s) => s.ok === false);
    assert.equal(step.d, 'mismatch');
    assert.equal(step.p.field, 'touch');
  } finally {
    server.close();
  }
});

test('C : gestes tactiles déclarés sans données brutes : refusé (« missing »)', async () => {
  const { server, post, makeForm } = await start();
  try {
    const { makeTouchTrace } = await import('../redteam/trace.mjs');
    const tr = makeTouchTrace(22);
    const none = { n: 0, length: 0, linearity: 0, jitter: 0, speedCV: 0, intervalCV: 0 };
    const { form } = await makeForm(
      {
        ...clean,
        mouse: none,
        keys: {
          count: 0,
          pasted: false,
          dwellMean: 0,
          dwellCV: 0,
          flightMean: 0,
          flightCV: 0,
          downMean: 0,
        },
        touchInfo: tr.touchInfo,
      },
      { raw: undefined },
    );
    await wait(LIMITS.minAgeMs + 100);
    assert.equal((await (await post(form)).json()).steps.find((s) => s.ok === false).d, 'missing');
  } finally {
    server.close();
  }
});

test('C : un bot tactile (glissements droits, tapes identiques) est pénalisé même avec un résumé honnête', async () => {
  const { server, post, makeForm } = await start();
  try {
    const { simulateBotTouch } = await import('../docs/js/behavior.js');
    const { behaviorOf, summarizeMouse, summarizeKeys, summarizeTouch } =
      await import('../docs/js/signals.js');
    const b = behaviorOf({}, { mouse: [], keys: [], gestures: simulateBotTouch() });
    const { form } = await makeForm(
      {
        ...clean,
        mouse: summarizeMouse(b.mouse),
        keys: summarizeKeys(b.keys),
        touchInfo: summarizeTouch(b.touch),
      },
      { raw: b.raw },
    );
    await wait(LIMITS.minAgeMs + 100);
    const res = await (await post(form)).json();
    assert.equal(res.steps.find((s) => s.id === 'behavior').ok, true);
    assert.equal(
      res.score,
      60,
      'touch_linear 20 + touch_uniform_taps 15 + touch_no_contact_area 5',
    );
  } finally {
    server.close();
  }
});

test('C : un jeton avec la fenêtre complète de gestes et de souris reste sous 16 ko', async () => {
  const { server, makeForm } = await start();
  try {
    const { makeGestures } = await import('../redteam/trace.mjs');
    const { behaviorOf, summarizeMouse, summarizeKeys, summarizeTouch } =
      await import('../docs/js/signals.js');
    const big = makeTrace(6, { points: 300, keys: 100 });
    const b = behaviorOf(
      {},
      {
        mouse: big.samples,
        keys: big.keyEvents,
        gestures: makeGestures(6, { swipes: 6, taps: 10 }),
      },
    );
    const { form } = await makeForm(
      {
        ...clean,
        mouse: summarizeMouse(b.mouse),
        keys: summarizeKeys(b.keys),
        touchInfo: summarizeTouch(b.touch),
      },
      { raw: b.raw },
    );
    assert.ok(form.cf_token.length < 16000, `jeton de ${form.cf_token.length} caractères`);
  } finally {
    server.close();
  }
});

test('D1 : un jeton déjà accepté reste refusé (rejeu) après un redémarrage du serveur avec SQLite', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const store = `sqlite:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-restart-')), 'etat.db')}`;
  const first = await start({ store });
  const { form } = await first.makeForm();
  await wait(LIMITS.minAgeMs + 100);
  assert.equal((await first.post(form)).status, 200);
  first.server.close();
  first.app.locals.store.close();

  // « redémarrage » : nouvelle application, même secret, même base
  const second = await start({ store });
  try {
    const r = await (await second.post(form)).json();
    assert.equal(r.ok, false);
    assert.equal(
      r.steps.find((s) => s.ok === false).id,
      'replay',
      'le nonce consommé avant le redémarrage reste consommé',
    );
  } finally {
    second.server.close();
    second.app.locals.store.close();
  }
});

test('D1 : un défi émis avant le redémarrage reste utilisable après (nonce persistant)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const store = `sqlite:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-restart-')), 'etat.db')}`;
  const first = await start({ store });
  const { form } = await first.makeForm();
  first.server.close();
  first.app.locals.store.close();

  const second = await start({ store });
  try {
    await wait(LIMITS.minAgeMs + 100);
    assert.equal((await second.post(form)).status, 200);
  } finally {
    second.server.close();
    second.app.locals.store.close();
  }
});

test('D2 : /api/stats n’existe pas sans ADMIN_TOKEN, refuse un mauvais jeton, agrège les décisions', async () => {
  const off = await start();
  const on = await start({ adminToken: 's3cr3t-admin', scoreApi: true });
  try {
    assert.equal(
      (await fetch(`${off.base}/api/stats`, { headers: { Authorization: 'Bearer anything' } }))
        .status,
      404,
    );
    assert.equal((await fetch(`${on.base}/api/stats`)).status, 401);
    assert.equal(
      (await fetch(`${on.base}/api/stats`, { headers: { Authorization: 'Bearer wrong' } })).status,
      401,
    );

    const ok = await on.makeForm();
    const bot = await on.makeForm({ ...clean, webdriver: true, softwareGpu: true });
    const peek = await on.makeForm();
    await wait(LIMITS.minAgeMs + 100);
    assert.equal((await on.post(ok.form)).status, 200);
    assert.equal((await on.post(bot.form)).status, 403);
    assert.equal((await on.post({ ...peek.form, website: 'spam' })).status, 403);
    // l'oracle /api/score ne journalise rien
    await fetch(`${on.base}/api/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(peek.form),
    });

    const r = await fetch(`${on.base}/api/stats`, {
      headers: { Authorization: 'Bearer s3cr3t-admin' },
    });
    assert.equal(r.status, 200);
    const stats = await r.json();
    assert.equal(stats.total, 3);
    assert.equal(stats.accepted, 1);
    assert.ok(stats.topRules.some((x) => x.id === 'webdriver'));
    assert.deepEqual(stats.topSteps.map((x) => x.id).sort(), ['honeypot', 'threshold']);
    assert.doesNotMatch(
      JSON.stringify(stats),
      /127\.0\.0\.1|node-test-agent/,
      'aucune donnée personnelle dans les statistiques',
    );
  } finally {
    off.server.close();
    on.server.close();
  }
});

// ── D3 : palier intermédiaire ───────────────────────────────────────────────────────────────────────
// 100 − GPU logiciel 30 − un seul cœur 10 − aucune voix 5 = 55 : entre le seuil abaissé (40) et le seuil (60).
const borderline = { ...clean, softwareGpu: true, gpuRenderer: 'SwiftShader', cores: 1, voices: 0 };

test('D3 : un score limite reçoit un défi de palier, puis est accepté avec le seuil abaissé (et une seule décision journalisée)', async () => {
  const { resolveStepUp } = await import('../docs/js/token.js');
  const { server, base, post, makeForm } = await start({ stepUpBits: 1, adminToken: 'adm' });
  try {
    const { form } = await makeForm(borderline);
    await wait(LIMITS.minAgeMs + 100);
    const first = await (await post(form)).json();
    assert.equal(first.ok, false);
    assert.equal(first.steps.find((x) => x.ok === false).id, 'threshold');
    assert.equal(first.score, 55);
    assert.equal(first.stepUp.up, 1);
    assert.equal(first.stepUp.bits, LIMITS.powBits + 1, 'preuve de travail plus lourde');

    const second = await post(await resolveStepUp(form, first.stepUp));
    const body = await second.json();
    assert.equal(second.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.steps.find((x) => x.id === 'threshold').p.min, 40, 'seuil abaissé de 20');
    assert.ok(body.pass, 'un jeton de passage est délivré');

    const stats = await (
      await fetch(`${base}/api/stats`, { headers: { Authorization: 'Bearer adm' } })
    ).json();
    assert.equal(
      stats.total,
      1,
      'l’offre de palier n’est pas une décision : seule la décision finale est journalisée',
    );
    assert.equal(stats.accepted, 1);
  } finally {
    server.close();
  }
});

test('D3 : jamais de palier en présence d’automatisation, ni sous le seuil abaissé', async () => {
  const { server, post, makeForm } = await start();
  try {
    const automated = await makeForm({ ...clean, webdriver: true }); // 50 : dans la bande, mais webdriver
    const tooLow = await makeForm({ ...borderline, canvasBlank: true }); // 35 : sous 40
    await wait(LIMITS.minAgeMs + 100);
    const a = await (await post(automated.form)).json();
    assert.equal(a.ok, false);
    assert.equal(a.stepUp, undefined, 'automatisation : refus sec');
    const b = await (await post(tooLow.form)).json();
    assert.equal(b.ok, false);
    assert.equal(b.stepUp, undefined, 'trop bas : refus sec');
  } finally {
    server.close();
  }
});

test('D3 : un défi de palier ne se fabrique pas, ne se déguise pas, ne se contourne pas', async () => {
  const { resolveStepUp, buildToken } = await import('../docs/js/token.js');
  const { server, post, makeForm } = await start({ stepUpBits: 1 });
  try {
    const { form, payload } = await makeForm(borderline);
    const forged = await makeForm(borderline, { up: 1 }); // défi NORMAL déguisé en palier
    await wait(LIMITS.minAgeMs + 100);
    const stepUp = (await (await post(form)).json()).stepUp;

    assert.equal(
      (await (await post(forged.form)).json()).steps.find((x) => x.ok === false).id,
      'signature',
      'up ajouté à un défi normal',
    );
    const stripped = await resolveStepUp(form, { ...stepUp, up: undefined });
    assert.equal(
      (await (await post(stripped)).json()).steps.find((x) => x.ok === false).id,
      'signature',
      'up retiré d’un défi de palier',
    );

    const noProof = {
      ...form,
      cf_token: buildToken(stepUp, { counter: 0 }, payload.score, payload.signals, payload.raw)
        .token,
    };
    await wait(LIMITS.minAgeMs + 100);
    assert.equal(
      (await (await post(noProof)).json()).steps.find((x) => x.ok === false).id,
      'pow',
      'palier sans la preuve de travail',
    );
  } finally {
    server.close();
  }
});

test('D3 : le palier n’est proposé qu’une fois (au palier, un score trop bas est refusé sans nouvelle offre)', async () => {
  const { buildToken } = await import('../docs/js/token.js');
  const { solvePow } = await import('../docs/js/token.js');
  const { server, post, makeForm } = await start({ stepUpBits: 1 });
  try {
    const first = await makeForm(borderline);
    await wait(LIMITS.minAgeMs + 100);
    const stepUp = (await (await post(first.form)).json()).stepUp;
    // Au palier, l'attaquant dégrade ses signaux (35 < 40) : pas de seconde offre, refus.
    const low = await makeForm({ ...borderline, canvasBlank: true });
    const pow = await solvePow(stepUp.nonce, stepUp.bits);
    await wait(LIMITS.minAgeMs + 100);
    const token = buildToken(
      stepUp,
      pow,
      low.payload.score,
      low.payload.signals,
      low.payload.raw,
    ).token;
    const r = await (await post({ ...first.form, cf_token: token })).json();
    assert.equal(r.ok, false);
    assert.equal(r.stepUp, undefined);
    assert.equal(r.steps.find((x) => x.ok === false).id, 'threshold');
  } finally {
    server.close();
  }
});

// ── Mode observation ────────────────────────────────────────────────────────────────────────────────
test('observation : un robot est accepté en apparence mais la décision réelle est journalisée', async () => {
  const { server, base, post, makeForm } = await start({ observe: true, adminToken: 'adm' });
  try {
    const bot = await makeForm({ ...clean, webdriver: true, softwareGpu: true }); // score 20 : refusé hors observation
    const spam = await makeForm();
    await wait(LIMITS.minAgeMs + 100);
    const r = await post(bot.form);
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.observed, true);
    assert.equal(body.wouldReject, true);
    assert.equal(
      body.steps.find((x) => x.ok === false).id,
      'threshold',
      'l’étape qui aurait refusé reste visible',
    );
    assert.equal(body.stepUp, undefined, 'pas de palier en observation');
    assert.ok(body.pass);

    const honeypot = await (await post({ ...spam.form, website: 'spam' })).json();
    assert.equal(honeypot.ok, true);
    assert.equal(honeypot.wouldReject, true, 'même le champ piège rempli est seulement noté');

    // la décision RÉELLE est dans les statistiques : deux refus qui auraient eu lieu
    const stats = await (
      await fetch(`${base}/api/stats`, { headers: { Authorization: 'Bearer adm' } })
    ).json();
    assert.equal(stats.observe, true);
    assert.equal(stats.total, 2);
    assert.equal(stats.accepted, 0);
    assert.ok(stats.topRules.some((x) => x.id === 'webdriver'));

    // le jeton de passage porte « observed »
    const sv = await (
      await fetch(`${base}/api/siteverify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass: body.pass }),
      })
    ).json();
    assert.deepEqual(sv, { success: true, score: 20, observed: true });
  } finally {
    server.close();
  }
});

test('observation : un visiteur normal reste accepté sans la marque « wouldReject », et sans observation le robot est refusé', async () => {
  const obs = await start({ observe: true });
  const normal = await start();
  try {
    const a = await obs.makeForm();
    const b = await normal.makeForm({ ...clean, webdriver: true, softwareGpu: true });
    await wait(LIMITS.minAgeMs + 100);
    const ok = await (await obs.post(a.form)).json();
    assert.equal(ok.ok, true);
    assert.equal(ok.wouldReject, undefined);
    assert.equal(ok.observed, true);
    assert.equal(
      (await normal.post(b.form)).status,
      403,
      'sans observation, la même requête de robot est refusée',
    );
  } finally {
    obs.server.close();
    normal.server.close();
  }
});

test('rotation : un jeton émis avant le changement de secret reste valable pendant la transition, puis est refusé', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const store = `sqlite:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-rot-')), 'etat.db')}`;
  const first = await start({ store }); // secret « s3cret »
  const a = await first.makeForm();
  const b = await first.makeForm();
  first.server.close();
  first.app.locals.store.close();

  // redémarrage avec un NOUVEAU secret, l'ancien étant conservé pour la transition
  const transition = await start({ store, secret: 'nouveau-secret', previousSecrets: ['s3cret'] });
  await wait(LIMITS.minAgeMs + 100);
  const ok = await transition.post(a.form);
  assert.equal(ok.status, 200, 'défi signé avant le changement : accepté');
  const fresh = await (
    await fetch(`${transition.base}/api/challenge`, { headers: { 'User-Agent': UA } })
  ).json();
  assert.ok(fresh.csig, 'de nouveaux défis sont émis');
  transition.server.close();
  transition.app.locals.store.close();

  // transition terminée : l'ancien secret est retiré, le jeton b (émis avec l'ancien secret) n'est plus valable
  const done = await start({ store, secret: 'nouveau-secret' });
  try {
    const r = await (await done.post(b.form)).json();
    assert.equal(r.ok, false);
    assert.equal(r.steps.find((x) => x.ok === false).id, 'signature');
  } finally {
    done.server.close();
    done.app.locals.store.close();
  }
});
