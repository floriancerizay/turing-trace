// Analyse comportementale : souris et dynamique de frappe.
// Les analyseurs sont des fonctions pures (testables, réutilisées par les simulations de bot).

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const std = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};
const cv = (a) => {
  const m = mean(a);
  return m > 0 ? std(a) / m : 0;
};

/** samples : [{x, y, t}] (t en ms). */
export function analyzeMouse(samples) {
  const n = samples.length;
  if (n < 2)
    return { n, length: 0, linearity: 0, jitter: 0, speedCV: 0, intervalCV: 0, maxSpeed: 0 };

  let length = 0;
  const speeds = [];
  const intervals = [];
  for (let i = 1; i < n; i++) {
    const dx = samples[i].x - samples[i - 1].x;
    const dy = samples[i].y - samples[i - 1].y;
    const dt = Math.max(1, samples[i].t - samples[i - 1].t);
    const d = Math.hypot(dx, dy);
    length += d;
    speeds.push(d / dt);
    intervals.push(dt);
  }
  const direct = Math.hypot(samples[n - 1].x - samples[0].x, samples[n - 1].y - samples[0].y);

  // Jitter : écart moyen (px) des points à la corde de leur fenêtre glissante de 8 points.
  const devs = [];
  for (let i = 0; i + 8 <= n; i += 4) {
    const a = samples[i];
    const b = samples[i + 7];
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    if (chord < 5) continue;
    for (let k = 1; k < 7; k++) {
      const p = samples[i + k];
      devs.push(Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / chord);
    }
  }

  return {
    n,
    length,
    linearity: length > 0 ? direct / length : 0,
    jitter: mean(devs),
    speedCV: cv(speeds),
    intervalCV: cv(intervals),
    maxSpeed: Math.max(...speeds),
  };
}

/** events : [{type: 'down' | 'up', code, t}]. Calcule dwell (appui→relâche) et flight (relâche→appui suivant). */
export function analyzeKeys(events, pasted = false) {
  const downAt = new Map();
  const dwells = [];
  const flights = [];
  const downGaps = []; // intervalle entre deux appuis successifs : robuste au chevauchement de touches
  let lastUp = null;
  let lastDown = null;
  let count = 0;
  for (const e of events) {
    if (e.type === 'down') {
      if (!downAt.has(e.code)) {
        downAt.set(e.code, e.t);
        count++;
        if (lastDown != null) downGaps.push(e.t - lastDown);
        lastDown = e.t;
      }
      if (lastUp != null) flights.push(e.t - lastUp);
    } else if (downAt.has(e.code)) {
      dwells.push(e.t - downAt.get(e.code));
      downAt.delete(e.code);
      lastUp = e.t;
    }
  }
  return {
    count,
    pasted,
    dwellMean: mean(dwells),
    dwellCV: cv(dwells),
    flightMean: mean(flights),
    flightCV: cv(flights),
    downMean: mean(downGaps),
    dwells,
    flights,
  };
}

const TAP_MAX_MS = 500;
const TAP_MAX_MOVE_PX = 10;

/**
 * Analyse des gestes tactiles. Un geste court et quasi immobile est une « tape », sinon un glissement.
 * @param gestures [{ pts: [{ x, y, t, r, f }] }]
 */
export function analyzeTouch(gestures = []) {
  const strokes = [];
  const taps = [];
  let points = 0;
  const radii = new Set();
  for (const g of gestures) {
    const p = g.pts;
    if (!p?.length) continue;
    points += p.length;
    for (const q of p) radii.add(Math.round(q.r * 10));
    const dur = p[p.length - 1].t - p[0].t;
    const move = Math.hypot(p[p.length - 1].x - p[0].x, p[p.length - 1].y - p[0].y);
    if (dur < TAP_MAX_MS && move < TAP_MAX_MOVE_PX) taps.push(dur);
    else strokes.push(p);
  }

  // Glissements mesurables : assez de points et de longueur pour que linéarité et tremblement aient un sens.
  const measured = strokes
    .map((p) => (p.length >= 8 ? analyzeMouse(p) : null))
    .filter((m) => m && m.length >= 60);
  return {
    strokes: strokes.length,
    taps: taps.length,
    measurable: measured.length,
    linearity: mean(measured.map((m) => m.linearity)),
    jitter: mean(measured.map((m) => m.jitter)),
    speedCV: mean(measured.map((m) => m.speedCV)),
    tapMean: mean(taps),
    tapCV: cv(taps),
    points,
    radiusDistinct: radii.size,
  };
}

