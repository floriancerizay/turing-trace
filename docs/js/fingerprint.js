// Collecte matérielle et détection d'automatisation. Tout reste dans le navigateur.

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Bytes(str) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)));
}

export function parseUA(ua) {
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iPod/.test(ua)
        ? 'iOS'
        : /CrOS/.test(ua)
          ? 'ChromeOS'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macOS'
            : /Linux|X11/.test(ua)
              ? 'Linux'
              : 'Inconnu';
  const m = (re) => (ua.match(re) || [])[1];
  const browser = /Edg\//.test(ua)
    ? `Edge ${m(/Edg\/([\d.]+)/)}`
    : /OPR\//.test(ua)
      ? `Opera ${m(/OPR\/([\d.]+)/)}`
      : /Firefox\//.test(ua)
        ? `Firefox ${m(/Firefox\/([\d.]+)/)}`
        : /(Chrome|Chromium|HeadlessChrome)\//.test(ua)
          ? `Chrome ${m(/(?:Chrome|Chromium|HeadlessChrome)\/([\d.]+)/)}`
          : /Safari\//.test(ua)
            ? `Safari ${m(/Version\/([\d.]+)/)}`
            : 'Inconnu';
  return { os, browser };
}

function webglInfo() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return { noWebgl: true, renderer: null, vendor: null, softwareGpu: false };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext
      ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    const vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    return {
      noWebgl: false,
      renderer,
      vendor,
      softwareGpu: /swiftshader|llvmpipe|softpipe|software|mesa offscreen|basic render/i.test(
        `${renderer} ${vendor}`,
      ),
    };
  } catch {
    return { noWebgl: true, renderer: null, vendor: null, softwareGpu: false };
  }
}

async function canvasInfo() {
  try {
    const c = document.createElement('canvas');
    c.width = 240;
    c.height = 60;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 240, 0);
    g.addColorStop(0, '#f60');
    g.addColorStop(1, '#09f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 240, 60);
    ctx.fillStyle = '#222';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '16px Arial';
    ctx.fillText('turing-trace ✓ Cwm fjordbank 😀', 6, 24);
    ctx.font = 'italic 14px serif';
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    ctx.fillText('Sphinx of black quartz, judge my vow', 6, 46);
    ctx.beginPath();
    ctx.arc(205, 30, 18, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    const url = c.toDataURL();
    const px = ctx.getImageData(0, 0, 240, 60).data;
    const colors = new Set();
    for (let i = 0; i < px.length; i += 64)
      colors.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    return { hash: await sha256Hex(url), blank: colors.size < 4, url };
  } catch {
    return { hash: null, blank: true, url: null };
  }
}

async function audioHash() {
  try {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx(1, 5000, 44100);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 10000;
    const comp = ctx.createDynamicsCompressor();
    osc.connect(comp);
    comp.connect(ctx.destination);
    osc.start(0);
    const buf = await Promise.race([
      ctx.startRendering(),
      new Promise((_, r) => setTimeout(r, 2000)),
    ]);
    const data = buf.getChannelData(0);
    let sum = 0;
    for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
    return (await sha256Hex(sum.toFixed(10))).slice(0, 16);
  } catch {
    return null;
  }
}

function detectFonts() {
  const candidates = [
    'Arial',
    'Verdana',
    'Times New Roman',
    'Courier New',
    'Georgia',
    'Trebuchet MS',
    'Comic Sans MS',
    'Impact',
    'Tahoma',
    'Helvetica',
    'Segoe UI',
    'Roboto',
    'Ubuntu',
    'DejaVu Sans',
    'Liberation Sans',
    'Noto Sans',
    'Menlo',
    'Monaco',
    'Consolas',
    'Calibri',
    'Cambria',
    'Palatino',
    'Garamond',
    'Lucida Grande',
  ];
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    const text = 'mmmmmmmmmmlli0Oq';
    const width = (font) => {
      ctx.font = `72px ${font}`;
      return ctx.measureText(text).width;
    };
    const base = ['monospace', 'sans-serif', 'serif'].map((b) => [b, width(b)]);
    return candidates.filter((f) => base.some(([b, w]) => width(`'${f}',${b}`) !== w));
  } catch {
    return [];
  }
}

