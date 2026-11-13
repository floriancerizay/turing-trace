import { RULES, evaluate, verdict, DEFAULT_THRESHOLD } from './scoring.js';
import { collectFingerprint, fetchPublicIP } from './fingerprint.js';
import {
  Recorder,
  analyzeMouse,
  analyzeKeys,
  simulateBotMouse,
  simulateBotKeys,
  simulateBotTouch,
  simulateAgent,
} from './behavior.js';
import { getChallenge, solvePow, buildToken, demoDeps, resolveStepUp } from './token.js';
import { verifyToken, decodeToken, encodeToken, LIMITS } from './verify.js';
import { t, getLang, setLang, applyI18n } from './i18n.js';
import { behaviorOf, buildSignals as buildSignalsFrom, summarizeTouch } from './signals.js';

const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const params = new URLSearchParams(location.search);
let mode = params.get('mode') || (location.hostname.endsWith('github.io') ? 'demo' : 'server');

const state = {
  fp: null,
  info: null,
  ip: null,
  sim: null, // { mouse, keys } : session de bot synthétique
  overrides: {}, // signaux forcés (simulation headless)
  weights: {},
  threshold: DEFAULT_THRESHOLD,
  challenge: null,
  pow: null,
  powAttempts: 0,
  token: null,
  payload: null,
  lastForm: null,
  lastResult: null,
  ipStatus: 'ip.note',
};
const rec = new Recorder($('#typing'));
const demo = demoDeps(DEFAULT_THRESHOLD, state.weights);
let lastRulesKey = '',
  lastInfoKey = '',
  lastVersion = -1,
  dirty = true;

// ── Signaux ────────────────────────────────────────────────────────────────
function currentBehavior() {
  return behaviorOf(rec, state.sim);
}

function buildSignals(b, powSolved = !!state.pow) {
  return buildSignalsFrom(state.fp, rec, b, {
    sim: state.sim,
    overrides: state.overrides,
    powSolved,
  });
}

// Textes dérivés des paramètres neutres produits par scoring.js / verify.js
const incText = (code) => {
  const [k, a, b] = code.split('|');
  return t('inc.' + k, { a, b });
};
const ruleDetail = (it) => {
  const p = { ...it.params };
  if (p.codes) p.list = p.codes.map(incText).join(' · ');
  return t('rd.' + it.id, p);
};
const verdictLabel = (v) => t('v.' + v.key);

// ── Défi + preuve de travail ───────────────────────────────────────────────
async function newChallenge() {
  state.pow = null;
  state.powAttempts = 0;
  try {
    state.challenge = await getChallenge(mode);
  } catch {
    if (mode === 'server') {
      mode = 'demo';
      renderMode();
    }
    state.challenge = await getChallenge('demo');
  }
  const ch = state.challenge;
  const t0 = performance.now();
  state.powPromise = solvePow(ch.nonce, ch.bits, (n) => {
    state.powAttempts = n;
    dirty = true;
  }).then((p) => {
    if (state.challenge !== ch) return null;
    state.pow = p;
    state.powMs = Math.round(performance.now() - t0);
    dirty = true;
    return p;
  });
  dirty = true;
}

// ── Rendu ──────────────────────────────────────────────────────────────────
function renderMode() {
  const b = $('#modeBadge');
  b.textContent = t(mode === 'server' ? 'mode.server' : 'mode.demo');
  $('#modeNote').textContent = t(mode === 'server' ? 'note.server' : 'note.demo');
}

function renderGauge(res) {
  const v = verdict(res.score, state.threshold);
  const label = verdictLabel(v);
  const g = $('#gauge');
  g.value = res.score;
  g.className = v.key;
  $('#gaugeVal').textContent = res.score;
  for (const id of ['#verdict', '#barVerdict', '#labVerdict']) {
    const el = $(id);
    el.textContent = label;
    el.className = 'verdict ' + v.key;
  }
  $('#barScore').textContent = res.score;
  $('#barScore').className = v.key; // coloré selon le verdict (le libellé est masqué sur petit écran)
  $('#labScore').textContent = res.score;
  $('#thrVal').textContent = state.threshold;
}

