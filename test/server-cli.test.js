import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';

test('lancement sur un port déjà utilisé : message explicite et code de sortie 1 (pas de trace d’exception)', async () => {
  const blocker = await new Promise((r) => {
    const s = net.createServer().listen(0, () => r(s));
  });
  const port = blocker.address().port;
  try {
    const child = spawn('node', ['server.js'], {
      env: { ...process.env, PORT: String(port), CAPTCHA_SECRET: 'x' },
    });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d;
    });
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 1);
    assert.match(err, new RegExp(`port ${port} est déjà utilisé`));
    assert.match(err, /PORT=3001 npm start/);
    assert.doesNotMatch(err, /at emitErrorNT|node:net/, 'aucune trace d’exception brute');
  } finally {
    blocker.close();
  }
});