function measureRefreshRate() {
  return new Promise((resolve) => {
    const deltas = [];
    let last = performance.now();
    const timeout = setTimeout(() => resolve(null), 3000);
    const tick = (t) => {
      deltas.push(t - last);
      last = t;
      if (deltas.length < 40) return requestAnimationFrame(tick);
      clearTimeout(timeout);
      const sorted = deltas.slice(5).sort((a, b) => a - b);
      resolve(Math.round(1000 / sorted[Math.floor(sorted.length / 2)]));
    };
    requestAnimationFrame(tick);
  });
}

// Codes d'incohérence (traduits côté affichage, clés inc.*) : « code|argument|argument ».
function detectInconsistencies(ua) {
  const out = [];
  const plat = navigator.platform || '';
  if (/Windows/.test(ua) && plat && !/Win/i.test(plat)) out.push(`ua_platform|Windows|${plat}`);
  if (/Macintosh/.test(ua) && plat && !/Mac/i.test(plat)) out.push(`ua_platform|Mac|${plat}`);
  if (/Android/.test(ua) && plat && !/Linux|Android/i.test(plat))
    out.push(`ua_platform|Android|${plat}`);
  if (/iPhone|iPad/.test(ua) && plat && !/iPhone|iPad|Mac/i.test(plat))
    out.push(`ua_platform|iOS|${plat}`);
  if (/Mobi|Android|iPhone/.test(ua) && navigator.maxTouchPoints === 0) out.push('mobile_no_touch');
  if (window.outerWidth === 0 && window.outerHeight === 0) out.push('zero_window');
  if (/Chrome\//.test(ua) && !/Edg|OPR/.test(ua) && !('chrome' in window))
    out.push('chrome_no_chrome');
  if (navigator.languages?.length && !navigator.languages.includes(navigator.language))
    out.push('lang_not_in_list');
  if (!window.devicePixelRatio) out.push('dpr_zero');
  return out;
}

const withTimeout = (p, ms, fallback = null) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]).catch(() => fallback);

// ── Anti-bot ──────────────────────────────────────────────────────────────
async function clientHints() {
  const d = navigator.userAgentData;
  if (!d) return null;
  const hi = await withTimeout(
    d.getHighEntropyValues([
      'platformVersion',
      'architecture',
      'bitness',
      'model',
      'fullVersionList',
    ]),
    1500,
    {},
  );
  return {
    platform: d.platform,
    mobile: d.mobile,
    platformVersion: hi.platformVersion,
    architecture: hi.architecture,
    bitness: hi.bitness,
    model: hi.model,
    brands: (hi.fullVersionList || d.brands || [])
      .filter((b) => !/Not.?A.?Brand/i.test(b.brand))
      .map((b) => `${b.brand} ${b.version}`),
  };
}

/** Signe classique du Chrome headless : Notification.permission « denied » alors que l'API Permissions dit « prompt ». */
async function permissionsInfo() {
  if (!('Notification' in window) || !navigator.permissions)
    return { mismatch: false, api: null, perm: null };
  const st = await withTimeout(navigator.permissions.query({ name: 'notifications' }), 1000);
  const api = st?.state ?? null;
  return {
    mismatch: Notification.permission === 'denied' && api === 'prompt',
    api,
    perm: Notification.permission,
  };
}

async function webgpuInfo() {
  if (!navigator.gpu) return null;
  const adapter = await withTimeout(navigator.gpu.requestAdapter(), 1500);
  if (!adapter) return null;
  const info = adapter.info || (await withTimeout(adapter.requestAdapterInfo?.(), 800, {})) || {};
  return (
    [info.vendor, info.architecture, info.description].filter(Boolean).join(' · ') || 'disponible'
  );
}