function renderRules(res) {
  const key = JSON.stringify([
    getLang(),
    res.items.map((i) => [i.id, i.malus, i.params, i.weight]),
  ]);
  if (key === lastRulesKey) return;
  lastRulesKey = key;
  let group = '',
    html = '';
  for (const it of res.items) {
    if (it.group !== group) {
      group = it.group;
      html += `<div class="grp">${esc(t('g.' + group))}</div>`;
    }
    html += `<details class="${it.hit ? 'hit' : ''}"><summary>
      <span class="sr">${esc(t(it.hit ? 'st.hit' : 'st.clear'))} :</span>
      <span class="name">${esc(t('rl.' + it.id))} <span class="det">${it.hit ? esc(ruleDetail(it)) : ''}</span></span>
      <span class="pts">${it.hit ? '−' + it.malus : '0'} / ${it.weight}</span></summary>
      <p>${esc(t('re.' + it.id))}</p></details>`;
  }
  $('#rules').innerHTML = html;
}

function tile(title, rows) {
  return `<div class="tile"><h3>${esc(title)}</h3><dl>${rows
    .map(([k, v, bad]) => `<dt>${esc(k)}</dt><dd class="${bad ? 'flag-bad' : ''}">${v}</dd>`)
    .join('')}</dl></div>`;
}

