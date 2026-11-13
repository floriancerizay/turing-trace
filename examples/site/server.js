// Exemple d'intégration : un site tiers (port 4000) protège son formulaire de contact avec Turing Trace (port 3000).
//   ALLOWED_ORIGINS=http://localhost:4000 npm start      # serveur Turing Trace
//   npm run example                                      # ce site, puis http://localhost:4000
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { requireHuman } from '../../lib/middleware.js';

// Le widget en un seul fichier et son empreinte d'intégrité (sortie de `npm run build`).
const manifest = JSON.parse(fs.readFileSync(new URL('../../docs/dist/manifest.json', import.meta.url), 'utf8'));

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const REASONS = {
  'missing-pass': 'le formulaire a été envoyé sans passer par la vérification.',
  'low-score': 'le score de légitimité est trop bas.',
  'already-used': 'ce jeton a déjà servi.',
  expired: 'la vérification a expiré, rechargez la page.',
  'ip-mismatch': 'le jeton a été obtenu depuis une autre adresse.',
  'verifier-unreachable': 'le service de vérification est indisponible.',
};

const STYLE = `
  body { min-height: 100vh; display: grid; place-items: center; padding: 2rem 1rem; }
  main { width: 100%; max-width: 30rem; }
  article { margin: 0; padding: 2rem; }
  article > header { text-align: center; margin-bottom: 1.5rem; }
  article > header h1 { margin-bottom: .35rem; font-size: 1.6rem; }
  article > header p { margin: 0; color: var(--pico-muted-color); }
  form button[type=submit] { width: 100%; margin-bottom: 0; }
  .optional { font-weight: 400; color: var(--pico-muted-color); font-size: .85em; }
  #status { margin: 1rem 0 0; text-align: center; color: var(--pico-del-color); }
  #status:empty { display: none; }
  .badge { display: flex; align-items: center; justify-content: center; gap: .5rem; margin: 1.5rem 0 0;
    font-size: .8rem; color: var(--pico-muted-color); text-align: center; }
  .result { text-align: center; }
  .result .big { font-size: 3rem; font-weight: 700; line-height: 1; margin: .5rem 0 1rem; }
  .result .big small { font-size: 1rem; font-weight: 400; color: var(--pico-muted-color); }
  .result .ok { color: var(--pico-ins-color); } .result .ko { color: var(--pico-del-color); }
  .result a[role=button] { margin-top: 1rem; }
`;

/**
 * `fallback: 'submit'` : si le serveur Turing Trace est injoignable, le formulaire part quand même, sans jeton ; c'est ce
 * site qui décide alors (avec `failOpen: true`, il accepte le message en le signalant comme non vérifié ; sinon il le refuse).
 * Par défaut le formulaire n'est pas envoyé et le visiteur en est informé.
 */
