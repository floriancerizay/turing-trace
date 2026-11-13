import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHeaders, parseSecChUa } from '../lib/headers.js';

const sig = {
  uachPlatform: 'Windows',
  uachBrands: 'Google Chrome 130.0.6723.70,Chromium 130.0.6723.70',
  lang: 'fr-FR',
};
const real = {
  'sec-ch-ua': '"Google Chrome";v="130", "Chromium";v="130", "Not?A_Brand";v="99"',
  'sec-ch-ua-platform': '"Windows"',
  'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
};

test('vrai Chrome : en-têtes et JavaScript cohérents', () => {
  assert.deepEqual([...parseSecChUa(real['sec-ch-ua'])], ['Google Chrome', 'Chromium']);
  assert.deepEqual(checkHeaders(real, sig, true), [true, 'ok']);
});

test('Firefox / Safari (pas de Client Hints) : seule la langue est comparée', () => {
  assert.deepEqual(checkHeaders({ 'accept-language': 'en-US' }, { lang: 'en-GB' }, true), [
    true,
    'ok',
  ]);
  assert.equal(
    checkHeaders({ 'accept-language': 'de-DE' }, { lang: 'en-US' }, true)[2].codes[0],
    'lang|en-US|de-de',
  );
});

test('Client Hints absents de la requête alors que le JavaScript les expose', () => {
  assert.deepEqual(checkHeaders({ 'accept-language': 'fr' }, sig, true)[2].codes, [
    'hints_missing',
  ]);
  assert.deepEqual(
    checkHeaders({ 'accept-language': 'fr' }, sig, false),
    [true, 'ok'],
    'HTTP non sécurisé : le navigateur n’en envoie pas',
  );
});
