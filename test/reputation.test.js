import test from 'node:test';
import assert from 'node:assert/strict';
import { createReputation } from '../lib/reputation.js';

const sig = {
  ua: 'UA',
  gpuRenderer: 'GPU',
  canvasHash: 'c1',
  audioHash: 'a1',
  fonts: 12,
  cores: 8,
};

test('même empreinte acceptée trop souvent : refusée', () => {
  const rep = createReputation({ fpMax: 2, ipMax: 100 });
  for (let i = 0; i < 2; i++) {
    assert.equal(rep.check(sig, `10.0.0.${i}`)[0], true);
    rep.accept(sig, `10.0.0.${i}`);
  }
  const [ok, d] = rep.check(sig, '10.0.0.9');
  assert.equal(ok, false);
  assert.equal(d, 'fpBurst');
  assert.equal(
    rep.check({ ...sig, canvasHash: 'c2' }, '10.0.0.9')[0],
    true,
    'une autre empreinte passe',
  );
});

test('trop de validations depuis une IP : refusée', () => {
  const rep = createReputation({ fpMax: 100, ipMax: 3 });
  for (let i = 0; i < 3; i++) rep.accept({ ...sig, canvasHash: `c${i}` }, '1.2.3.4');
  assert.equal(rep.check({ ...sig, canvasHash: 'new' }, '1.2.3.4')[1], 'ipBurst');
  assert.equal(rep.check({ ...sig, canvasHash: 'new' }, '5.6.7.8')[0], true);
});

test('preuve de travail adaptative : la difficulté monte avec les demandes', () => {
  const rep = createReputation({ baseBits: 14, challengesPerBit: 5, maxExtraBits: 3 });
  const bits = Array.from({ length: 30 }, () => rep.challengeBits('9.9.9.9'));
  assert.equal(bits[0], 14);
  assert.equal(bits.at(-1), 17, 'plafonnée à base + maxExtraBits');
  assert.equal(rep.challengeBits('8.8.8.8'), 14, 'une autre IP repart de la base');
});
