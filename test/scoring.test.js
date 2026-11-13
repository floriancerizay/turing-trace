import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, verdict } from '../docs/js/scoring.js';
import {
  analyzeMouse,
  analyzeKeys,
  simulateBotMouse,
  simulateBotKeys,
} from '../docs/js/behavior.js';

const clean = {
  ua: 'Mozilla/5.0',
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
  powSolved: true,
  touch: false,
  untrustedEvents: 0,
  mouse: { n: 120, length: 900, linearity: 0.62, jitter: 0.9, speedCV: 0.7, intervalCV: 0.4 },
  keys: { count: 20, pasted: false, dwellMean: 95, dwellCV: 0.3, flightMean: 140, flightCV: 0.5 },
};

test('un profil normal obtient 100', () => {
  assert.equal(evaluate(clean).score, 100);
});

test('webdriver + GPU logiciel font chuter le score', () => {
  const r = evaluate({ ...clean, webdriver: true, softwareGpu: true, gpuRenderer: 'SwiftShader' });
  assert.equal(r.score, 20);
  assert.deepEqual(
    r.items.filter((i) => i.hit).map((i) => i.id),
    ['webdriver', 'software_gpu'],
  );
});

test('les poids configurables sont pris en compte', () => {
  assert.equal(evaluate({ ...clean, webdriver: true }, { webdriver: 10 }).score, 90);
});

test('le score ne descend jamais sous 0', () => {
  assert.equal(
    evaluate({ ...clean, webdriver: true, headlessUA: true, softwareGpu: true, mathNative: false })
      .score,
    0,
  );
});

test('une trajectoire de bot est détectée comme rectiligne, sans jitter, à vitesse constante', () => {
  const m = analyzeMouse(simulateBotMouse());
  assert.ok(m.linearity > 0.999);
  assert.ok(m.jitter < 0.05);
  assert.ok(m.speedCV < 0.01);
  const r = evaluate({ ...clean, mouse: { ...m } });
  const hit = r.items.filter((i) => i.hit).map((i) => i.id);
  for (const id of [
    'mouse_linear',
    'mouse_no_jitter',
    'mouse_constant_speed',
    'mouse_regular_timing',
  ])
    assert.ok(hit.includes(id), id);
});

test('une trajectoire courbe et bruitée n’est pas pénalisée', () => {
  const t0 = 0;
  const samples = Array.from({ length: 100 }, (_, i) => ({
    x: 50 + i * 5 + Math.sin(i / 7) * 40 + ((i * 37) % 5) * 0.4,
    y: 80 + Math.cos(i / 9) * 60 + ((i * 53) % 7) * 0.4,
    t: t0 + i * 8 + ((i * 13) % 5),
  }));
  const m = analyzeMouse(samples);
  const hit = evaluate({ ...clean, mouse: m }).items.filter((i) => i.hit && i.group === 'behavior');
  assert.deepEqual(
    hit.map((i) => i.id),
    [],
  );
});

test('la frappe de bot est détectée', () => {
  const k = analyzeKeys(simulateBotKeys());
  assert.equal(k.count, 14);
  assert.ok(Math.abs(k.dwellMean - 50) < 1e-6);
  assert.ok(Math.abs(k.flightMean - 100) < 1e-6);
  assert.ok(evaluate({ ...clean, keys: k }).items.find((i) => i.id === 'keys_regular').hit);
});

test('frappe injectée (appuis < 25 ms) pénalisée, rollover rapide mais humain épargné', () => {
  const hit = (keys) =>
    evaluate({ ...clean, keys }).items.find((i) => i.id === 'keys_superhuman').hit;
  assert.equal(hit({ ...clean.keys, downMean: 8 }), true);
  assert.equal(hit({ ...clean.keys, flightMean: 1, downMean: 90 }), false);
});

test('verdicts', () => {
  assert.equal(verdict(95).key, 'human');
  assert.equal(verdict(65).key, 'suspect');
  assert.equal(verdict(30).key, 'bot');
});

test('agent IA : téléportation, clics centrés et texte injecté sont détectés', async () => {
  const { simulateAgent } = await import('../docs/js/behavior.js');
  const a = simulateAgent();
  const hit = evaluate({ ...clean, agent: a.agent })
    .items.filter((i) => i.hit)
    .map((i) => i.id);
  for (const id of ['mouse_teleport', 'centered_clicks', 'injected_text'])
    assert.ok(hit.includes(id), id);
  // un humain qui clique deux fois après avoir déplacé la souris n'est pas pénalisé
  const human = evaluate({
    ...clean,
    agent: { clicks: 4, teleports: 1, centered: 0, injected: 0 },
  }).items.filter((i) => i.hit && i.group === 'agent');
  assert.deepEqual(human, []);
});

