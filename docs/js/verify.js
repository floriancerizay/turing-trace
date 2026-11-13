// Encodage du jeton et logique de vérification, partagés entre le navigateur (mode démo)
// et le serveur Express (mode réel). Seules les dépendances (signature, nonce, SHA-256) changent.
import { evaluate, DEFAULT_THRESHOLD } from './scoring.js';
import { analyzeMouse, analyzeKeys, analyzeTouch } from './behavior.js';
import { decodeRaw, summarizeMouse, summarizeKeys, summarizeTouch } from './signals.js';

// stepUpRelax : points retirés du seuil pour un visiteur qui accepte la vérification supplémentaire (palier) ;
// stepUpBits : bits de preuve de travail ajoutés pour ce palier (2^4 = 16 fois plus de calcul, environ 1 s).
export const LIMITS = {
  minAgeMs: 2000,
  maxAgeMs: 120000,
  maxScoreGap: 15,
  powBits: 14,
  stepUpRelax: 20,
  stepUpBits: 4,
};

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64uEncode(str) {
  const bytes = enc.encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return dec.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export const encodeToken = (payload) => b64uEncode(JSON.stringify(payload));

export function decodeToken(token) {
  try {
    const p = JSON.parse(b64uDecode(String(token)));
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

export function leadingZeroBits(bytes) {
  let bits = 0;
  for (const b of bytes) {
    if (b === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(b) - 24;
    break;
  }
  return bits;
}

export const powInput = (nonce, counter) => `${nonce}:${counter}`;

const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol;
const FLOAT_TOL = 0.002; // arrondi à 3 décimales du résumé, marge pour les écarts entre moteurs JavaScript
const mouseMatches = (c, s) =>
  !!c &&
  near(c.n, s.n, 0) &&
  near(c.length, s.length, 1) &&
  ['linearity', 'jitter', 'speedCV', 'intervalCV'].every((k) => near(c[k], s[k], FLOAT_TOL));
const keysMatches = (c, s) =>
  !!c &&
  near(c.count, s.count, 0) &&
  ['dwellMean', 'flightMean', 'downMean'].every((k) => near(c[k], s[k], 1)) &&
  ['dwellCV', 'flightCV'].every((k) => near(c[k], s[k], FLOAT_TOL));
// Aucun résumé tactile déclaré : légitime uniquement si les données brutes ne contiennent aucun geste.
const touchMatches = (c, s) =>
  !c
    ? s.strokes === 0 && s.taps === 0
    : ['strokes', 'taps', 'measurable', 'points', 'radiusDistinct'].every((k) =>
        near(c[k], s[k], 0),
      ) &&
      near(c.tapMean, s.tapMean, 1) &&
      ['linearity', 'jitter', 'speedCV', 'tapCV'].every((k) => near(c[k], s[k], FLOAT_TOL));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Vérifie un formulaire soumis. Renvoie { ok, score, steps }.
 * deps : { checkSig(nonce, ts, bits, csig), consumeNonce(nonce), sha256(str) -> Uint8Array,
 *          now(), minScore, weights, uaHeader }
 */
export async function verifyToken(form, deps) {
  const steps = [];
  const minScore = deps.minScore ?? DEFAULT_THRESHOLD;
  let score = null;
  let failed = false;

  // Chaque étape renvoie [ok, clé de détail, paramètres]. Aucun texte : le navigateur traduit (i18n sd.<id>.<détail>).
  const step = async (id, fn) => {
    if (failed) {
      steps.push({ id, ok: null, d: 'skipped', p: { min: minScore } });
      return;
    }
    const [ok, d, params = {}] = await fn();
    steps.push({ id, ok, d, p: { min: minScore, ...params } });
    if (!ok) {
      failed = true;
      failedId = id;
    }
  };

  let p = null;
  let traceHash = null;
  let failedId = null; // première étape en échec
  let rules = []; // règles de score déclenchées (pour le journal du serveur, jamais renvoyées au client)
  let automationHit = false; // une règle du groupe « automation » est déclenchée : pas de palier possible

  await step('honeypot', async () => (form.website ? [false, 'filled'] : [true, 'empty']));

  await step('decode', async () => {
    p = decodeToken(form.cf_token);
    return p && p.nonce && p.ts && p.csig && p.signals ? [true, 'valid'] : [false, 'malformed'];
  });

  await step('signature', async () =>
    // `up` fait partie de ce que le serveur signe : un défi de palier ne se fabrique pas, et ne se déguise pas en défi normal.
    (await deps.checkSig(p.nonce, p.ts, p.bits, p.csig, !!p.up)) ? [true, 'ok'] : [false, 'bad'],
  );

  // deps.peek : mode « lecture seule » de /api/score (nonce non consommé, délai minimal ignoré)
  await step('replay', async () =>
    deps.peek || deps.consumeNonce(p.nonce) ? [true, 'consumed'] : [false, 'reused'],
  );

  await step('freshness', async () => {
    const age = deps.now() - p.ts;
    if (!deps.peek && age < LIMITS.minAgeMs)
      return [false, 'tooFast', { ms: age, min: LIMITS.minAgeMs }];
    if (age > LIMITS.maxAgeMs)
      return [false, 'expired', { age: Math.round(age / 1000), max: LIMITS.maxAgeMs / 1000 }];
    return [true, 'age', { age: (age / 1000).toFixed(1) }];
  });

  await step('pow', async () => {
    const counter = p.pow?.counter;
    if (!Number.isInteger(counter) || counter < 0) return [false, 'none'];
    const bits = leadingZeroBits(await deps.sha256(powInput(p.nonce, counter)));
    return [bits >= p.bits, bits >= p.bits ? 'ok' : 'low', { bits, need: p.bits }];
  });

  // Le résumé du comportement n'est pas cru : il est recalculé à partir des données brutes jointes au jeton, puis
  // REMPLACE les valeurs déclarées avant le calcul du score. Placé après les contrôles peu coûteux (signature, nonce,
  // preuve de travail) pour ne pas dépenser de calcul sur des jetons forgés.
  await step('behavior', async () => {
    const declared = p.signals;
    const hadBehavior =
      declared.mouse?.n > 0 ||
      declared.keys?.count > 0 ||
      declared.touchInfo?.strokes + declared.touchInfo?.taps > 0;
    if (p.raw == null && hadBehavior) return [false, 'missing'];
    const d = p.raw == null ? { samples: [], keyEvents: [], gestures: [] } : decodeRaw(p.raw);
    if (!d) return [false, 'invalid'];

    const mouse = summarizeMouse(analyzeMouse(d.samples));
    const keys = summarizeKeys(analyzeKeys(d.keyEvents, !!declared.keys?.pasted)); // « collé » reste déclaratif : il ne peut que pénaliser
    const touch = summarizeTouch(analyzeTouch(d.gestures));
    if (p.raw != null) {
      if (!mouseMatches(declared.mouse, mouse)) return [false, 'mismatch', { field: 'mouse' }];
      if (!keysMatches(declared.keys, keys)) return [false, 'mismatch', { field: 'keys' }];
      if (!touchMatches(declared.touchInfo, touch)) return [false, 'mismatch', { field: 'touch' }];
    }

    // Rejeu : exactement la même trajectoire déjà acceptée (enregistrement rejoué sous plusieurs identités).
    if (deps.traceSeen && d.samples.length >= 15) {
      traceHash = hex(await deps.sha256(JSON.stringify(p.raw.m)));
      if (deps.traceSeen(traceHash)) return [false, 'replay'];
    }

    p.signals = { ...declared, mouse, keys, touchInfo: touch };
    return [true, 'ok', { n: mouse.n, k: keys.count }];
  });

  await step('ua', async () => {
    if (!deps.uaHeader) return [true, 'na'];
    return p.signals.ua === deps.uaHeader ? [true, 'same'] : [false, 'diff'];
  });

  // En-têtes HTTP du moteur vs signaux JavaScript (serveur uniquement).
  await step('headers', async () =>
    deps.headerCheck ? deps.headerCheck(p.signals) : [true, 'na'],
  );

  // Réputation (serveur uniquement) : même empreinte ou même IP validées trop souvent.
  await step('reputation', async () =>
    deps.reputation ? deps.reputation(p.signals) : [true, 'na'],
  );

  await step('score', async () => {
    const r = evaluate({ ...p.signals, powSolved: true }, deps.weights);
    score = r.score;
    rules = r.items.filter((i) => i.hit).map((i) => i.id);
    automationHit = r.items.some((i) => i.hit && i.group === 'automation');
    const ok = Math.abs(score - Number(p.score)) <= LIMITS.maxScoreGap;
    return [ok, ok ? 'ok' : 'mismatch', { score, client: p.score }];
  });

  // Défi de palier (`up`, signé) : seuil abaissé de stepUpRelax.
  const minEff = minScore - (p?.up ? LIMITS.stepUpRelax : 0);
  await step('threshold', async () => [
    score >= minEff,
    score >= minEff ? 'ok' : 'low',
    { score, min: minEff },
  ]);

  // Palier : un score limite (entre seuil - stepUpRelax et seuil), sans signe d'automatisation et pas déjà au palier, peut
  // racheter une vérification supplémentaire plutôt que d'être refusé. Le serveur émet alors un défi de palier.
  const offerStepUp =
    failedId === 'threshold' &&
    !p.up &&
    score >= minScore - LIMITS.stepUpRelax &&
    !automationHit &&
    deps.stepUp !== false;

  if (!failed) deps.onAccept?.(p.signals, { trace: traceHash });
  // Journal : pour un refus précoce (avant l'étape de score), évaluer quand même les règles sur les signaux déclarés,
  // afin que les statistiques montrent ce qui a trahi les visiteurs refusés.
  if (!rules.length && p?.signals) {
    try {
      rules = evaluate({ ...p.signals, powSolved: true }, deps.weights)
        .items.filter((i) => i.hit)
        .map((i) => i.id);
    } catch {
      /* signaux illisibles */
    }
  }
  if (!offerStepUp) deps.onDecision?.({ ok: !failed, score, step: failedId, rules }); // le palier n'est pas une décision finale
  return { ok: !failed, score, steps, ...(offerStepUp ? { stepUp: true } : {}) };
}