/** Écoute le navigateur et accumule les données brutes. */
export class Recorder {
  /** `root` : champ ou conteneur (formulaire) dont on écoute la frappe ; la souris est suivie sur tout le document. */
  constructor(root) {
    this.samples = [];
    this.keyEvents = [];
    this.pasted = false;
    this.touch = false;
    // Gestes tactiles : { pts: [{ x, y, t, r (rayon de contact en px), f (pression 0..1) }] }, un par doigt posé puis levé.
    this.gestures = [];
    this.openGesture = null;
    this.untrusted = 0;
    this.version = 0;
    // Signaux d'attention : délai focus → première frappe, pertes de focus, défilement.
    this.focusT = null;
    this.focusToFirstKey = null;
    this.blurs = 0;
    this.scrolls = 0;
    this.loadT = performance.now();
    // Signaux « agent IA » : clics sans trajectoire d'approche, clics au centre exact, texte inséré sans frappe.
    this.clicks = 0;
    this.teleports = 0;
    this.centered = 0;
    this.injected = 0;
    this.lastKeyT = -1e9;
    this.lastLen = new WeakMap();
    document.addEventListener(
      'pointerdown',
      (e) => {
        track(e);
        if (e.pointerType && e.pointerType !== 'mouse') return;
        this.clicks++;
        const now = performance.now();
        const approach = this.samples.filter((p) => now - p.t < 400).length;
        const prev = this.samples.length >= 2 ? this.samples[this.samples.length - 2] : null;
        const jump = prev ? Math.hypot(e.clientX - prev.x, e.clientY - prev.y) : Infinity;
        if (approach < 3 && jump > 60) this.teleports++;
        const r = e.target?.getBoundingClientRect?.();
        if (
          r &&
          r.width > 4 &&
          Math.abs(e.clientX - (r.left + r.width / 2)) <= 1 &&
          Math.abs(e.clientY - (r.top + r.height / 2)) <= 1
        )
          this.centered++;
        this.version++;
      },
      true,
    );
    root.addEventListener('input', (e) => {
      const len = String(e.target.value ?? '').length;
      const added = Math.max(0, len - (this.lastLen.get(e.target) ?? 0));
      this.lastLen.set(e.target, len);
      // Collage, glisser-déposer et suggestions du clavier mobile sont légitimes ; une saisie sans touche ne l'est pas.
      if (['insertFromPaste', 'insertFromDrop', 'insertReplacementText'].includes(e.inputType))
        return;
      if (added > 0 && performance.now() - this.lastKeyT > 150) {
        this.injected += added;
        this.version++;
      }
    });
    window.addEventListener('blur', () => {
      this.blurs++;
      this.version++;
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.blurs++;
        this.version++;
      }
    });
    window.addEventListener(
      'scroll',
      () => {
        this.scrolls++;
        this.version++;
      },
      { passive: true },
    );
    root.addEventListener('focusin', () => {
      this.focusT = performance.now();
    });

