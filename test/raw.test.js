import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeRaw,
  decodeRaw,
  behaviorOf,
  summarizeMouse,
  summarizeKeys,
  RAW_LIMITS,
} from '../docs/js/signals.js';
import { analyzeMouse, analyzeKeys } from '../docs/js/behavior.js';
import { makeTrace } from '../redteam/trace.mjs';

test('aller-retour : positions et durées conservées au pas de 1 px et 1 ms', () => {
  const samples = [
    { x: 10.4, y: 20.6, t: 1000.2 },
    { x: 15, y: 18, t: 1012.7 },
    { x: 40.5, y: 3, t: 1030 },
  ];
  const d = decodeRaw(encodeRaw({ samples }));
  assert.deepEqual(
    d.samples,
    [
      { x: 10, y: 21, t: 1000 },
      { x: 15, y: 18, t: 1013 },
      { x: 41, y: 3, t: 1030 },
    ].map((p, i) => ({ ...p, t: [0, 13, 30][i] })),
  );
});

test('les fenêtres sont tronquées aux dernières données', () => {
  const samples = Array.from({ length: 450 }, (_, i) => ({ x: i, y: 0, t: i * 10 }));
  const keyEvents = Array.from({ length: 260 }, (_, i) => ({
    type: i % 2 ? 'up' : 'down',
    code: 'KeyA',
    t: i * 50,
  }));
  const raw = encodeRaw({ samples, keyEvents });
  assert.equal(raw.m.length, RAW_LIMITS.mouse);
  assert.equal(raw.k.length, RAW_LIMITS.keys);
  assert.equal(decodeRaw(raw).samples.at(-1).t - decodeRaw(raw).samples[0].t, 299 * 10);
});

test('vie privée : l’identité des touches n’est jamais transmise', () => {
  const press = (codes) =>
    codes.flatMap((code, i) => [
      { type: 'down', code, t: i * 200 },
      { type: 'up', code, t: i * 200 + 80 },
    ]);
  const a = encodeRaw({ keyEvents: press(['KeyH', 'KeyE', 'KeyL', 'KeyP']) });
  const b = encodeRaw({ keyEvents: press(['KeyZ', 'KeyX', 'KeyQ', 'KeyW']) });
  assert.deepEqual(a, b, 'deux textes différents au même rythme donnent des données identiques');
  assert.doesNotMatch(
    JSON.stringify(a.k),
    /[A-Za-z]/,
    'que des nombres : ni lettre ni nom de touche',
  );
  assert.ok(
    a.k.every(
      ([type, rank, dt]) =>
        (type === 0 || type === 1) && Number.isInteger(rank) && Number.isInteger(dt),
    ),
  );
});

test('structures invalides refusées', () => {
  for (const raw of [
    null,
    'x',
    {},
    { m: [], k: 5 },
    { m: [[1, 2]], k: [] },
    { m: [[1, 2, 1.5]], k: [] },
    { m: [[1, 2, -1]], k: [] },
    { m: [], k: [[2, 0, 1]] },
    { m: [], k: [[0, 999, 1]] },
    { m: [[1e9, 0, 1]], k: [] },
    { m: [], k: Array(201).fill([0, 0, 1]) },
  ]) {
    assert.equal(decodeRaw(raw), null, JSON.stringify(raw)?.slice(0, 50));
  }
  assert.deepEqual(decodeRaw({ m: [], k: [] }), { samples: [], keyEvents: [], gestures: [] });
});

test('le résumé du client est calculé sur les données quantifiées : le serveur retrouve les mêmes valeurs', () => {
  const tr = makeTrace(42);
  const d = decodeRaw(tr.raw);
  assert.deepEqual(summarizeMouse(analyzeMouse(d.samples)), tr.mouse);
  assert.deepEqual(summarizeKeys(analyzeKeys(d.keyEvents, false)), tr.keys);
  const b = behaviorOf({ samples: tr.samples, keyEvents: tr.keyEvents, pasted: false });
  assert.deepEqual(summarizeMouse(b.mouse), tr.mouse);
});

test('le générateur est reproductible et produit des trajectoires distinctes selon la graine', () => {
  assert.deepEqual(makeTrace(3).raw, makeTrace(3).raw);
  assert.notDeepEqual(makeTrace(3).raw.m, makeTrace(4).raw.m);
});

// ── Phase C : gestes tactiles dans les données brutes ──────────────────────────────────────────────
import { makeGestures } from '../redteam/trace.mjs';
import { analyzeTouch } from '../docs/js/behavior.js';
import { summarizeTouch } from '../docs/js/signals.js';

test('C : les gestes font l’aller-retour (positions entières, rayon au dixième, pression au centième)', () => {
  const gestures = [
    {
      pts: [
        { x: 10.4, y: 20.6, t: 100.2, r: 5.26, f: 0.337 },
        { x: 14, y: 22, t: 116.7, r: 6.04, f: 0.5 },
      ],
    },
  ];
  const d = decodeRaw(encodeRaw({ gestures }));
  assert.deepEqual(d.gestures, [
    {
      pts: [
        { x: 10, y: 21, t: 0, r: 5.3, f: 0.34 },
        { x: 14, y: 22, t: 17, r: 6, f: 0.5 },
      ].map((p, i) => ({ ...p, t: [0, 17][i] })),
    },
  ]);
});

test('C : sans geste, le champ « g » est absent du jeton', () => {
  assert.equal('g' in encodeRaw({ samples: [{ x: 1, y: 1, t: 1 }] }), false);
  assert.equal('g' in encodeRaw({ gestures: [{ pts: [{ x: 1, y: 1, t: 1, r: 1, f: 1 }] }] }), true);
});

test('C : 12 gestes au plus et 30 points par geste (décimation, extrémités conservées)', () => {
  const long = {
    pts: Array.from({ length: 200 }, (_, i) => ({ x: i, y: 0, t: i * 10, r: 5, f: 0.5 })),
  };
  const raw = encodeRaw({ gestures: Array.from({ length: 20 }, () => long) });
  assert.equal(raw.g.length, RAW_LIMITS.gestures);
  assert.ok(raw.g.every(([, pts]) => pts.length <= RAW_LIMITS.gesturePts));
  const pts = decodeRaw(raw).gestures[0].pts;
  assert.equal(pts[0].x, 0);
  assert.equal(pts.at(-1).x, 199);
});

test('C : les résumés tactiles du client et du serveur coïncident (données décimées et quantifiées)', () => {
  const gestures = makeGestures(8);
  const b = behaviorOf({}, { mouse: [], keys: [], gestures });
  const serverSide = summarizeTouch(analyzeTouch(decodeRaw(b.raw).gestures));
  assert.deepEqual(summarizeTouch(b.touch), serverSide);
});

test('C : structures de gestes invalides refusées', () => {
  const ok = [0, [[1, 1, 0, 5, 50]]];
  for (const g of [
    [[0, []]],
    [[0, [[1, 1, 0, 5]]]],
    [[-1, [[1, 1, 0, 5, 5]]]],
    [[0, [[1, 1, -3, 5, 5]]]],
    [[0, [[1, 1, 0, 5000, 5]]]],
    [[0, [[1, 1, 0, 5, 500]]]],
    [[0, [[1.5, 1, 0, 5, 5]]]],
    'x',
    Array(13).fill(ok),
    [[0, Array(31).fill([1, 1, 1, 5, 5])]],
  ]) {
    assert.equal(decodeRaw({ m: [], k: [], g }), null, JSON.stringify(g).slice(0, 50));
  }
  assert.notEqual(decodeRaw({ m: [], k: [], g: [ok] }), null);
});