function renderInfo(b) {
  const s = state.fp,
    i = state.info;
  if (!s) return;
  const ag = state.sim?.agent ?? rec.agentStats();
  const touch = summarizeTouch(b.touch);
  const key = JSON.stringify([
    getLang(),
    s,
    i.fontList,
    state.ip,
    state.overrides,
    rec.focusToFirstKey,
    rec.blurs,
    rec.scrolls,
    ag,
    touch,
  ]);
  if (key === lastInfoKey) return;
  lastInfoKey = key;
  const s2 = { ...s, ...state.overrides };
  const yn = (b) => t(b ? 'yes' : 'no');
  $('#info').innerHTML = [
    tile(t('t.system'), [
      [t('i.os'), esc(i.os)],
      [t('i.browser'), esc(i.browser)],
      [t('i.platform'), esc(i.platform)],
      [t('i.langs'), esc(i.languages)],
      [t('i.tz'), esc(i.timezone)],
      [t('i.screen'), esc(i.screen)],
      [t('i.ip'), state.ip ? esc(state.ip) : `<span class="muted">${esc(t('ip.none'))}</span>`],
    ]),
    tile(t('t.gpu'), [
      [t('i.renderer'), esc(s2.gpuRenderer || t('unavailable')), s2.softwareGpu || s2.noWebgl],
      [t('i.vendor'), esc(i.gpuVendor || '–')],
      [t('i.swgpu'), s2.softwareGpu ? t('i.swgpu.yes') : t('no'), s2.softwareGpu],
    ]),
    tile(t('t.hw'), [
      [t('i.cores'), esc(s2.cores ?? t('na')), s2.cores != null && s2.cores <= 1],
      [t('i.mem'), s2.memory != null ? esc(s2.memory) + ' GB' : t('i.mem.na')],
      [t('i.hz'), s2.refreshHz ? esc(s2.refreshHz) + ' Hz' : t('na')],
      [t('i.touch'), esc(i.touchPoints)],
    ]),
    tile(t('t.fp'), [
      [
        t('i.canvas'),
        `<code>${esc(s.canvasHash || t('na'))}</code>` +
          (i.canvasUrl ? `<br><img alt="${esc(t('i.canvas.alt'))}" src="${i.canvasUrl}">` : ''),
        s.canvasBlank,
      ],
      [t('i.audio'), `<code>${esc(s.audioHash || t('na'))}</code>`],
      [t('i.fonts'), `${s.fonts} / 24`],
    ]),
    tile(t('t.auto'), [
      [t('i.webdriver'), String(!!s2.webdriver), s2.webdriver],
      [t('i.headless'), yn(s2.headlessUA), s2.headlessUA],
      [t('i.math'), s2.mathNative ? t('yes') : t('no').toUpperCase(), !s2.mathNative],
      [
        t('i.globals'),
        esc(s2.automationGlobals.join(', ') || t('none')),
        s2.automationGlobals.length,
      ],
      [
        t('i.incons'),
        esc(s2.inconsistencies.map(incText).join(' · ') || t('none')),
        s2.inconsistencies.length,
      ],
    ]),
    tile(t('t.attn'), [
      [t('i.focus'), rec.focusToFirstKey != null ? rec.focusToFirstKey + ' ms' : t('notYet')],
      [t('i.blurs'), esc(rec.blurs)],
      [t('i.scrolls'), esc(rec.scrolls)],
      [
        t('i.clicks'),
        `${ag.clicks} (${ag.teleports} / ${ag.centered})`,
        ag.clicks >= 2 && ag.teleports / ag.clicks >= 0.5,
      ],
      [t('i.injected'), esc(ag.injected), ag.injected >= 3],
      [t('i.gestures'), `${touch.strokes} / ${touch.taps}`],
    ]),
    tile(
      t('t.uach'),
      i.uach
        ? [
            [
              t('i.uach.platform'),
              esc(i.uach.platform),
              s2.inconsistencies.some((c) => c.startsWith('uach_platform')),
            ],
            [t('i.uach.version'), esc(i.uach.platformVersion || t('na'))],
            [
              t('i.uach.arch'),
              esc(
                [i.uach.architecture, i.uach.bitness && i.uach.bitness + ' bit']
                  .filter(Boolean)
                  .join(' · ') || t('na'),
              ),
            ],
            [t('i.uach.model'), esc(i.uach.model || '–')],
            [t('i.uach.brands'), esc(i.uach.brands.join(', ') || t('na'))],
          ]
        : [[t('i.uach.platform'), t('i.uach.none')]],
    ),
    tile(t('t.prefs'), [
      [t('i.scheme'), t('val.' + i.prefs.scheme)],
      [t('i.motion'), yn(i.prefs.reducedMotion)],
      [t('i.contrast'), t('val.' + i.prefs.contrast)],
      [t('i.forced'), yn(i.prefs.forcedColors)],
      [t('i.gamut'), esc(i.prefs.gamut || t('na'))],
      [t('i.hdr'), yn(i.prefs.hdr)],
      [t('i.pointer'), t('val.' + i.prefs.pointer)],
      [t('i.orientation'), esc(i.prefs.orientation || t('na'))],
    ]),
    tile(
      t('t.net'),
      i.conn
        ? [
            [t('i.conn.type'), esc(i.conn.type)],
            [t('i.conn.rtt'), esc(i.conn.rtt) + ' ms'],
            [t('i.conn.down'), esc(i.conn.downlink) + ' Mb/s'],
            [t('i.conn.save'), yn(i.conn.saveData)],
          ]
        : [[t('i.conn.type'), t('i.conn.none')]],
    ),
    tile(t('t.media'), [
      [t('i.devices'), i.devices ? t('i.devices.fmt', i.devices) : t('na')],
      [t('i.keyboard'), esc(i.layout || t('na'))],
      [
        t('i.codecs'),
        esc(i.codecs.join(', ') || t('none')),
        s2.inconsistencies.includes('chrome_no_h264'),
      ],
      [t('i.gamepads'), esc(i.gamepads ?? t('na'))],
      [t('i.voices'), esc(i.voices ?? t('na')), i.voices === 0],
    ]),
    tile(t('t.store'), [
      [t('i.quota'), i.storage ? esc(i.storage.quotaGB) + ' GB' : t('na')],
      [
        t('i.private'),
        i.storage
          ? t(i.storage.privateLikely ? 'i.private.likely' : 'i.private.unlikely')
          : t('na'),
      ],
      [t('i.webgpu'), esc(i.webgpu || t('unavailable'))],
      [
        t('i.perms'),
        i.perms?.api ? `${esc(i.perms.perm)} / ${esc(i.perms.api)}` : t('na'),
        s2.permissionsMismatch,
      ],
    ]),
  ].join('');
}

function colorBySpeed(v) {
  return `hsl(${Math.round(240 - 240 * Math.min(1, v / 2.5))} 80% 50%)`;
}

/** Trace une ou plusieurs trajectoires (souris, ou un chemin par geste tactile) à la même échelle ; couleur = vitesse. */
function drawPaths(cv, paths, msg) {
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = css('--muted');
  ctx.font = '14px system-ui';
  ctx.textAlign = 'center';
  const all = paths.flat();
  if (all.length < 2) {
    ctx.fillText(msg || t('mouse.empty'), cv.width / 2, cv.height / 2);
    return;
  }
  const xs = all.map((p) => p.x),
    ys = all.map((p) => p.y);
  const x0 = Math.min(...xs),
    y0 = Math.min(...ys);
  const w = Math.max(1, Math.max(...xs) - x0),
    h = Math.max(1, Math.max(...ys) - y0);
  const pad = 14,
    k = Math.min((cv.width - 2 * pad) / w, (cv.height - 2 * pad) / h);
  const px = (p) => [pad + (p.x - x0) * k, pad + (p.y - y0) * k];
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (const samples of paths) {
    for (let i = 1; i < samples.length; i++) {
      const [ax, ay] = px(samples[i - 1]),
        [bx, by] = px(samples[i]);
      const sp =
        Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y) /
        Math.max(1, samples[i].t - samples[i - 1].t);
      ctx.strokeStyle = colorBySpeed(sp);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
  }
}

