import crypto from 'node:crypto';
import { DEFAULT_MAX_ENTRIES } from './bounded.js';
import { createMemoryStore } from './store.js';

// Mémoire de réputation (fenêtres glissantes) dans le stockage (mémoire ou SQLite, voir lib/store.js).
//  - empreinte : un même profil matériel/logiciel validé trop souvent = un profil cloné utilisé en masse ;
//  - IP : trop de validations réussies depuis une même adresse ;
//  - trajectoire : une trajectoire de souris strictement identique déjà acceptée ;
//  - défis : plus une IP demande de défis, plus la preuve de travail est difficile.
export function createReputation({
  windowMs = 10 * 60_000,
  fpMax = Number(process.env.FP_MAX) || 5,
  ipMax = Number(process.env.PASS_PER_IP) || 10,
  baseBits = 14,
  maxExtraBits = 6,
  challengesPerBit = 15,
  maxEntries = DEFAULT_MAX_ENTRIES, // plafond par table : les plus anciennes entrées sont supprimées
  store = createMemoryStore({ maxEntries }),
} = {}) {
  /** Empreinte stable : uniquement des attributs qui ne changent pas d'une visite à l'autre. */
  const fingerprintKey = (s) =>
    crypto
      .createHash('sha256')
      .update(
        JSON.stringify([
          s.ua,
          s.gpuRenderer,
          s.canvasHash,
          s.audioHash,
          s.fonts,
          s.cores,
          s.memory,
          s.voices,
          s.codecs,
        ]),
      )
      .digest('base64url')
      .slice(0, 22);

  const win = windowMs / 60_000;
  return {
    fingerprintKey,
    /** Avant acceptation : [ok, détail, paramètres] (format des étapes de verify.js). */
    check(signals, addr) {
      const now = Date.now();
      const nf = store.count('fp', fingerprintKey(signals), now, windowMs);
      const ni = store.count('ip', addr, now, windowMs);
      if (nf >= fpMax) return [false, 'fpBurst', { fp: nf, win, max: fpMax }];
      if (ni >= ipMax) return [false, 'ipBurst', { ip: ni, win, max: ipMax }];
      return [true, 'ok', { fp: nf, ip: ni, win }];
    },
    accept(signals, addr) {
      const now = Date.now();
      store.add('fp', fingerprintKey(signals), now, windowMs);
      store.add('ip', addr, now, windowMs);
    },
    /** Une trajectoire de souris identique a-t-elle déjà été acceptée dans la fenêtre ? */
    traceSeen(hash) {
      return store.count('tr', hash, Date.now(), windowMs) > 0;
    },
    acceptTrace(hash) {
      if (hash) store.add('tr', hash, Date.now(), windowMs);
    },
    /** Difficulté de la preuve de travail selon le nombre de défis demandés par l'IP dans la dernière minute. */
    challengeBits(addr) {
      const n = store.add('ch', addr, Date.now(), 60_000);
      return baseBits + Math.min(maxExtraBits, Math.floor(n / challengesPerBit));
    },
  };
}