export function createSite({ turingTraceUrl = process.env.TURING_TRACE_URL || 'http://localhost:3000', minScore = 60, fallback = null, failOpen = false, widgetIntegrity = manifest.integrity } = {}) {
  const app = express();
  const ttOrigin = new URL(turingTraceUrl).origin;
  // CSP stricte : les scripts et styles en ligne de ce site portent un nonce différent à chaque réponse ; le widget, la feuille
  // de style et le logo ne peuvent venir que du serveur Turing Trace, et les appels réseau ne vont que vers lui.
  const csp = (nonce) => [
    "default-src 'self'", `script-src 'nonce-${nonce}' ${ttOrigin}`, `style-src 'nonce-${nonce}' ${ttOrigin}`,
    `img-src ${ttOrigin} data:`, `connect-src ${ttOrigin}`, "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');
  const render = (res, title, body, status = 200) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.status(status).set({ 'Content-Security-Policy': csp(nonce), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
      .send(page(title, body.replaceAll('<script', `<script nonce="${nonce}"`), nonce));
  };

  const page = (title, body, nonce) => `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <link rel="icon" href="${turingTraceUrl}/logo.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${turingTraceUrl}/vendor/pico.min.css">
  <style nonce="${nonce}">${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;

  app.get('/', (_req, res) => render(res, 'Nous contacter', `
  <article>
    <header>
      <h1>Nous contacter</h1>
      <p>Une question, un projet ? Nous répondons sous 48 h.</p>
    </header>
    <form method="post" action="/contact" data-turing-trace${fallback ? ` data-turing-trace-fallback="${fallback}"` : ''}>
      <label>Nom
        <input name="name" autocomplete="name" required>
      </label>
      <label>E-mail <span class="optional">(facultatif)</span>
        <input name="email" type="email" autocomplete="email">
      </label>
      <label>Message
        <textarea name="message" rows="5" required></textarea>
      </label>
      <button type="submit">Envoyer le message</button>
    </form>
    <p id="status" role="status"></p>
    <p class="badge"><img src="${turingTraceUrl}/logo.svg" alt="" width="18" height="18">Protégé par Turing Trace : aucun test à passer</p>
  </article>
  <!-- Fichier épinglé par son empreinte (SRI) : si le serveur Turing Trace était compromis, un widget modifié ne s'exécuterait pas. -->
  <script type="module" src="${turingTraceUrl}/dist/${manifest.file}" integrity="${widgetIntegrity}" crossorigin="anonymous"></script>
  <script>
    const form = document.querySelector('form');
    const button = form.querySelector('button[type=submit]');
    const status = document.getElementById('status');
    // Sans le widget, le navigateur enverrait le formulaire tel quel, sans jeton : on l'empêche et on dit pourquoi.
    const widgetMissing = () => reset('Le widget Turing Trace n\u2019est pas chargé : le formulaire n\u2019est pas envoyé. Vérifiez que le serveur Turing Trace tourne et que ALLOWED_ORIGINS contient l\u2019adresse de ce site.');
    document.querySelector('script[src*="/dist/widget-"]').addEventListener('error', widgetMissing);
    form.addEventListener('submit', (e) => {
      if (!form.__turingTrace) { e.preventDefault(); widgetMissing(); return; }
      if (!form.checkValidity()) return;
      status.textContent = '';
      button.setAttribute('aria-busy', 'true');
      button.textContent = 'Vérification…';
    });
    const reset = (message) => {
      button.removeAttribute('aria-busy');
      button.textContent = 'Envoyer le message';
      status.textContent = message;
    };
    form.addEventListener('turing-trace:rejected', () => reset('Envoi refusé : votre navigateur ressemble à un robot.'));
    form.addEventListener('turing-trace:stepup', () => { button.textContent = 'Vérification supplémentaire…'; });
    form.addEventListener('turing-trace:unavailable', () => reset('Le service de vérification est indisponible. Réessayez dans un instant.'));
  </script>`));

  app.post('/contact', express.urlencoded({ extended: false }),
    requireHuman({
      verifyUrl: `${turingTraceUrl}/api/siteverify`, minScore, failOpen,
      onReject: (_req, res, reason) => render(res, 'Envoi refusé', `
  <article class="result">
    <header><h1 class="ko">Envoi refusé</h1></header>
    <p>Votre message n'a pas été transmis : ${esc(REASONS[reason] || reason)}</p>
    <a href="/" role="button" class="secondary">Revenir au formulaire</a>
  </article>`, 403),
    }),
    (req, res) => render(res, 'Message envoyé', `
  <article class="result">
    <header><h1 class="ok">Merci ${esc(req.body.name)} !</h1><p>Votre message a bien été envoyé.</p></header>
    ${req.turingTrace.unverified
      ? '<p id="unverified">Le service de vérification était indisponible : message reçu sans contrôle anti-robot.</p>'
      : `<p>Score de légitimité</p>
    <p class="big" id="ok" aria-label="score ${req.turingTrace.score} sur 100">${req.turingTrace.score}<small>/100</small></p>`}
    <a href="/" role="button" class="secondary">Envoyer un autre message</a>
  </article>`));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4000;
  createSite().listen(port, () => console.log(`[exemple] http://localhost:${port}`));
}
