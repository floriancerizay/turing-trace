// Construction du résumé de signaux envoyé dans le jeton. Partagé par le tableau de bord (main.js) et le widget
// (widget.js) : le serveur recalcule le score à partir de ce format exact.
import { analyzeMouse, analyzeKeys, analyzeTouch } from './behavior.js';

const r3 = (n) => Math.round(n * 1000) / 1000;

export const summarizeMouse = (m) => ({
  n: m.n,
  length: Math.round(m.length),
  linearity: r3(m.linearity),
  jitter: r3(m.jitter),
  speedCV: r3(m.speedCV),
  intervalCV: r3(m.intervalCV),
});
export const summarizeTouch = (t) => ({
  strokes: t.strokes,
  taps: t.taps,
  measurable: t.measurable,
  linearity: r3(t.linearity),
  jitter: r3(t.jitter),
  speedCV: r3(t.speedCV),
  tapMean: Math.round(t.tapMean),
  tapCV: r3(t.tapCV),
  points: t.points,
  radiusDistinct: t.radiusDistinct,
});
export const summarizeKeys = (k) => ({
  count: k.count,
  pasted: k.pasted,
  dwellMean: Math.round(k.dwellMean),
  dwellCV: r3(k.dwellCV),
  flightMean: Math.round(k.flightMean),
  flightCV: r3(k.flightCV),
  downMean: Math.round(k.downMean),
});

// ── Données brutes envoyées dans le jeton ───────────────────────────────────────────────────────────
// Le serveur ne croit pas le résumé déclaré (linéarité, jitter…) : il le recalcule à partir de ces données.
// Souris : les 300 derniers points en deltas entiers [dx, dy, dt] (le premier est absolu).
// Frappe : les 200 derniers événements [0 = appui | 1 = relâchement, rang, dt].
// Tactile : les 12 derniers gestes [écart de départ, [[dx, dy, dt, rayon×10, pression×100], …]], 30 points au plus par geste
// (les gestes plus longs sont décimés ; le résumé est calculé après décimation, donc le serveur retrouve les mêmes valeurs).
// Le rang est l'ordre de première apparition de la touche : on ne transmet jamais QUELLE touche a été pressée, donc le
// texte saisi ne peut pas être reconstitué (seul le rythme est conservé).
export const RAW_LIMITS = {
  mouse: 300,
  keys: 200,
  gestures: 12,
  gesturePts: 30,
  coord: 1e6,
  maxDt: 3_600_000,
  maxRank: 255,
  maxRadius: 2000,
  maxForce: 100,
};

export function encodeRaw({ samples = [], keyEvents = [], gestures = [] } = {}) {
  const ms = samples.slice(-RAW_LIMITS.mouse);
  const m = [];
  let px = 0,
    py = 0,
    pt = ms.length ? Math.round(ms[0].t) : 0;
  for (const s of ms) {
    const x = Math.round(s.x),
      y = Math.round(s.y),
      t = Math.round(s.t);
    m.push([x - px, y - py, t - pt]);
    px = x;
    py = y;
    pt = t;
  }

  const ke = keyEvents.slice(-RAW_LIMITS.keys);
  const ranks = new Map();
  const k = [];
  let kt = ke.length ? Math.round(ke[0].t) : 0;
  for (const e of ke) {
    if (!ranks.has(e.code)) ranks.set(e.code, Math.min(ranks.size, RAW_LIMITS.maxRank));
    const t = Math.round(e.t);
    k.push([e.type === 'down' ? 0 : 1, ranks.get(e.code), t - kt]);
    kt = t;
  }
  // Gestes tactiles : 12 derniers, décimés à 30 points (premier et dernier points conservés).
  const g = [];
  let prevStart = null;
  for (const gesture of gestures.filter((q) => q.pts?.length).slice(-RAW_LIMITS.gestures)) {
    const pts = gesture.pts;
    const step = Math.ceil(pts.length / RAW_LIMITS.gesturePts);
    const kept = pts
      .filter((_, i) => i % step === 0 || i === pts.length - 1)
      .slice(0, RAW_LIMITS.gesturePts);
    const start = Math.round(kept[0].t);
    const out = [];
    let qx = 0,
      qy = 0,
      qt = start;
    for (const q of kept) {
      const x = Math.round(q.x),
        y = Math.round(q.y),
        t = Math.round(q.t);
      out.push([
        x - qx,
        y - qy,
        t - qt,
        Math.min(RAW_LIMITS.maxRadius, Math.max(0, Math.round((q.r || 0) * 10))),
        Math.min(RAW_LIMITS.maxForce, Math.max(0, Math.round((q.f || 0) * 100))),
      ]);
      qx = x;
      qy = y;
      qt = t;
    }
    g.push([prevStart == null ? 0 : start - prevStart, out]);
    prevStart = start;
  }
  return g.length ? { m, k, g } : { m, k }; // « g » absent quand il n'y a aucun geste : jeton plus court
}

