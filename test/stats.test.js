import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../lib/store.js';
import { createStats } from '../lib/stats.js';

test('D2 : le journal ne contient ni IP, ni empreinte, ni contenu : uniquement date, décision, score, étape, règles', () => {
  const store = createMemoryStore();
  const stats = createStats(store);
  stats.record({
    ok: false,
    score: 40,
    step: 'threshold',
    rules: ['webdriver'],
    ip: '203.0.113.9',
    fingerprint: 'abc',
    message: 'secret',
    signals: { ua: 'x' },
  });
  const [entry] = store.entries('decision');
  assert.deepEqual(Object.keys(entry).sort(), ['ok', 'rules', 'score', 'step', 't']);
  assert.doesNotMatch(JSON.stringify(entry), /203\.0\.113|abc|secret/);
  store.close();
});

test('D2 : synthèse (taux, histogramme, règles et étapes les plus fréquentes, fenêtre de temps)', () => {
  const store = createMemoryStore();
  const stats = createStats(store, { windowMs: 1000 });
  const now = Date.now();
  store.append('decision', { t: now - 5000, ok: true, score: 99, step: null, rules: [] }); // hors fenêtre
  for (const [ok, score, step, rules] of [
    [true, 100, null, []],
    [true, 72, null, ['software_gpu']],
    [false, 0, 'threshold', ['webdriver', 'software_gpu']],
    [false, null, 'honeypot', []],
    [false, 45, 'threshold', ['software_gpu']],
  ])
    store.append('decision', { t: now, ok, score, step, rules });
  const s = stats.summary(now);
  assert.equal(s.total, 5);
  assert.equal(s.accepted, 2);
  assert.equal(s.acceptanceRate, 0.4);
  assert.equal(s.histogram.length, 10);
  assert.equal(s.histogram[9].count, 1, '100 dans la dernière tranche');
  assert.equal(s.histogram[7].count, 1);
  assert.equal(s.histogram[0].count, 1);
  assert.equal(s.histogram[4].count, 1);
  assert.deepEqual(s.topRules[0], { id: 'software_gpu', count: 3 });
  assert.deepEqual(s.topSteps[0], { id: 'threshold', count: 2 });
  assert.equal(
    createStats(createMemoryStore()).summary().acceptanceRate,
    null,
    'aucune donnée : pas de taux',
  );
  store.close();
});