function speechVoices() {
  if (!('speechSynthesis' in window)) return Promise.resolve(null);
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now.length);
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices().length);
    speechSynthesis.addEventListener?.('voiceschanged', done, { once: true });
    setTimeout(done, 1200);
  });
}

async function mediaDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return null;
  const list = await withTimeout(navigator.mediaDevices.enumerateDevices(), 1000, []);
  const n = (k) => list.filter((d) => d.kind === k).length;
  return { mic: n('audioinput'), cam: n('videoinput'), spk: n('audiooutput') };
}

/** Quota de stockage : les fenêtres de navigation privée de Chromium reçoivent un quota nettement plus faible. Simple indice. */
async function storageInfo() {
  const e = await withTimeout(navigator.storage?.estimate?.(), 1000);
  if (!e?.quota) return null;
  const gb = e.quota / 1024 ** 3;
  return { quotaGB: Math.round(gb * 10) / 10, privateLikely: gb < 1.2 };
}

// ── Préférences et contexte ───────────────────────────────────────────────
function preferences() {
  const q = (m) => window.matchMedia?.(m).matches;
  return {
    scheme: q('(prefers-color-scheme: dark)') ? 'dark' : 'light',
    reducedMotion: !!q('(prefers-reduced-motion: reduce)'),
    contrast: q('(prefers-contrast: more)')
      ? 'more'
      : q('(prefers-contrast: less)')
        ? 'less'
        : 'normal',
    forcedColors: !!q('(forced-colors: active)'),
    gamut: q('(color-gamut: rec2020)')
      ? 'rec2020'
      : q('(color-gamut: p3)')
        ? 'p3'
        : q('(color-gamut: srgb)')
          ? 'srgb'
          : null,
    hdr: !!q('(dynamic-range: high)'),
    pointer: q('(pointer: fine)') ? 'fine' : q('(pointer: coarse)') ? 'coarse' : 'none',
    orientation: screen.orientation?.type ?? null,
  };
}

function connection() {
  const c = navigator.connection;
  return c
    ? { type: c.effectiveType, rtt: c.rtt, downlink: c.downlink, saveData: !!c.saveData }
    : null;
}

// ── Matériel avancé ───────────────────────────────────────────────────────
async function keyboardLayout() {
  const map = await withTimeout(navigator.keyboard?.getLayoutMap?.(), 1000);
  if (!map) return null;
  const k = (c) => map.get(c);
  if (k('KeyQ') === 'a' && k('KeyW') === 'z') return 'AZERTY';
  if (k('KeyY') === 'z' && k('KeyQ') === 'q') return 'QWERTZ';
  if (k('KeyQ') === 'q' && k('KeyW') === 'w') return 'QWERTY';
  return [k('KeyQ'), k('KeyW'), k('KeyE'), k('KeyR'), k('KeyT'), k('KeyY')].join('').toUpperCase();
}

function codecs() {
  const v = document.createElement('video');
  const a = document.createElement('audio');
  const list = {
    'H.264': [v, 'video/mp4; codecs="avc1.42E01E"'],
    HEVC: [v, 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
    VP9: [v, 'video/webm; codecs="vp9"'],
    AV1: [v, 'video/mp4; codecs="av01.0.05M.08"'],
    Opus: [a, 'audio/ogg; codecs="opus"'],
    AAC: [a, 'audio/mp4; codecs="mp4a.40.2"'],
    FLAC: [a, 'audio/flac'],
  };
  return Object.entries(list)
    .filter(([, [el, type]]) => el.canPlayType(type) !== '')
    .map(([name]) => name);
}

const gamepads = () =>
  navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean).length : null;