const isInt = (n) => Number.isInteger(n);

/** Inverse d'encodeRaw. Renvoie null si la structure est invalide (le serveur n'accorde aucune confiance au contenu). */
export function decodeRaw(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.m) || !Array.isArray(raw.k))
    return null;
  if (raw.m.length > RAW_LIMITS.mouse || raw.k.length > RAW_LIMITS.keys) return null;
  if (raw.g !== undefined && (!Array.isArray(raw.g) || raw.g.length > RAW_LIMITS.gestures))
    return null;

  const samples = [];
  let x = 0,
    y = 0,
    t = 0;
  for (const e of raw.m) {
    if (!Array.isArray(e) || e.length !== 3 || !e.every(isInt)) return null;
    const [dx, dy, dt] = e;
    if (dt < 0 || dt > RAW_LIMITS.maxDt) return null;
    x += dx;
    y += dy;
    t += dt;
    if (Math.abs(x) > RAW_LIMITS.coord || Math.abs(y) > RAW_LIMITS.coord) return null;
    samples.push({ x, y, t });
  }

  const keyEvents = [];
  t = 0;
  for (const e of raw.k) {
    if (!Array.isArray(e) || e.length !== 3 || !e.every(isInt)) return null;
    const [type, rank, dt] = e;
    if (
      (type !== 0 && type !== 1) ||
      rank < 0 ||
      rank > RAW_LIMITS.maxRank ||
      dt < 0 ||
      dt > RAW_LIMITS.maxDt
    )
      return null;
    t += dt;
    keyEvents.push({ type: type === 0 ? 'down' : 'up', code: rank, t });
  }
  const gestures = [];
  let start = 0;
  for (const entry of raw.g ?? []) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      !isInt(entry[0]) ||
      entry[0] < 0 ||
      entry[0] > RAW_LIMITS.maxDt
    )
      return null;
    const [gap, pts] = entry;
    if (!Array.isArray(pts) || pts.length < 1 || pts.length > RAW_LIMITS.gesturePts) return null;
    start += gap;
    let gx = 0,
      gy = 0,
      gt = start;
    const out = [];
    for (const q of pts) {
      if (!Array.isArray(q) || q.length !== 5 || !q.every(isInt)) return null;
      const [dx, dy, dt, r10, f100] = q;
      if (
        dt < 0 ||
        dt > RAW_LIMITS.maxDt ||
        r10 < 0 ||
        r10 > RAW_LIMITS.maxRadius ||
        f100 < 0 ||
        f100 > RAW_LIMITS.maxForce
      )
        return null;
      gx += dx;
      gy += dy;
      gt += dt;
      if (Math.abs(gx) > RAW_LIMITS.coord || Math.abs(gy) > RAW_LIMITS.coord) return null;
      out.push({ x: gx, y: gy, t: gt, r: r10 / 10, f: f100 / 100 });
    }
    gestures.push({ pts: out });
  }
  return { samples, keyEvents, gestures };
}

/**
 * Comportement analysé. `sim` remplace l'enregistrement réel (simulations de la démo).
 * Le résumé est calculé sur les données QUANTIFIÉES (celles que le serveur recevra), pas sur les flottants d'origine :
 * le serveur retrouve ainsi exactement les mêmes valeurs.
 */
export function behaviorOf(rec, sim = null) {
  const raw = encodeRaw({
    samples: sim?.mouse ?? rec.samples,
    keyEvents: sim?.keys ?? rec.keyEvents,
    gestures: sim?.gestures ?? rec.gestures ?? [],
  });
  const { samples, keyEvents, gestures } = decodeRaw(raw);
  return {
    samples,
    keyEvents,
    gestures,
    raw,
    mouse: analyzeMouse(samples),
    keys: analyzeKeys(keyEvents, !!rec.pasted && !sim),
    touch: analyzeTouch(gestures),
  };
}

/** Résumé complet : empreinte + comportement + interaction. */
export function buildSignals(fp, rec, b, { sim = null, overrides = {}, powSolved = false } = {}) {
  return {
    ...fp,
    ...overrides,
    mouse: summarizeMouse(b.mouse),
    keys: summarizeKeys(b.keys),
    touchInfo: summarizeTouch(b.touch),
    touch: rec.touch,
    untrustedEvents: rec.untrusted,
    powSolved,
    agent: sim?.agent ?? rec.agentStats(),
    timing: {
      focusToFirstKey: sim ? null : rec.focusToFirstKey,
      blurs: rec.blurs,
      scrolls: rec.scrolls,
      pageMs: Math.round(performance.now() - rec.loadT),
    },
  };
}
