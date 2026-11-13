// Règles de scoring pures, partagées entre le navigateur (démo / dashboard) et le serveur Express.
// Aucun texte ici : libellés, explications et détails sont traduits côté navigateur (js/i18n.js, clés rl.*, re.*, rd.*).
// Chaque règle reçoit le résumé de signaux `s` et renvoie null (non déclenchée) ou { f, p } :
//   f = fraction 0..1 du poids appliquée, p = paramètres du message de détail.

export const DEFAULT_THRESHOLD = 60;

const enoughMouse = (m) => m && m.n >= 15 && m.length >= 200;
const enoughKeys = (k) => k && k.count >= 5;
const hit = (p = {}, f = 1) => ({ f, p });
const touched = (t) => !!t && t.strokes + t.taps > 0; // de vrais gestes tactiles ont été observés
const fx = (n, d = 3) => Number(n).toFixed(d);

export const RULES = [
  // ── Automatisation ───────────────────────────────────────────────
  { id: 'webdriver', group: 'automation', weight: 50, test: (s) => (s.webdriver ? hit() : null) },
  {
    id: 'headless_ua',
    group: 'automation',
    weight: 40,
    test: (s) => (s.headlessUA ? hit({ ua: String(s.ua).slice(0, 60) }) : null),
  },
  {
    id: 'automation_globals',
    group: 'automation',
    weight: 30,
    test: (s) =>
      s.automationGlobals?.length ? hit({ list: s.automationGlobals.join(', ') }) : null,
  },
  {
    id: 'math_tampered',
    group: 'automation',
    weight: 25,
    test: (s) => (s.mathNative === false ? hit() : null),
  },
  {
    id: 'untrusted_events',
    group: 'automation',
    weight: 40,
    test: (s) => (s.untrustedEvents > 0 ? hit({ n: s.untrustedEvents }) : null),
  },

  // ── Matériel ─────────────────────────────────────────────────────
  {
    id: 'software_gpu',
    group: 'hardware',
    weight: 30,
    test: (s) => (s.softwareGpu ? hit({ renderer: s.gpuRenderer }) : null),
  },
  { id: 'no_webgl', group: 'hardware', weight: 10, test: (s) => (s.noWebgl ? hit() : null) },
  {
    id: 'canvas_blank',
    group: 'hardware',
    weight: 20,
    test: (s) => (s.canvasBlank ? hit() : null),
  },
  {
    id: 'low_cores',
    group: 'hardware',
    weight: 10,
    test: (s) => (s.cores != null && s.cores <= 1 ? hit({ n: s.cores }) : null),
  },
  {
    id: 'refresh_odd',
    group: 'hardware',
    weight: 5,
    test: (s) =>
      s.refreshHz != null && (s.refreshHz < 30 || s.refreshHz > 360)
        ? hit({ hz: s.refreshHz })
        : null,
  },

  // ── Cohérence ────────────────────────────────────────────────────
  {
    id: 'inconsistent_signals',
    group: 'coherence',
    weight: 30,
    test: (s) => {
      const n = s.inconsistencies?.length || 0;
      return n ? hit({ codes: s.inconsistencies }, Math.min(1, n / 3)) : null;
    },
  },
  {
    id: 'languages_empty',
    group: 'coherence',
    weight: 10,
    test: (s) => (s.languagesEmpty ? hit() : null),
  },
  {
    id: 'permissions_mismatch',
    group: 'coherence',
    weight: 15,
    test: (s) => (s.permissionsMismatch ? hit() : null),
  },
  { id: 'no_voices', group: 'coherence', weight: 5, test: (s) => (s.voices === 0 ? hit() : null) },

  // ── Comportement ─────────────────────────────────────────────────
  // Levée uniquement par de vrais gestes tactiles : le simple drapeau « touch » est déclaratif et ne prouve rien.
  {
    id: 'mouse_none',
    group: 'behavior',
    weight: 10,
    test: (s) => (s.mouse && s.mouse.n < 3 && !touched(s.touchInfo) ? hit() : null),
  },
  {
    id: 'mouse_linear',
    group: 'behavior',
    weight: 25,
    test: (s) =>
      enoughMouse(s.mouse) && s.mouse.linearity > 0.985 ? hit({ v: fx(s.mouse.linearity) }) : null,
  },
  {
    id: 'mouse_no_jitter',
    group: 'behavior',
    weight: 15,
    test: (s) =>
      enoughMouse(s.mouse) && s.mouse.jitter < 0.05 ? hit({ v: fx(s.mouse.jitter) }) : null,
  },
  {
    id: 'mouse_constant_speed',
    group: 'behavior',
    weight: 10,
    test: (s) =>
      enoughMouse(s.mouse) && s.mouse.speedCV < 0.08 ? hit({ v: fx(s.mouse.speedCV) }) : null,
  },
  {
    id: 'mouse_regular_timing',
    group: 'behavior',
    weight: 10,
    test: (s) =>
      enoughMouse(s.mouse) && s.mouse.intervalCV < 0.03 ? hit({ v: fx(s.mouse.intervalCV) }) : null,
  },
  {
    id: 'touch_linear',
    group: 'behavior',
    weight: 20,
    test: (s) =>
      s.touchInfo?.measurable >= 2 && s.touchInfo.linearity > 0.985 && s.touchInfo.jitter < 0.05
        ? hit({ lin: fx(s.touchInfo.linearity), jit: fx(s.touchInfo.jitter) })
        : null,
  },
  {
    id: 'touch_uniform_taps',
    group: 'behavior',
    weight: 15,
    test: (s) =>
      s.touchInfo?.taps >= 4 && s.touchInfo.tapCV < 0.08
        ? hit({ n: s.touchInfo.taps, cv: fx(s.touchInfo.tapCV) })
        : null,
  },
  // Un doigt reste au moins quelques dizaines de millisecondes sur l'écran à chaque tape : des tapes quasi instantanées sont injectées.
  {
    id: 'touch_instant_taps',
    group: 'behavior',
    weight: 15,
    test: (s) =>
      s.touchInfo?.taps >= 3 && s.touchInfo.tapMean < 20
        ? hit({ n: s.touchInfo.taps, ms: s.touchInfo.tapMean })
        : null,
  },
  // Poids faible : à vérifier sur de vrais appareils avant de l'augmenter (certains rapportent un rayon constant).
  {
    id: 'touch_no_contact_area',
    group: 'behavior',
    weight: 5,
    test: (s) =>
      s.touchInfo?.points >= 10 && s.touchInfo.radiusDistinct <= 1
        ? hit({ n: s.touchInfo.points })
        : null,
  },
  {
    id: 'keys_regular',
    group: 'behavior',
    weight: 20,
    test: (s) =>
      enoughKeys(s.keys) && s.keys.dwellCV < 0.08 && s.keys.flightCV < 0.08
        ? hit({ dwell: fx(s.keys.dwellCV), flight: fx(s.keys.flightCV) })
        : null,
  },
  {
    id: 'keys_superhuman',
    group: 'behavior',
    weight: 15,
    test: (s) =>
      enoughKeys(s.keys) && s.keys.downMean > 0 && s.keys.downMean < 25
        ? hit({ v: fx(s.keys.downMean, 1) })
        : null,
  },
  {
    id: 'keys_pasted',
    group: 'behavior',
    weight: 10,
    test: (s) => (s.keys?.pasted ? hit() : null),
  },
  {
    id: 'instant_typing',
    group: 'behavior',
    weight: 10,
    test: (s) =>
      s.timing?.focusToFirstKey != null && s.timing.focusToFirstKey < 30
        ? hit({ ms: s.timing.focusToFirstKey })
        : null,
  },

  // ── Agent IA ─────────────────────────────────────────────────────
  {
    id: 'mouse_teleport',
    group: 'agent',
    weight: 25,
    test: (s) =>
      s.agent?.clicks >= 2 && s.agent.teleports / s.agent.clicks >= 0.5
        ? hit({ n: s.agent.teleports, c: s.agent.clicks })
        : null,
  },
  {
    id: 'centered_clicks',
    group: 'agent',
    weight: 15,
    test: (s) =>
      s.agent?.clicks >= 2 && s.agent.centered / s.agent.clicks >= 0.8
        ? hit({ n: s.agent.centered, c: s.agent.clicks })
        : null,
  },
  {
    id: 'injected_text',
    group: 'agent',
    weight: 20,
    test: (s) => (s.agent?.injected >= 3 ? hit({ n: s.agent.injected }) : null),
  },

  // ── Preuve de travail ────────────────────────────────────────────
  { id: 'pow_missing', group: 'pow', weight: 20, test: (s) => (!s.powSolved ? hit() : null) },
];

/** Évalue les signaux et renvoie le score (0..100) avec le détail de chaque règle. */
export function evaluate(signals, weights = {}) {
  let total = 0;
  const items = RULES.map((rule) => {
    const weight = weights[rule.id] ?? rule.weight;
    const r = rule.test(signals || {});
    const malus = r ? Math.round(weight * r.f * 10) / 10 : 0;
    total += malus;
    return { id: rule.id, group: rule.group, weight, hit: !!r, malus, params: r?.p || {} };
  });
  return { score: Math.max(0, Math.round(100 - total)), items };
}

/** Renvoie la clé du verdict (human | suspect | bot) ; le libellé est traduit côté navigateur (v.*). */
export function verdict(score, threshold = DEFAULT_THRESHOLD) {
  if (score >= Math.max(threshold + 20, 80)) return { key: 'human' };
  if (score >= threshold) return { key: 'suspect' };
  return { key: 'bot' };
}