function drawHistogram(cv, dwells, flights) {
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = css('--muted');
  ctx.font = '14px system-ui';
  ctx.textAlign = 'center';
  if (dwells.length < 2) {
    ctx.fillText(t('keys.empty'), cv.width / 2, cv.height / 2);
    return;
  }
  const max = 400,
    bins = 20,
    bw = cv.width / bins,
    hist = (a) => {
      const h = new Array(bins).fill(0);
      a.forEach((v) => {
        if (v >= 0) h[Math.min(bins - 1, Math.floor((v / max) * bins))]++;
      });
      return h;
    };
  const hd = hist(dwells),
    hf = hist(flights),
    top = Math.max(1, ...hd, ...hf);
  [
    [hd, '--c-dwell'],
    [hf, '--c-flight'],
  ].forEach(([h, c], idx) => {
    ctx.fillStyle = css(c);
    ctx.globalAlpha = 0.75;
    h.forEach((n, i) => {
      const bh = (n / top) * (cv.height - 24);
      ctx.fillRect(i * bw + idx * (bw / 2), cv.height - 16 - bh, bw / 2 - 1, bh);
    });
  });
  ctx.globalAlpha = 1;
  ctx.fillStyle = css('--muted');
  ctx.textAlign = 'left';
  ctx.fillText('0 ms', 2, cv.height - 2);
  ctx.textAlign = 'right';
  ctx.fillText(`${max} ms`, cv.width - 2, cv.height - 2);
}