    const track = (e) => {
      if (!e.isTrusted) this.untrusted++;
    };
    document.addEventListener(
      'mousemove',
      (e) => {
        track(e);
        this.samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
        if (this.samples.length > 1500) this.samples.shift();
        this.version++;
      },
      { passive: true },
    );
    const touchPoint = (e) => {
      const c = e.changedTouches[0];
      return {
        x: c.clientX,
        y: c.clientY,
        t: performance.now(),
        r: c.radiusX ?? 0,
        f: c.force ?? 0,
      };
    };
    document.addEventListener(
      'touchstart',
      (e) => {
        track(e);
        this.touch = true;
        this.openGesture = { pts: [touchPoint(e)] }; // premier doigt uniquement
        this.version++;
      },
      { passive: true },
    );
    document.addEventListener(
      'touchmove',
      (e) => {
        track(e);
        if (this.openGesture && this.openGesture.pts.length < 400)
          this.openGesture.pts.push(touchPoint(e));
        this.version++;
      },
      { passive: true },
    );
    const endTouch = (e) => {
      track(e);
      if (this.openGesture) {
        this.openGesture.pts.push(touchPoint(e));
        this.gestures.push(this.openGesture);
        if (this.gestures.length > 60) this.gestures.shift();
        this.openGesture = null;
      }
      this.version++;
    };
    document.addEventListener('touchend', endTouch, { passive: true });
    document.addEventListener('touchcancel', endTouch, { passive: true });
    root.addEventListener('keydown', (e) => {
      track(e);
      this.lastKeyT = performance.now();
      if (this.focusToFirstKey == null && this.focusT != null)
        this.focusToFirstKey = Math.round(performance.now() - this.focusT);
      if (!e.repeat) this.keyEvents.push({ type: 'down', code: e.code, t: performance.now() });
      this.version++;
    });
    root.addEventListener('keyup', (e) => {
      track(e);
      this.keyEvents.push({ type: 'up', code: e.code, t: performance.now() });
      this.version++;
    });
    root.addEventListener('paste', () => {
      this.pasted = true;
      this.version++;
    });
  }

  agentStats() {
    return {
      clicks: this.clicks,
      teleports: this.teleports,
      centered: this.centered,
      injected: this.injected,
    };
  }

  /** À appeler après une vérification réussie : le prochain jeton ne doit pas réutiliser la même trajectoire (anti-rejeu). */
  clearBehavior() {
    this.samples = [];
    this.keyEvents = [];
    this.pasted = false;
    this.gestures = [];
    this.version++;
  }

  reset() {
    this.samples = [];
    this.keyEvents = [];
    this.pasted = false;
    this.untrusted = 0;
    this.gestures = [];
    this.openGesture = null;
    this.focusToFirstKey = null;
    this.focusT = null;
    this.clicks = 0;
    this.teleports = 0;
    this.centered = 0;
    this.injected = 0;
    this.lastLen = new WeakMap();
    this.version++;
  }
}

// ── Simulations pédagogiques (données synthétiques, aucun événement n'est envoyé à un tiers) ──

/** Trajectoire de « bot » : ligne droite parfaite à vitesse constante, cadence de 8 ms exacte. */
export function simulateBotMouse(x0 = 40, y0 = 60, x1 = 520, y1 = 240, steps = 60) {
  const t0 = performance.now();
  return Array.from({ length: steps + 1 }, (_, i) => ({
    x: x0 + ((x1 - x0) * i) / steps,
    y: y0 + ((y1 - y0) * i) / steps,
    t: t0 + i * 8,
  }));
}

/** Frappe de « bot » : 14 touches, dwell = 50 ms et flight = 100 ms exactement. */
export function simulateBotKeys(n = 14) {
  const ev = [];
  let t = performance.now();
  for (let i = 0; i < n; i++) {
    ev.push({ type: 'down', code: `Key${i}`, t });
    ev.push({ type: 'up', code: `Key${i}`, t: t + 50 });
    t += 150;
  }
  return ev;
}

/**
 * Agent IA de navigateur (type « computer use » ou Playwright click/fill) : le curseur apparaît directement au centre
 * des cibles, sans trajectoire ; le texte est inséré d'un bloc, sans frappe ; de longues pauses de « réflexion ».
 */
export function simulateAgent() {
  const t0 = performance.now();
  const targets = [
    [180, 140],
    [520, 300],
    [300, 420],
    [640, 520],
  ];
  return {
    mouse: targets.map(([x, y], i) => ({ x, y, t: t0 + i * 2800 })),
    keys: [],
    agent: { clicks: 4, teleports: 4, centered: 4, injected: 38 },
  };
}

/** Glissements parfaitement droits à vitesse constante et tapes de durée identique, sans surface de contact. */
export function simulateBotTouch() {
  const t0 = performance.now();
  const gestures = [];
  for (let i = 0; i < 3; i++) {
    gestures.push({
      pts: Array.from({ length: 20 }, (_, k) => ({
        x: 60 + k * 14,
        y: 200 + i * 90 + k * 6,
        t: t0 + i * 700 + k * 16,
        r: 0,
        f: 0,
      })),
    });
  }
  for (let i = 0; i < 5; i++) {
    const t = t0 + 3000 + i * 400;
    gestures.push({
      pts: [
        { x: 120 + i * 30, y: 300, t, r: 0, f: 0 },
        { x: 120 + i * 30, y: 300, t: t + 80, r: 0, f: 0 },
      ],
    });
  }
  return gestures;
}
