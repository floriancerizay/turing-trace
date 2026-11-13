import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DICT } from '../docs/js/i18n.js';
import { RULES } from '../docs/js/scoring.js';

const read = (f) => fs.readFileSync(new URL(`../docs/${f}`, import.meta.url), 'utf8');
const main = read('js/main.js') + read('js/admin.js'),
  html = read('index.html') + read('admin.html'),
  verify = read('js/verify.js'),
  fp = read('js/fingerprint.js');

test('EN et FR ont exactement les mêmes clés', () => {
  const en = Object.keys(DICT.en).sort(),
    fr = Object.keys(DICT.fr).sort();
  assert.deepEqual(
    fr.filter((k) => !en.includes(k)),
    [],
    'clés FR absentes de EN',
  );
  assert.deepEqual(
    en.filter((k) => !fr.includes(k)),
    [],
    'clés EN absentes de FR',
  );
});

test('toutes les clés référencées existent', () => {
  const keys = new Set();
  for (const m of main.matchAll(/\bt\('([^']+)'(?! \+)/g)) keys.add(m[1]);
  for (const m of html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) keys.add(m[1]);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g))
    m[1].split(',').forEach((p) => keys.add(p.split(':')[1]));
  for (const r of RULES)
    (['rl.', 're.', 'rd.'].forEach((p) => keys.add(p + r.id)), keys.add('g.' + r.group));
  for (const m of verify.matchAll(/step\('(\w+)'/g)) keys.add('step.' + m[1]);
  for (const m of verify.matchAll(/\[(?:true|false|[^\]]*?), '(\w+)'/g)) void m; // détails vérifiés ci-dessous
  for (const m of fp.matchAll(
    /'(ua_platform|mobile_no_touch|zero_window|chrome_no_chrome|lang_not_in_list|dpr_zero)/g,
  ))
    keys.add('inc.' + m[1]);
  for (const v of ['human', 'suspect', 'bot']) keys.add('v.' + v);
  for (const lang of ['en', 'fr']) {
    const missing = [...keys].filter((k) => !(k in DICT[lang]));
    assert.deepEqual(missing, [], `clés manquantes (${lang})`);
  }
});

test('chaque détail d’étape de vérification est traduit', () => {
  const details = {
    honeypot: ['empty', 'filled'],
    decode: ['valid', 'malformed'],
    signature: ['ok', 'bad'],
    replay: ['consumed', 'reused'],
    freshness: ['age', 'tooFast', 'expired'],
    pow: ['none', 'ok', 'low'],
    ua: ['na', 'same', 'diff'],
    score: ['ok', 'mismatch'],
    threshold: ['ok', 'low'],
    headers: ['na', 'ok', 'mismatch'],
    behavior: ['ok', 'mismatch', 'missing', 'invalid', 'replay'],
    reputation: ['na', 'ok', 'fpBurst', 'ipBurst'],
  };
  for (const lang of ['en', 'fr'])
    for (const [id, ds] of Object.entries(details))
      for (const d of ds) assert.ok(`sd.${id}.${d}` in DICT[lang], `sd.${id}.${d} (${lang})`);
});

test('chaque code d’incohérence d’en-tête est traduit', () => {
  const src = fs.readFileSync(new URL('../lib/headers.js', import.meta.url), 'utf8');
  const codes = [...src.matchAll(/codes\.push\(`?'?([a-z_]+)/g)].map((m) => m[1]);
  assert.ok(codes.length >= 5);
  for (const lang of ['en', 'fr'])
    for (const c of codes) assert.ok(`hd.${c}` in DICT[lang], `hd.${c} (${lang})`);
});