function renderBehavior(b) {
  // Sans mouvement de souris (mobile), on trace les glissements tactiles.
  const swipes = b.gestures.map((g) => g.pts).filter((p) => p.length >= 2);
  // Les navigateurs mobiles émettent quelques mouvements de souris après chaque tape : trop peu pour être une trajectoire.
  const mousePath = b.samples.length >= 8 ? [b.samples] : [];
  drawPaths(
    $('#mouseCv'),
    mousePath.length || swipes.length ? [...mousePath, ...swipes] : [b.samples],
  );
  drawHistogram($('#keyCv'), b.keys.dwells, b.keys.flights);
  const m = b.mouse,
    k = b.keys;
  const tc = b.touch;
  $('#mouseStats').textContent = [
    m.n > 1 && (m.n >= 8 || tc.strokes + tc.taps === 0)
      ? t('mouse.stats', {
          n: m.n,
          lin: m.linearity.toFixed(3),
          jit: m.jitter.toFixed(2),
          cv: m.speedCV.toFixed(2),
        })
      : '',
    tc.strokes + tc.taps > 0 ? t('touch.stats', { s: tc.strokes, t: tc.taps }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  $('#keyStats').textContent =
    k.count > 1
      ? t('keys.stats', {
          n: k.count,
          dw: Math.round(k.dwellMean),
          dcv: k.dwellCV.toFixed(2),
          fl: Math.round(k.flightMean),
          fcv: k.flightCV.toFixed(2),
        })
      : '';
}

function renderToken(score, signals, raw) {
  if (!state.challenge) return;
  const { payload, token } = buildToken(state.challenge, state.pow, score, signals, raw);
  state.payload = payload;
  state.token = token;
  $('#cf_token').value = token;
  // Les données brutes occupent l'essentiel du jeton : résumées à l'affichage.
  const rawView = payload.raw
    ? { mouse: `[${payload.raw.m.length} points]`, keys: `[${payload.raw.k.length} events]` }
    : null;
  $('#tokenJson').textContent = JSON.stringify(
    {
      ...payload,
      raw: rawView,
      signals: { ...signals, ua: String(signals.ua).slice(0, 48) + '…' },
    },
    null,
    2,
  );
  $('#tokenSizeLine').textContent = t('token.size', { n: token.length });
  $('#powStatus').textContent = state.pow
    ? t('pow.done', { n: state.pow.attempts, ms: state.powMs })
    : t('pow.running', { n: state.powAttempts });
}

function render() {
  if (!state.fp) return;
  const b = currentBehavior();
  const signals = buildSignals(b);
  const res = evaluate(signals, state.weights);
  renderGauge(res);
  renderRules(res);
  renderInfo(b);
  renderBehavior(b);
  renderToken(res.score, signals, b.raw);
  $('#simNote').textContent = state.sim || Object.keys(state.overrides).length ? t('sim.note') : '';
}

// ── Vérification / formulaire ──────────────────────────────────────────────
async function verify(form) {
  if (mode === 'server') {
    const r = await fetch('api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (r.status === 429)
      return { ok: false, steps: [{ id: 'rate', ok: false, d: 'limit', p: {} }] };
    return r.json();
  }
  demo.minScore = state.threshold;
  demo.weights = state.weights;
  return verifyToken(form, demo);
}

function showResult(res) {
  state.lastResult = res;
  if (!res) {
    $('#result').innerHTML = '';
    return;
  }
  const codeText = (c) => {
    const [k, a, b] = c.split('|');
    return t('hd.' + k, { a, b });
  };
  const detail = (s) =>
    s.d === 'skipped'
      ? t('sd.skipped')
      : t(
          `sd.${s.id}.${s.d}`,
          s.p.codes ? { ...s.p, list: s.p.codes.map(codeText).join(' ; ') } : s.p,
        );
  $('#result').innerHTML = `<ul class="steps">${res.steps
    .map(
      (s) =>
        `<li class="${s.ok === true ? 'ok' : s.ok === false ? 'ko' : 'na'}"><span class="st">${esc(t(s.ok === true ? 'st.ok' : s.ok === false ? 'st.ko' : 'st.na'))}</span><span><strong>${esc(t('step.' + s.id, s.p))}</strong> : ${esc(detail(s))}</span></li>`,
    )
    .join('')}</ul>
    <p class="final ${res.ok ? 'ok' : 'ko'}">${esc(res.ok ? t('res.ok', { s: res.score }) : t('res.ko'))}</p>`;
}

async function submitForm(form, { renew = true } = {}) {
  state.lastForm = form;
  $('#btnReplay').disabled = false;
  let res = await verify(form);
  if (!res.ok && res.stepUp) {
    // Score limite : vérification supplémentaire (preuve de travail plus lourde) plutôt qu'un refus.
    $('#result').innerHTML = `<p aria-busy="true">${esc(t('res.stepup'))}</p>`;
    const challenge =
      res.stepUp === true
        ? { ...(await getChallenge('demo', LIMITS.powBits + LIMITS.stepUpBits)), up: 1 }
        : res.stepUp;
    res = await verify(await resolveStepUp(form, challenge));
  }
  showResult(res);
  // Serveur réel : une trajectoire acceptée est mémorisée ; le jeton suivant doit en enregistrer une nouvelle.
  if (res.ok && mode === 'server' && !state.sim) rec.clearBehavior();
  if (renew) await newChallenge();
}

async function currentForm(extra = {}) {
  await state.powPromise;
  render();
  return {
    name: $('#name').value,
    message: $('#typing').value,
    website: $('#website').value,
    cf_token: state.token,
    ...extra,
  };
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await submitForm(await currentForm());
});
$('#btnReplay').addEventListener(
  'click',
  () => state.lastForm && submitForm(state.lastForm, { renew: false }),
);
$('#btnForge').addEventListener('click', async () => {
  const form = await currentForm();
  const p = decodeToken(form.cf_token);
  p.score = 100;
  await submitForm({ ...form, cf_token: encodeToken(p) });
});
$('#btnHoney').addEventListener('click', async () => {
  $('#website').value = 'http://spam.example';
  await submitForm(await currentForm());
  $('#website').value = '';
});

// ── Simulations ────────────────────────────────────────────────────────────
$('#btnBot').addEventListener('click', () => {
  state.sim = { mouse: simulateBotMouse(), keys: simulateBotKeys(), gestures: simulateBotTouch() };
  dirty = true;
});
$('#btnAgent').addEventListener('click', () => {
  state.sim = simulateAgent();
  dirty = true;
});
$('#btnHeadless').addEventListener('click', () => {
  state.overrides = {
    webdriver: true,
    headlessUA: true,
    softwareGpu: true,
    gpuRenderer: 'Google SwiftShader',
    cores: 1,
  };
  dirty = true;
});
$('#btnReset').addEventListener('click', () => {
  state.sim = null;
  state.overrides = {};
  rec.reset();
  $('#typing').value = '';
  dirty = true;
});
$('#btnIp').addEventListener('click', async () => {
  $('#ipOut').textContent = t('ip.loading');
  state.ipStatus = 'ip.loading';
  try {
    state.ip = await fetchPublicIP();
    state.ipStatus = 'ip.ok';
  } catch {
    state.ipStatus = 'ip.fail';
  }
  $('#ipOut').textContent = t(state.ipStatus);
  dirty = true;
});

// ── Labo (panneau latéral rétractable) ─────────────────────────────────────
function renderLab() {
  $('#lab').innerHTML = RULES.map((r) => {
    const w = state.weights[r.id] ?? r.weight;
    return `<div><label for="w-${r.id}"><span>${esc(t('rl.' + r.id))}</span><strong id="wv-${r.id}">${w}</strong></label>
      <input type="range" id="w-${r.id}" data-id="${r.id}" min="0" max="100" value="${w}"></div>`;
  }).join('');
}

function setupLab() {
  renderLab();
  $('#lab').addEventListener('input', (e) => {
    const id = e.target.dataset.id;
    if (!id) return;
    state.weights[id] = Number(e.target.value);
    $(`#wv-${id}`).textContent = e.target.value;
    dirty = true;
  });
  $('#thr').addEventListener('input', (e) => {
    state.threshold = Number(e.target.value);
    $('#thrLabel').textContent = state.threshold;
    dirty = true;
  });
  $('#btnLabReset').addEventListener('click', () => {
    for (const k of Object.keys(state.weights)) delete state.weights[k];
    renderLab();
    state.threshold = DEFAULT_THRESHOLD;
    $('#thr').value = DEFAULT_THRESHOLD;
    $('#thrLabel').textContent = DEFAULT_THRESHOLD;
    dirty = true;
  });

  const panel = $('#labPanel'),
    tab = $('#labToggle');
  const set = (open) => {
    panel.classList.toggle('open', open);
    tab.setAttribute('aria-expanded', open);
    if (open) $('#labClose').focus();
    else tab.focus();
    try {
      localStorage.setItem('labOpen', open ? '1' : '0');
    } catch {
      /* ignoré */
    }
  };
  tab.addEventListener('click', () => set(true));
  $('#labClose').addEventListener('click', () => set(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open')) set(false);
  });
  let saved = null;
  try {
    saved = localStorage.getItem('labOpen');
  } catch {
    /* ignoré */
  }
  panel.hidden = false;
  if (saved === '1') {
    panel.classList.add('open');
    tab.setAttribute('aria-expanded', 'true');
  }
}

// ── Langue ─────────────────────────────────────────────────────────────────
function refreshLanguage() {
  applyI18n();
  renderMode();
  renderLab();
  $('#ipOut').textContent = t(state.ipStatus);
  if (state.lastResult) showResult(state.lastResult);
  lastRulesKey = lastInfoKey = '';
  render();
}

function setupLanguage() {
  document.querySelectorAll('[data-lang]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.lang === getLang()) return;
      setLang(b.dataset.lang);
      refreshLanguage();
    }),
  );
}

// Hauteur du bandeau fixe : le panneau labo se place juste dessous.
function trackBarHeight() {
  const bar = $('#bar');
  const apply = () =>
    document.documentElement.style.setProperty('--bar-h', bar.offsetHeight + 'px');
  apply();
  if ('ResizeObserver' in window) new ResizeObserver(apply).observe(bar);
  else window.addEventListener('resize', apply);
}

// ── Démarrage ──────────────────────────────────────────────────────────────
async function init() {
  applyI18n();
  renderMode();
  setupLab();
  setupLanguage();
  trackBarHeight();
  if (!window.crypto?.subtle) {
    $('#modeNote').textContent = t('note.insecure');
    return;
  }
  ({ signals: state.fp, info: state.info } = await collectFingerprint());
  await newChallenge();
  render();
  setInterval(() => {
    if (state.challenge && Date.now() - state.challenge.ts > 100_000) newChallenge(); // le jeton expire à 120 s
    if (dirty || rec.version !== lastVersion) {
      dirty = false;
      lastVersion = rec.version;
      render();
    }
  }, 400);
}
init();
