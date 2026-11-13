import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { requireHuman } from '../lib/middleware.js';
import { createApp } from '../server.js';

async function serve(app) {
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function site(opts) {
  const app = express();
  app.post('/form', express.json(), requireHuman(opts), (req, res) =>
    res.json({ ok: true, score: req.turingTrace.score }),
  );
  return serve(app);
}
const send = (url, body, headers = {}) =>
  fetch(`${url}/form`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('middleware : jeton absent, invalide, score bas, valide', async () => {
  const redeem = async (pass) =>
    ({ good: { success: true, score: 80 }, low: { success: true, score: 30 } })[pass] ?? {
      success: false,
      error: 'bad-signature',
    };
  const { server, url } = await site({ redeem, minScore: 60 });
  try {
    assert.deepEqual(await (await send(url, {})).json(), { ok: false, error: 'missing-pass' });
    assert.equal(
      (await (await send(url, { turing_trace_pass: 'nope' })).json()).error,
      'bad-signature',
    );
    assert.equal((await (await send(url, { turing_trace_pass: 'low' })).json()).error, 'low-score');
    assert.deepEqual(await (await send(url, { turing_trace_pass: 'good' })).json(), {
      ok: true,
      score: 80,
    });
    assert.equal(
      (await send(url, {}, { 'X-Turing-Trace-Pass': 'good' })).status,
      200,
      'jeton dans l’en-tête',
    );
  } finally {
    server.close();
  }
});

test('middleware : vérificateur injoignable → refus (fail closed) ; failOpen → laisse passer', async () => {
  const down = { verifyUrl: 'http://127.0.0.1:9/api/siteverify', timeoutMs: 500 };
  const a = await site(down);
  const b = await site({ ...down, failOpen: true });
  try {
    assert.equal(
      (await (await send(a.url, { turing_trace_pass: 'x' })).json()).error,
      'verifier-unreachable',
    );
    assert.equal((await send(b.url, { turing_trace_pass: 'x' })).status, 200);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test('CORS : seules les origines déclarées sont autorisées, jamais sur /api/siteverify', async () => {
  const { server, url } = await serve(
    createApp({ secret: 'c', allowedOrigins: ['http://site.example'] }),
  );
  try {
    const ok = await fetch(`${url}/api/challenge`, { headers: { Origin: 'http://site.example' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://site.example');
    const other = await fetch(`${url}/api/challenge`, {
      headers: { Origin: 'http://evil.example' },
    });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    const sv = await fetch(`${url}/api/siteverify`, {
      method: 'POST',
      headers: { Origin: 'http://site.example', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(sv.headers.get('access-control-allow-origin'), null);
  } finally {
    server.close();
  }
});

test('D4 : failOpen sans jeton ne laisse passer que si le serveur Turing Trace est réellement injoignable', async () => {
  const { createApp: make } = await import('../server.js');
  const alive = await serve(make({ secret: 'm' }));
  const down = { verifyUrl: 'http://127.0.0.1:9/api/siteverify', timeoutMs: 500, failOpen: true };
  const up = { verifyUrl: `${alive.url}/api/siteverify`, timeoutMs: 1500, failOpen: true };
  const a = await site(down);
  const b = await site(up);
  const c = await site({ ...down, failOpen: false });
  try {
    // service en panne + failOpen : accepté, marqué non vérifié
    const r = await send(a.url, {});
    assert.equal(r.status, 200);
    // service joignable : omettre le jeton ne suffit pas
    const blocked = await send(b.url, {});
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error, 'missing-pass');
    // sans failOpen : toujours refusé, même si le service est en panne
    assert.equal((await send(c.url, {})).status, 403);
  } finally {
    a.server.close();
    b.server.close();
    c.server.close();
    alive.server.close();
  }
});

test('D4 : /api/health répond sans état', async () => {
  const { createApp: make } = await import('../server.js');
  const { server, url } = await serve(make({ secret: 'm' }));
  try {
    assert.deepEqual(await (await fetch(`${url}/api/health`)).json(), { ok: true });
  } finally {
    server.close();
  }
});

test('observation : un jeton « observed » n’est pas refusé sur le score ; un jeton normal de score bas l’est toujours', async () => {
  const redeem = async (pass) =>
    ({ obs: { success: true, score: 20, observed: true }, low: { success: true, score: 20 } })[
      pass
    ];
  const { server, url } = await site({ redeem, minScore: 60 });
  try {
    const seen = await send(url, { turing_trace_pass: 'obs' });
    assert.equal(seen.status, 200);
    assert.equal((await (await send(url, { turing_trace_pass: 'low' })).json()).error, 'low-score');
  } finally {
    server.close();
  }
});
