// Générateur de trajectoires de souris et de rythmes de frappe « de type humain », reproductible (graine).
// Sert aux tests (jetons valides) et à l'attaquant du script redteam (qui lit le même code public et fabrique ses données).
import { behaviorOf, summarizeMouse, summarizeKeys, summarizeTouch } from '../docs/js/signals.js';

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @returns {{ samples, keyEvents, raw, mouse, keys }} : données brutes, représentation compacte `raw` du jeton
 * et résumés cohérents avec elle (ce que le serveur recalculera).
 */
export function makeTrace(seed = 1, { points = 130, keys = 26, width = 1100, height = 650 } = {}) {
  const rnd = prng(seed);

  // Souris : segments de Bézier vers des cibles aléatoires, accélération en cloche, bruit de main, pauses occasionnelles.
  const samples = [];
  let x = 80 + rnd() * 200,
    y = 120 + rnd() * 200,
    t = 1000 + rnd() * 500;
  const segments = 5,
    perSegment = Math.floor(points / segments);
  for (let s = 0; s < segments; s++) {
    const tx = 120 + rnd() * (width - 240),
      ty = 120 + rnd() * (height - 240);
    const cx = (x + tx) / 2 + (rnd() - 0.5) * 320,
      cy = (y + ty) / 2 + (rnd() - 0.5) * 320;
    for (let i = 1; i <= perSegment; i++) {
      const u = i / perSegment,
        e = u * u * (3 - 2 * u);
      t += 6 + rnd() * 14 + (rnd() < 0.05 ? 35 : 0);
      samples.push({
        x: (1 - e) ** 2 * x + 2 * (1 - e) * e * cx + e * e * tx + (rnd() - 0.5) * 1.8,
        y: (1 - e) ** 2 * y + 2 * (1 - e) * e * cy + e * e * ty + (rnd() - 0.5) * 1.8,
        t,
      });
    }
    x = tx;
    y = ty;
  }

  // Frappe : durée d'appui et délai entre touches irréguliers.
  const letters = 'ETAOINSHRDLU'.split('');
  const keyEvents = [];
  let kt = t + 900;
  for (let i = 0; i < keys; i++) {
    const code = `Key${letters[Math.floor(rnd() * letters.length)]}`;
    const up = kt + 55 + rnd() * 80;
    keyEvents.push({ type: 'down', code, t: kt }, { type: 'up', code, t: up });
    kt = up + 40 + rnd() * 160;
  }

  const b = behaviorOf({}, { mouse: samples, keys: keyEvents });
  return {
    samples,
    keyEvents,
    raw: b.raw,
    mouse: summarizeMouse(b.mouse),
    keys: summarizeKeys(b.keys),
  };
}

/** Rejeu « intelligent » : la même trajectoire avec un bruit de ±1 px et ±1 ms, pour échapper à la détection du rejeu exact. */
export function perturbTrace(trace, seed = 1) {
  const rnd = prng(seed);
  const samples = trace.samples.map((p) => ({
    x: p.x + (rnd() - 0.5) * 2,
    y: p.y + (rnd() - 0.5) * 2,
    t: p.t + (rnd() - 0.5) * 2,
  }));
  // le temps doit rester croissant
  for (let i = 1; i < samples.length; i++) samples[i].t = Math.max(samples[i].t, samples[i - 1].t);
  const b = behaviorOf({}, { mouse: samples, keys: trace.keyEvents });
  return {
    samples,
    keyEvents: trace.keyEvents,
    raw: b.raw,
    mouse: summarizeMouse(b.mouse),
    keys: summarizeKeys(b.keys),
  };
}

/**
 * Gestes tactiles de type humain : glissements courbes et bruités à vitesse variable, tapes de durée variable,
 * surface de contact et pression qui varient.
 */
export function makeGestures(seed = 1, { swipes = 3, taps = 6 } = {}) {
  const rnd = prng(seed);
  const gestures = [];
  let t = 500 + rnd() * 500;
  for (let s = 0; s < swipes; s++) {
    const x0 = 60 + rnd() * 200,
      y0 = 150 + rnd() * 300,
      dx = 80 + rnd() * 160,
      dy = (rnd() - 0.5) * 220,
      bend = (rnd() - 0.5) * 60;
    const n = 24 + Math.floor(rnd() * 12);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n,
        e = u * u * (3 - 2 * u);
      t += 9 + rnd() * 16;
      pts.push({
        x: x0 + dx * e + Math.sin(u * Math.PI) * bend + (rnd() - 0.5) * 1.4,
        y: y0 + dy * e + (rnd() - 0.5) * 1.4,
        t,
        r: 4 + rnd() * 5,
        f: 0.2 + rnd() * 0.5,
      });
    }
    gestures.push({ pts });
    t += 300 + rnd() * 500;
  }
  for (let i = 0; i < taps; i++) {
    const x = 80 + rnd() * 250,
      y = 200 + rnd() * 350,
      dur = 55 + rnd() * 90;
    gestures.push({
      pts: [
        { x, y, t, r: 5 + rnd() * 4, f: 0.3 + rnd() * 0.4 },
        {
          x: x + (rnd() - 0.5) * 2,
          y: y + (rnd() - 0.5) * 2,
          t: t + dur,
          r: 5 + rnd() * 4,
          f: 0.1 + rnd() * 0.3,
        },
      ],
    });
    t += 350 + rnd() * 700;
  }
  return gestures;
}

/** Trace complète d'un utilisateur mobile : pas de souris, des gestes tactiles, une frappe au clavier virtuel. */
export function makeTouchTrace(seed = 1, opts) {
  const base = makeTrace(seed, { points: 0, keys: 20 });
  const gestures = makeGestures(seed, opts);
  const b = behaviorOf({}, { mouse: [], keys: base.keyEvents, gestures });
  return {
    samples: [],
    keyEvents: base.keyEvents,
    gestures,
    raw: b.raw,
    mouse: summarizeMouse(b.mouse),
    keys: summarizeKeys(b.keys),
    touchInfo: summarizeTouch(b.touch),
  };
}
