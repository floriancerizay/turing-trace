import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createTokenService } from './lib/token.js';
import { createReputation } from './lib/reputation.js';
import { checkHeaders } from './lib/headers.js';
import { clientKey } from './lib/ip.js';
import { DEFAULT_MAX_ENTRIES } from './lib/bounded.js';
import { createStore } from './lib/store.js';
import { createStats } from './lib/stats.js';
import { verifyToken, decodeToken, LIMITS } from './docs/js/verify.js';
import { evaluate } from './docs/js/scoring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** TRUST_PROXY : « 1 » (nombre de sauts), « true », ou une liste d'adresses / « loopback ». Vide : pas de proxy de confiance. */
export function parseTrustProxy(v) {
  if (v === undefined || v === null || v === '' || v === 'false') return false;
  if (v === true || v === 'true') return true;
  if (typeof v === 'number') return v;
  return /^\d+$/.test(String(v)) ? Number(v) : String(v);
}

export function createApp({
  secret = process.env.CAPTCHA_SECRET,
  // Rotation du secret : anciens secrets encore acceptés pour vérifier (jamais pour signer), séparés par des virgules.
  previousSecrets = (process.env.CAPTCHA_SECRET_PREVIOUS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  minScore = Number(process.env.MIN_SCORE) || 60,
  rateLimit = Number(process.env.RATE_LIMIT) || 30, // requêtes / minute / IP
  // Sites autorisés à intégrer le widget (appels cross-origin), ex. « https://monsite.fr,https://autre.fr ».
  allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  // /api/score est un oracle : il dit à un attaquant ce qui le trahit. Désactivé sauf SCORE_API=1 (tests d'intrusion).
  scoreApi = process.env.SCORE_API === '1',
  // Derrière un reverse proxy, indiquez combien de sauts sont de confiance (ex. 1). Sinon toutes les requêtes ont l'IP du proxy.
  trustProxy = parseTrustProxy(process.env.TRUST_PROXY),
  maxEntries = Number(process.env.MAX_ENTRIES) || DEFAULT_MAX_ENTRIES, // plafond des tables en mémoire
  // « memory » (défaut) ou « sqlite:./data/turing-trace.db » : l'état survit alors au redémarrage (voir lib/store.js).
  store: storeSpec = process.env.STORE,
  // Jeton d'accès à /api/stats (page docs/admin.html). Sans lui, l'endpoint n'existe pas.
  adminToken = process.env.ADMIN_TOKEN,
  // Bits de preuve de travail ajoutés au défi de palier (score limite : vérification supplémentaire plutôt que refus).
  stepUpBits = Number(process.env.STEP_UP_BITS) || LIMITS.stepUpBits,
  // Mode observation : les décisions sont calculées et journalisées, mais personne n'est bloqué. À utiliser pour régler
  // les seuils sur du vrai trafic (page admin.html) avant d'appliquer les refus.
  observe = process.env.OBSERVE === '1',
} = {}) {
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    console.warn(
      '[turing-trace] CAPTCHA_SECRET absent : secret aléatoire généré (les jetons expirent au redémarrage).',
    );
  }
  const store = createStore(storeSpec, { maxEntries });
  const tokens = createTokenService(secret, { maxEntries, store, previousSecrets });
  const rep = createReputation({ maxEntries, store });
  const stats = createStats(store);
  const app = express();
  app.locals.store = store; // pour fermer proprement la base (app.locals.store.close())
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', trustProxy);
  // Clé de regroupement du client : l'IPv4, ou le préfixe /64 en IPv6 (voir lib/ip.js).
  const keyOf = (req) => clientKey(req.ip);
  // En-têtes de sécurité sur toutes les réponses. CSP : aucun script ni style en ligne, uniquement les fichiers de ce serveur ;
  // seul appel externe possible : api.ipify.org (bouton « Afficher mon IP publique », à la demande du visiteur).
  // Le widget, chargé par d'autres sites, n'est pas concerné : une CSP s'applique au document qui la reçoit, pas aux scripts qu'il charge.
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self' https://api.ipify.org",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    next();
  });
  // CORS limité aux origines déclarées : widget (modules JS) et API navigateur. /api/siteverify reste réservé aux serveurs.
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (
      origin &&
      allowedOrigins.includes(origin) &&
      req.path !== '/api/siteverify' &&
      req.path !== '/api/stats'
    ) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST',
      });
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });
  // 64 ko : le jeton embarque les données brutes de comportement (300 points de souris, 200 événements de frappe).
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  // Limiteur de débit à fenêtre glissante (RATE_LIMIT requêtes par minute et par client), dans le stockage.
  app.use('/api', (req, res, next) => {
    const n = store.add('rate', keyOf(req), Date.now(), 60_000);
    return n > rateLimit ? res.status(429).json({ ok: false, error: 'Trop de requêtes' }) : next();
  });

  // Empreinte de la connexion à laquelle le défi est lié : un jeton résolu par un humain ailleurs (ferme à CAPTCHA)
  // puis relayé à un bot ne vérifie pas. Derrière un proxy, activez « trust proxy » pour que req.ip soit la vraie IP.
  const bindOf = (req) =>
    crypto
      .createHash('sha256')
      .update([keyOf(req), req.get('user-agent'), req.get('accept-language')].join('|'))
      .digest('base64url')
      .slice(0, 22);
  const secureReq = (req) => req.secure || ['localhost', '127.0.0.1', '::1'].includes(req.hostname);

  // Sonde de disponibilité (utilisée par le middleware en mode failOpen) : sans état, sans donnée.
  app.get('/api/health', (_req, res) => res.set('Cache-Control', 'no-store').json({ ok: true }));

  app.get('/api/challenge', (req, res) => {
    res
      .set('Cache-Control', 'no-store')
      .json(tokens.issueChallenge(rep.challengeBits(keyOf(req)), bindOf(req)));
  });

  app.post('/api/verify', async (req, res) => {
    const form = req.body || {};
    const result = await verifyToken(form, {
      checkSig: async (n, ts, bits, csig, up) =>
        tokens.checkSig(n, ts, bits, csig, bindOf(req) + (up ? '|up' : '')),
      consumeNonce: tokens.consumeNonce,
      sha256: tokens.sha256,
      headerCheck: (signals) => checkHeaders(req.headers, signals, secureReq(req)),
      now: Date.now,
      minScore,
      uaHeader: req.get('user-agent'),
      reputation: (signals) => rep.check(signals, keyOf(req)),
      traceSeen: (hash) => rep.traceSeen(hash),
      stepUp: !observe, // pas de palier en observation : la décision finale est journalisée telle quelle
      onDecision: (d) => stats.record(d),
      onAccept: (signals, info) => {
        rep.accept(signals, keyOf(req));
        rep.acceptTrace(info?.trace);
      },
    });
    // Observation : la décision réelle est journalisée (onDecision) et visible dans `steps`, mais la réponse accepte.
    if (observe) {
      result.observed = true;
      if (!result.ok) {
        result.wouldReject = true;
        result.ok = true;
      }
    }
    if (result.ok)
      result.pass = tokens.issuePass(result.score ?? 0, req.ip, undefined, !!result.wouldReject);
    // Palier : défi plus lourd, lié au client et signé comme « palier » (le champ `up` fait partie de la signature).
    if (result.stepUp)
      result.stepUp = {
        ...tokens.issueChallenge(LIMITS.powBits + stepUpBits, bindOf(req) + '|up'),
        up: 1,
      };
    res
      .status(result.ok ? 200 : 403)
      .set('Cache-Control', 'no-store')
      .json(result);
  });

  // Score détaillé, sans consommer le défi : permet d'itérer (tests d'intrusion sur son propre déploiement).
  if (scoreApi) {
    app.post('/api/score', async (req, res) => {
      const form = req.body || {};
      const result = await verifyToken(form, {
        checkSig: async (n, ts, bits, csig, up) =>
          tokens.checkSig(n, ts, bits, csig, bindOf(req) + (up ? '|up' : '')),
        headerCheck: (signals) => checkHeaders(req.headers, signals, secureReq(req)),
        consumeNonce: tokens.consumeNonce,
        sha256: tokens.sha256,
        now: Date.now,
        minScore,
        uaHeader: req.get('user-agent'),
        peek: true,
        reputation: (signals) => rep.check(signals, keyOf(req)),
        traceSeen: (hash) => rep.traceSeen(hash),
      });
      const payload = decodeToken(form.cf_token);
      const rules = payload?.signals
        ? evaluate({ ...payload.signals, powSolved: true })
            .items.filter((i) => i.hit)
            .map((i) => ({ id: i.id, malus: i.malus }))
        : [];
      res.set('Cache-Control', 'no-store').json({ ...result, minScore, rules });
    });
  }

  // Statistiques du journal des décisions, protégées par jeton (comparaison à temps constant).
  if (adminToken) {
    const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
    app.get('/api/stats', (req, res) => {
      const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!crypto.timingSafeEqual(digest(given), digest(adminToken)))
        return res.status(401).json({ error: 'unauthorized' });
      res.set('Cache-Control', 'no-store').json({ ...stats.summary(), observe });
    });
  }

  // Équivalent de « siteverify » : appelé par VOTRE backend (jamais par le navigateur) avec le jeton de passage.
  app.post('/api/siteverify', (req, res) => {
    const r = tokens.redeemPass(req.body?.pass, req.body?.remoteip);
    res
      .status(r.success ? 200 : 400)
      .set('Cache-Control', 'no-store')
      .json(r);
  });

  // Widget en un seul fichier (npm run build). Le fichier dont le nom contient l'empreinte du contenu ne change jamais : cache d'un an.
  // /widget.js est l'adresse stable qui suit les mises à jour : cache de 5 minutes seulement.
  const distDir = path.join(__dirname, 'docs', 'dist');
  app.use(
    '/dist',
    express.static(distDir, {
      index: false,
      setHeaders: (res, file) =>
        res.set(
          'Cache-Control',
          /widget-[0-9a-f]+\.js$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
        ),
    }),
  );
  try {
    const { file } = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
    app.get('/widget.js', (_req, res) =>
      res
        .type('text/javascript')
        .set('Cache-Control', 'public, max-age=300')
        .sendFile(path.join(distDir, file)),
    );
  } catch {
    /* pas encore construit : les modules de docs/js restent disponibles */
  }

  app.use(express.static(path.join(__dirname, 'docs')));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const server = createApp().listen(port, () => {
    console.log(`[turing-trace] http://localhost:${port}`);
    if (process.env.CAPTCHA_SECRET_PREVIOUS)
      console.warn(
        "[turing-trace] Rotation du secret en cours (CAPTCHA_SECRET_PREVIOUS) : retirez-le une fois les jetons émis avec l'ancien secret expirés (5 minutes).",
      );
    if (process.env.OBSERVE === '1')
      console.warn(
        "[turing-trace] MODE OBSERVATION (OBSERVE=1) : les décisions sont journalisées, aucune requête n'est bloquée.",
      );
    if (!process.env.ALLOWED_ORIGINS) {
      console.warn(
        '[turing-trace] ALLOWED_ORIGINS est vide : le widget ne pourra pas être chargé par un autre site (blocage CORS, le formulaire partirait sans jeton).\n' +
          "                Pour le site d'exemple : ALLOWED_ORIGINS=http://localhost:4000 npm start",
      );
    }
  });
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(
      `[turing-trace] Le port ${port} est déjà utilisé par un autre processus (souvent un ancien serveur resté lancé, ou « npm run demo »).\n` +
        `                Pour le trouver : ss -ltnp | grep :${port}\n` +
        `                Libérez-le, ou changez de port : PORT=3001 npm start`,
    );
    process.exit(1);
  });
}
