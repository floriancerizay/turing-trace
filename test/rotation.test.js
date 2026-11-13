import test from 'node:test';
import assert from 'node:assert/strict';
import { createTokenService } from '../lib/token.js';
import { createMemoryStore } from '../lib/store.js';

// Les services partagent un stockage : comme un même serveur redémarré avec un autre secret.
const services = () => {
  const store = createMemoryStore();
  return {
    store,
    old: createTokenService('ancien-secret', { store }),
    renewed: createTokenService('nouveau-secret', { store, previousSecrets: ['ancien-secret'] }),
    afterTransition: createTokenService('nouveau-secret', { store }),
  };
};

test('rotation : un défi signé avec l’ancien secret est encore accepté pendant la transition, puis refusé', () => {
  const { old, renewed, afterTransition } = services();
  const ch = old.issueChallenge(14, 'client');
  assert.equal(renewed.checkSig(ch.nonce, ch.ts, ch.bits, ch.csig, 'client'), true);
  assert.equal(
    afterTransition.checkSig(ch.nonce, ch.ts, ch.bits, ch.csig, 'client'),
    false,
    'ancien secret retiré : refusé',
  );
  assert.equal(
    renewed.checkSig(ch.nonce, ch.ts, ch.bits, ch.csig, 'autre-client'),
    false,
    'la liaison au client reste vérifiée',
  );
});

test('rotation : les nouveaux défis sont signés avec le nouveau secret uniquement', () => {
  const { old, renewed, afterTransition } = services();
  const ch = renewed.issueChallenge(14, 'client');
  assert.equal(
    afterTransition.checkSig(ch.nonce, ch.ts, ch.bits, ch.csig, 'client'),
    true,
    'valide après retrait de l’ancien secret',
  );
  assert.equal(
    old.checkSig(ch.nonce, ch.ts, ch.bits, ch.csig, 'client'),
    false,
    'l’ancien secret ne signe plus rien de nouveau',
  );
});

test('rotation : un jeton de passage de l’ancien secret reste valable, y compris sa liaison à l’IP', () => {
  const { old, renewed, afterTransition } = services();
  const pass = old.issuePass(80, '203.0.113.7');
  assert.equal(
    renewed.redeemPass(pass, '198.51.100.1').error,
    'ip-mismatch',
    'la liaison à l’IP est vérifiée avec le secret qui a signé',
  );
  const pass2 = old.issuePass(80, '203.0.113.7');
  assert.deepEqual(renewed.redeemPass(pass2, '203.0.113.7'), { success: true, score: 80 });
  assert.equal(
    renewed.redeemPass(pass2, '203.0.113.7').error,
    'already-used',
    'toujours à usage unique',
  );
  assert.equal(
    afterTransition.redeemPass(old.issuePass(80, '203.0.113.7')).error,
    'bad-signature',
    'après la transition : refusé',
  );
});

test('rotation : un secret inconnu n’est jamais accepté, les secrets vides et doublons sont ignorés', () => {
  const store = createMemoryStore();
  const attacker = createTokenService('secret-de-l-attaquant', { store });
  const svc = createTokenService('courant', { store, previousSecrets: ['', 'courant', 'ancien'] });
  const ch = attacker.issueChallenge(14, 'c');
  assert.equal(svc.checkSig(ch.nonce, ch.ts, ch.bits, ch.csig, 'c'), false);
  assert.equal(svc.redeemPass(attacker.issuePass(99, '1.2.3.4'), '1.2.3.4').error, 'bad-signature');
  // un secret vide ne doit pas permettre de forger : une signature calculée avec la clé « » est refusée
  const forger = createTokenService('x', { store });
  assert.equal(svc.redeemPass(forger.issuePass(99, '1.2.3.4')).success, false);
});