/** Collecte tout. Retourne { signals, info } : signals alimente le scoring, info alimente l'affichage. */
export async function collectFingerprint() {
  const ua = navigator.userAgent;
  const { os, browser } = parseUA(ua);
  const gl = webglInfo();
  const [canvas, refreshHz, audio] = await Promise.all([
    canvasInfo(),
    measureRefreshRate(),
    audioHash(),
  ]);
  const fonts = detectFonts();
  const [uach, perms, webgpu, voices, devices, storage, layout] = await Promise.all([
    clientHints(),
    permissionsInfo(),
    webgpuInfo(),
    speechVoices(),
    mediaDevices(),
    storageInfo(),
    keyboardLayout(),
  ]);
  const codecList = codecs();
  const prefs = preferences();

  const inconsistencies = detectInconsistencies(ua);
  const uaOS = parseUA(ua).os;
  const chOS = {
    Windows: 'Windows',
    macOS: 'macOS',
    Linux: 'Linux',
    Android: 'Android',
    ChromeOS: 'Chrome OS',
  }[uaOS];
  if (uach?.platform && chOS && uach.platform !== chOS)
    inconsistencies.push(`uach_platform|${uaOS}|${uach.platform}`);
  if (prefs.pointer === 'coarse' && navigator.maxTouchPoints === 0)
    inconsistencies.push('pointer_touch');
  // Google Chrome intègre toujours H.264 ; les builds Chromium d'automatisation (Playwright, Puppeteer) non.
  if (/Chrome\//.test(ua) && !/Edg|OPR/.test(ua) && !codecList.includes('H.264'))
    inconsistencies.push('chrome_no_h264');

  const automationGlobals = [
    'callPhantom',
    '_phantom',
    '__nightmare',
    'domAutomation',
    'domAutomationController',
    '_selenium',
    '__webdriver_evaluate',
    '__selenium_unwrapped',
    '__driver_evaluate',
  ].filter((k) => k in window || k in document);

  const mathNative =
    /\[native code\]/.test(Function.prototype.toString.call(Math.random)) &&
    Math.random.name === 'random';

  const signals = {
    ua,
    webdriver: navigator.webdriver === true,
    // Le UA peut être réécrit, mais Chrome headless s'annonce aussi dans les marques des Client Hints.
    headlessUA: /HeadlessChrome/.test(ua) || !!uach?.brands.some((b) => /Headless/i.test(b)),
    automationGlobals,
    mathNative,
    softwareGpu: gl.softwareGpu,
    noWebgl: gl.noWebgl,
    gpuRenderer: gl.renderer,
    canvasBlank: canvas.blank,
    cores: navigator.hardwareConcurrency ?? null,
    memory: navigator.deviceMemory ?? null,
    refreshHz,
    inconsistencies,
    uachPlatform: uach?.platform || null,
    uachBrands: uach ? uach.brands.join(',') : null,
    lang: navigator.languages?.[0] || navigator.language || null,
    permissionsMismatch: perms.mismatch,
    voices,
    codecs: codecList.join(','),
    languagesEmpty: !navigator.languages || navigator.languages.length === 0,
    canvasHash: canvas.hash ? canvas.hash.slice(0, 16) : null,
    audioHash: audio,
    fonts: fonts.length,
  };

  const info = {
    os,
    browser,
    gpuVendor: gl.vendor,
    canvasUrl: canvas.url,
    fontList: fonts,
    screen: `${screen.width}×${screen.height} @${window.devicePixelRatio}x`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    languages: (navigator.languages || []).join(', '),
    platform: navigator.platform,
    touchPoints: navigator.maxTouchPoints,
    uach,
    perms,
    webgpu,
    voices,
    devices,
    storage,
    prefs,
    conn: connection(),
    layout,
    codecs: codecList,
    gamepads: gamepads(),
  };
  return { signals, info };
}

/** Appel externe, déclenché uniquement sur clic explicite de l'utilisateur. */
export async function fetchPublicIP() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: ctl.signal });
    return (await r.json()).ip;
  } finally {
    clearTimeout(t);
  }
}
