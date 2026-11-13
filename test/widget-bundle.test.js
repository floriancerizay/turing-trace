import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildWidget, DIST } from '../scripts/build-widget.mjs';
import { createApp } from '../server.js';

const manifest = () => JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));

test('widget : le fichier construit est à jour avec les sources (sinon : npm run build)', async () => {
  const fresh = await buildWidget();
  const m = manifest();
  assert.equal(m.file, fresh.file, 'les sources ont changé depuis le dernier « npm run build »');
  assert.equal(fs.readFileSync(path.join(DIST, m.file), 'utf8'), fresh.code);
  assert.equal(m.integrity, fresh.integrity);
  assert.deepEqual(
    fs.readdirSync(DIST).filter((f) => f.endsWith('.js')),
    [m.file],
    'aucun ancien fichier ne traîne',
  );
});

test('widget : un seul fichier autonome, plus léger que 40 Ko', async () => {
  const { code, bytes } = await buildWidget();
  assert.doesNotMatch(code, /from\s*"\.{1,2}\//, 'aucun import relatif : tout est dans le fichier');
  assert.ok(bytes < 40_000, `${bytes} octets`);
  assert.match(code, /turing_trace_pass/, 'contient bien le widget');
});

test('widget : l’empreinte d’intégrité du manifeste correspond aux octets réellement servis', async () => {
  const server = await new Promise((r) => {
    const s = createApp({ secret: 'b' }).listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const m = manifest();
    const bytes = Buffer.from(await (await fetch(`${base}/dist/${m.file}`)).arrayBuffer());
    assert.equal(
      `sha384-${crypto.createHash('sha384').update(bytes).digest('base64')}`,
      m.integrity,
    );
  } finally {
    server.close();
  }
});

test('widget : cache d’un an pour le fichier à empreinte, 5 minutes pour /widget.js, rien pour le manifeste', async () => {
  const server = await new Promise((r) => {
    const s = createApp({ secret: 'b' }).listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const m = manifest();
    const hashed = await fetch(`${base}/dist/${m.file}`);
    assert.equal(hashed.status, 200);
    assert.match(hashed.headers.get('content-type'), /javascript/);
    assert.equal(hashed.headers.get('cache-control'), 'public, max-age=31536000, immutable');

    const stable = await fetch(`${base}/widget.js`);
    assert.equal(stable.status, 200);
    assert.match(stable.headers.get('content-type'), /javascript/);
    assert.equal(stable.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(
      await stable.text(),
      await hashed.clone().text(),
      '/widget.js sert le même contenu',
    );

    assert.equal(
      (await fetch(`${base}/dist/manifest.json`)).headers.get('cache-control'),
      'no-cache',
    );
    assert.equal((await fetch(`${base}/dist/widget-0000000000.js`)).status, 404);
    assert.notEqual(
      (await fetch(`${base}/dist/..%2fserver.js`)).status,
      200,
      'pas de sortie du dossier',
    );
  } finally {
    server.close();
  }
});