test('permissions incohérentes et absence de voix', () => {
  const ids = evaluate({ ...clean, permissionsMismatch: true, voices: 0 })
    .items.filter((i) => i.hit)
    .map((i) => i.id);
  assert.deepEqual(ids, ['permissions_mismatch', 'no_voices']);
  assert.equal(
    evaluate({ ...clean, voices: null }).score,
    100,
    'voix inconnues (API absente) : pas de pénalité',
  );
});

// ── Phase C : gestes tactiles ───────────────────────────────────────────────────────────────────────
test('C : des gestes tactiles de type humain ne déclenchent aucune règle', async () => {
  const { makeTouchTrace } = await import('../redteam/trace.mjs');
  for (const seed of [1, 2, 3, 4, 5]) {
    const tr = makeTouchTrace(seed);
    const hit = evaluate({ ...clean, mouse: tr.mouse, keys: tr.keys, touchInfo: tr.touchInfo })
      .items.filter((i) => i.hit)
      .map((i) => i.id);
    assert.deepEqual(hit, [], `graine ${seed}`);
  }
});

test('C : glissements parfaits, tapes identiques et rayon constant sont détectés', async () => {
  const { simulateBotTouch, analyzeTouch } = await import('../docs/js/behavior.js');
  const { summarizeTouch } = await import('../docs/js/signals.js');
  const t = summarizeTouch(analyzeTouch(simulateBotTouch()));
  assert.equal(t.strokes, 3);
  assert.equal(t.taps, 5);
  const hit = evaluate({ ...clean, touchInfo: t })
    .items.filter((i) => i.hit)
    .map((i) => i.id);
  for (const id of ['touch_linear', 'touch_uniform_taps', 'touch_no_contact_area'])
    assert.ok(hit.includes(id), id);
});

test('C : mouse_none n’est levée que par de vrais gestes, pas par le drapeau « touch »', () => {
  const noMouse = {
    ...clean,
    mouse: { n: 0, length: 0, linearity: 0, jitter: 0, speedCV: 0, intervalCV: 0 },
  };
  const hits = (s) =>
    evaluate(s)
      .items.filter((i) => i.hit)
      .map((i) => i.id);
  assert.ok(
    hits({ ...noMouse, touch: true }).includes('mouse_none'),
    'le drapeau seul ne suffit plus',
  );
  assert.ok(hits({ ...noMouse, touchInfo: { strokes: 0, taps: 0 } }).includes('mouse_none'));
  assert.ok(
    !hits({
      ...noMouse,
      touchInfo: { strokes: 1, taps: 2, measurable: 0, points: 12, radiusDistinct: 5 },
    }).includes('mouse_none'),
  );
});

test('C : une seule tape ou un seul glissement ne déclenche pas les règles tactiles (pas assez de données)', async () => {
  const { analyzeTouch } = await import('../docs/js/behavior.js');
  const { summarizeTouch } = await import('../docs/js/signals.js');
  const one = summarizeTouch(
    analyzeTouch([
      {
        pts: [
          { x: 5, y: 5, t: 0, r: 0, f: 0 },
          { x: 5, y: 5, t: 90, r: 0, f: 0 },
        ],
      },
    ]),
  );
  const hit = evaluate({ ...clean, touchInfo: one })
    .items.filter((i) => i.hit)
    .map((i) => i.id);
  assert.deepEqual(hit, []);
});

test('C : des tapes quasi instantanées (1 à 3 ms, durées inégales) sont signalées même si leurs durées ne sont pas identiques', async () => {
  const { analyzeTouch } = await import('../docs/js/behavior.js');
  const { summarizeTouch } = await import('../docs/js/signals.js');
  const taps = [0, 1, 0, 3, 1, 2].map((d, i) => ({
    pts: [
      { x: 50 + i, y: 50, t: i * 400, r: 5, f: 0.3 },
      { x: 50 + i, y: 50, t: i * 400 + d, r: 5, f: 0.3 },
    ],
  }));
  const t = summarizeTouch(analyzeTouch(taps));
  assert.ok(
    t.tapCV > 0.08,
    'le coefficient de variation est élevé : la règle « durées identiques » ne suffit pas',
  );
  const hit = evaluate({ ...clean, touchInfo: t })
    .items.filter((i) => i.hit)
    .map((i) => i.id);
  assert.ok(hit.includes('touch_instant_taps'), hit.join(','));
  assert.ok(!hit.includes('touch_uniform_taps'));
});
