// Défi, preuve de travail et construction du jeton côté navigateur.
// Mode « server » : défi signé par l'API Express (HMAC). Mode « demo » : tout est simulé localement
// (signature = simple SHA-256 sans secret : aucune valeur de sécurité, uniquement pédagogique).
import { LIMITS, encodeToken, decodeToken, powInput, leadingZeroBits } from './verify.js';
import { sha256Hex, sha256Bytes } from './fingerprint.js';

const demoSig = (nonce, ts, bits) => sha256Hex(`demo:${nonce}.${ts}.${bits}`);

export async function getChallenge(mode, bits = LIMITS.powBits) {
  if (mode === 'server') {
    const r = await fetch('api/challenge', { cache: 'no-store' });
    if (!r.ok) throw new Error(`challenge HTTP ${r.status}`);
    return r.json();
  }
  const nonce = [...crypto.getRandomValues(new Uint8Array(12))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const ts = Date.now();
  return { nonce, ts, bits, csig: await demoSig(nonce, ts, bits) };
}

/** Cherche counter tel que SHA-256(nonce:counter) ait `bits` bits de poids fort à zéro. */
export async function solvePow(nonce, bits, onProgress) {
  const BATCH = 256;
  for (let base = 0; ; base += BATCH) {
    const res = await Promise.all(
      Array.from({ length: BATCH }, (_, i) => sha256Bytes(powInput(nonce, base + i))),
    );
    for (let i = 0; i < BATCH; i++)
      if (leadingZeroBits(res[i]) >= bits) return { counter: base + i, attempts: base + i + 1 };
    onProgress?.(base + BATCH);
  }
}

export function buildToken(challenge, pow, score, signals, raw = null) {
  const payload = {
    nonce: challenge.nonce,
    ts: challenge.ts,
    bits: challenge.bits,
    csig: challenge.csig,
    score,
    signals,
    pow: pow ? { counter: pow.counter } : null,
    raw,
    up: challenge.up ? 1 : undefined, // défi de palier
  };
  return { payload, token: encodeToken(payload) };
}

/**
 * Palier : le serveur a jugé le score limite et propose un défi plus lourd. On résout la preuve de travail, on attend
 * l'âge minimal du défi, puis on renvoie le MÊME comportement (score, signaux, données brutes) sous ce nouveau défi.
 */
export async function resolveStepUp(form, challenge, onProgress) {
  const p = decodeToken(form.cf_token);
  const pow = await solvePow(challenge.nonce, challenge.bits, onProgress);
  const wait = LIMITS.minAgeMs + 100 - (Date.now() - challenge.ts);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return { ...form, cf_token: buildToken(challenge, pow, p.score, p.signals, p.raw).token };
}

/** Dépendances de vérification pour le mode démo (navigateur uniquement). */
export function demoDeps(minScore, weights) {
  const used = new Set();
  return {
    checkSig: async (n, ts, bits, csig) => csig === (await demoSig(n, ts, bits)),
    consumeNonce: (n) => (used.has(n) ? false : (used.add(n), true)),
    sha256: sha256Bytes,
    now: Date.now,
    minScore,
    weights,
  };
}
