import test from 'node:test';
import assert from 'node:assert/strict';
import { capMap } from '../lib/bounded.js';
import { createReputation } from '../lib/reputation.js';
import { createTokenService } from '../lib/token.js';

test('capMap supprime les entrées les plus anciennes', () => {
  const m = new Map([
    [1, 'a'],
    [2, 'b'],
    [3, 'c'],
    [4, 'd'],
  ]);
  capMap(m, 3);
  assert.deepEqual([...m.keys()], [2, 3, 4]);
});

test('A4 : la réputation reste bornée face à des clés toutes différentes', () => {
  const rep = createReputation({ maxEntries: 3 });
  for (let i = 0; i < 50; i++) {
    rep.accept({ ua: 'u', canvasHash: `c${i}` }, `10.0.0.${i}`);
    rep.challengeBits(`10.1.0.${i}`);
  }
  // 3 empreintes et 3 IP maximum : les plus anciennes ont été oubliées, les plus récentes sont conservées
  assert.equal(rep.check({ ua: 'u', canvasHash: 'c49' }, '10.0.0.49')[2].fp, 1);
  assert.equal(
    rep.check({ ua: 'u', canvasHash: 'c0' }, '10.0.0.0')[2].fp,
    0,
    'la plus ancienne a été évincée',
  );
});

test('A4 : défis et jetons de passage bornés', () => {
  const svc = createTokenService('k', { maxEntries: 3 });
  const first = svc.issueChallenge();
  for (let i = 0; i < 10; i++) svc.issueChallenge();
  assert.equal(svc.pending(), 3);
  assert.equal(svc.consumeNonce(first.nonce), false, 'le plus ancien défi a été évincé');
  const passes = Array.from({ length: 10 }, () => svc.issuePass(80, '1.2.3.4'));
  assert.equal(
    svc.redeemPass(passes[0]).error,
    'already-used',
    'le plus ancien jeton de passage a été évincé',
  );
  assert.equal(svc.redeemPass(passes[9], '1.2.3.4').success, true);
});

test('le jeton de passage est lié au /64 en IPv6', () => {
  const svc = createTokenService('k');
  const p = svc.issuePass(80, '2001:db8:1:2::1');
  assert.equal(svc.redeemPass(p, '2001:db8:1:2:ffff::7').success, true, 'même /64');
  const q = svc.issuePass(80, '2001:db8:1:2::1');
  assert.equal(svc.redeemPass(q, '2001:db8:1:9::1').error, 'ip-mismatch');
});
