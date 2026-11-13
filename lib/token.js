import crypto from 'node:crypto';
import { LIMITS } from '../docs/js/verify.js';
import { clientKey } from './ip.js';
import { DEFAULT_MAX_ENTRIES } from './bounded.js';
import { createMemoryStore } from './store.js';

const NONCE_TTL_MS = LIMITS.maxAgeMs + 30_000;
const PASS_TTL_MS = 5 * 60_000;

/**
 * `secret` signe tout ce qui est émis. `previousSecrets` (rotation) : anciens secrets encore ACCEPTÉS pour vérifier un défi
 * ou un jeton de passage déjà en circulation, mais jamais utilisés pour en signer de nouveaux.
 */
export function createTokenService(
  secret,
  {
    maxEntries = DEFAULT_MAX_ENTRIES,
    store = createMemoryStore({ maxEntries }),
    previousSecrets = [],
  } = {},
) {
  const accepted = [secret, ...previousSecrets.filter((s) => s && s !== secret)]; // le secret courant d'abord
  // Espaces de noms du stockage : « nonce » (défis émis, à usage unique) et « pass » (jetons de passage, à usage unique).
  // Le jeton de passage est lié au préfixe du client (/64 en IPv6), comme le défi.
  const ipHashWith = (key, ip) =>
    crypto
      .createHmac('sha256', key)
      .update(`ip.${clientKey(ip)}`)
      .digest('base64url')
      .slice(0, 16);

  // `bind` : empreinte du client (IP, User-Agent, langue). Un jeton résolu ailleurs ne vérifie pas ici.
  const signWith = (key, nonce, ts, bits, bind = '') =>
    crypto.createHmac('sha256', key).update(`${nonce}.${ts}.${bits}.${bind}`).digest('base64url');
  const sameBytes = (x, y) => {
    const a = Buffer.from(x),
      b = Buffer.from(y);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const passSig = (key, body) =>
    crypto.createHmac('sha256', key).update(`pass.${body}`).digest('base64url');

  return {
    issueChallenge(bits = LIMITS.powBits, bind = '') {
      const nonce = crypto.randomBytes(16).toString('base64url');
      const ts = Date.now();
      store.set('nonce', nonce, ts + NONCE_TTL_MS);
      return { nonce, ts, bits, csig: signWith(secret, nonce, ts, bits, bind) };
    },
    checkSig(nonce, ts, bits, csig, bind = '') {
      if (typeof csig !== 'string') return false;
      // Toutes les clés sont essayées, sans s'arrêter à la première qui convient (temps de calcul indépendant de la clé qui a signé).
      return accepted
        .map((key) => sameBytes(signWith(key, String(nonce), ts, bits, bind), csig))
        .some(Boolean);
    },
    /** Retourne true une seule fois par nonce émis par ce serveur. */
    consumeNonce(nonce) {
      return store.take('nonce', nonce, Date.now());
    },
    /** Jeton de passage : à transmettre à votre backend métier, qui le valide via /api/siteverify. */
    // `observed` : mode observation, le visiteur aurait été refusé mais le serveur n'applique pas la décision.
    issuePass(score, ip = '', ttlMs = PASS_TTL_MS, observed = false) {
      const id = crypto.randomBytes(12).toString('base64url');
      const body = Buffer.from(
        JSON.stringify({
          id,
          score,
          ip: ipHashWith(secret, ip),
          exp: Date.now() + ttlMs,
          ...(observed ? { obs: 1 } : {}),
        }),
      ).toString('base64url');
      store.set('pass', id, Date.now() + ttlMs);
      return `${body}.${passSig(secret, body)}`;
    },
    /** `remoteip` (optionnel, comme Turnstile) : IP du visiteur vue par le backend ; doit correspondre. */
    redeemPass(pass, remoteip) {
      const [body, sig] = String(pass || '').split('.');
      if (!body || !sig) return { success: false, error: 'malformed' };
      // La clé qui a signé ce jeton est aussi celle qui a calculé l'empreinte de l'IP qu'il contient.
      const signer = accepted.filter((key) => sameBytes(passSig(key, body), sig))[0];
      if (signer === undefined) return { success: false, error: 'bad-signature' };
      let p;
      try {
        p = JSON.parse(Buffer.from(body, 'base64url').toString());
      } catch {
        return { success: false, error: 'malformed' };
      }
      if (p.exp < Date.now()) return { success: false, error: 'expired' };
      if (remoteip && p.ip !== ipHashWith(signer, remoteip))
        return { success: false, error: 'ip-mismatch' };
      if (!store.take('pass', p.id, Date.now())) return { success: false, error: 'already-used' };
      return { success: true, score: p.score, ...(p.obs ? { observed: true } : {}) };
    },
    sha256: async (str) => new Uint8Array(crypto.createHash('sha256').update(str).digest()),
    pending: () => store.size('nonce'),
  };
}
