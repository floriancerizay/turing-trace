import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryStore, createSqliteStore, createStore } from '../lib/store.js';
import { createTokenService } from '../lib/token.js';
import { createReputation } from '../lib/reputation.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-store-')), 'state.db');
const implementations = {
  memory: (opts) => createMemoryStore(opts),
  sqlite: (opts) => createSqliteStore(tmpDb(), opts),
};

for (const [name, make] of Object.entries(implementations)) {
  test(`D1 [${name}] : compteurs à fenêtre glissante`, () => {
    const s = make();
    try {
      assert.equal(s.add('x', 'k', 1000, 500), 1);
      assert.equal(s.add('x', 'k', 1200, 500), 2);
      assert.equal(s.count('x', 'k', 1300, 500), 2);
      assert.equal(s.count('x', 'k', 1600, 500), 1, 'le premier événement est sorti de la fenêtre');
      assert.equal(s.count('x', 'k', 2000, 500), 0);
      assert.equal(s.count('x', 'autre', 1300, 500), 0, 'clés indépendantes');
      assert.equal(s.count('y', 'k', 1300, 500), 0, 'espaces de noms indépendants');
    } finally {
      s.close();
    }
  });

  test(`D1 [${name}] : un marqueur n'est consommable qu'une fois, et pas après expiration`, () => {
    const s = make();
    try {
      s.set('nonce', 'a', 5000);
      s.set('nonce', 'b', 5000);
      assert.equal(s.size('nonce'), 2);
      assert.equal(s.take('nonce', 'a', 1000), true);
      assert.equal(s.take('nonce', 'a', 1000), false, 'déjà consommé');
      assert.equal(s.take('nonce', 'b', 6000), false, 'expiré');
      assert.equal(s.take('nonce', 'inconnu', 1000), false);
      assert.equal(s.size('nonce'), 0);
    } finally {
      s.close();
    }
  });

  test(`D1 [${name}] : plafond d'entrées (les plus anciennes sont supprimées)`, () => {
    const s = make({ maxEntries: 3 });
    try {
      for (let i = 0; i < 205; i++) s.set('m', `n${i}`, 1e12); // > 200 écritures : déclenche le contrôle périodique de SQLite
      s.sweep(0);
      assert.ok(s.size('m') <= 3, `${s.size('m')} marqueurs`);
      assert.equal(s.take('m', 'n204', 0), true, 'le plus récent est conservé');
      assert.equal(s.take('m', 'n0', 0), false, 'le plus ancien a été supprimé');
    } finally {
      s.close();
    }
  });

  test(`D1 [${name}] : journal borné et filtrable par date`, () => {
    const s = make();
    try {
      for (let i = 0; i < 5; i++) s.append('log', { t: 100 * i, ok: i % 2 === 0, score: i });
      assert.equal(s.entries('log').length, 5);
      assert.deepEqual(
        s.entries('log', 250).map((e) => e.score),
        [3, 4],
      );
      assert.equal(s.entries('autre').length, 0);
    } finally {
      s.close();
    }
  });

  test(`D1 [${name}] : le service de jetons et la réputation fonctionnent sur ce stockage`, () => {
    const s = make();
    try {
      const svc = createTokenService('k', { store: s });
      const ch = svc.issueChallenge();
      assert.equal(svc.pending(), 1);
      assert.equal(svc.consumeNonce(ch.nonce), true);
      assert.equal(svc.consumeNonce(ch.nonce), false);
      const pass = svc.issuePass(80, '1.2.3.4');
      assert.equal(svc.redeemPass(pass, '1.2.3.4').success, true);
      assert.equal(svc.redeemPass(pass, '1.2.3.4').error, 'already-used');

      const rep = createReputation({ store: s, fpMax: 2, ipMax: 100 });
      const sig = { ua: 'u', canvasHash: 'c' };
      rep.accept(sig, '1.1.1.1');
      rep.accept(sig, '2.2.2.2');
      assert.equal(rep.check(sig, '3.3.3.3')[1], 'fpBurst');
      rep.acceptTrace('abc');
      assert.equal(rep.traceSeen('abc'), true);
      assert.equal(rep.traceSeen('def'), false);
    } finally {
      s.close();
    }
  });
}

test('D1 : un état SQLite survit à la fermeture et à la réouverture de la base', () => {
  const file = tmpDb();
  const a = createSqliteStore(file);
  a.set('nonce', 'persistant', Date.now() + 60_000);
  a.add('fp', 'empreinte', Date.now(), 60_000);
  a.append('log', { t: Date.now(), ok: true });
  a.close();

  const b = createSqliteStore(file);
  try {
    assert.equal(b.size('nonce'), 1);
    assert.equal(b.count('fp', 'empreinte', Date.now(), 60_000), 1);
    assert.equal(b.entries('log').length, 1);
    assert.equal(b.take('nonce', 'persistant', Date.now()), true);
    assert.equal(b.take('nonce', 'persistant', Date.now()), false, 'consommé : il le reste');
  } finally {
    b.close();
  }
});

test('D1 : createStore interprète la spécification', () => {
  const m = createStore(undefined);
  const m2 = createStore('memory');
  assert.equal(m.kind, 'memory');
  assert.equal(m2.kind, 'memory');
  const s = createStore(`sqlite:${tmpDb()}`);
  assert.equal(s.kind, 'sqlite');
  assert.equal(createStore(s), s, 'une instance est utilisée telle quelle');
  assert.throws(() => createStore('redis://x'), /STORE inconnu/);
  [m, m2, s].forEach((x) => x.close());
});
