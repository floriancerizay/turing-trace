// Widget Turing Trace à intégrer sur n'importe quel site :
//
//   <form method="post" action="/contact" data-turing-trace> … </form>
//   <script type="module" src="https://VOTRE-SERVEUR-TURING-TRACE/js/widget.js"></script>
//
// À l'envoi du formulaire, le widget construit le jeton, le fait vérifier par le serveur Turing Trace, ajoute le jeton de
// passage dans un champ caché `turing_trace_pass`, puis soumet le formulaire. Votre backend valide ce jeton avec le
// middleware `requireHuman` (lib/middleware.js) ou l'endpoint /api/siteverify.
//
// Options (attributs du formulaire) :
//   data-turing-trace="event"  ne pas soumettre : émettre seulement l'événement `turing-trace:verified` (applications JS)
//   data-turing-trace-fallback="submit"  si le serveur Turing Trace ne répond pas, soumettre quand même le formulaire
//                                       (sans jeton de passage : c'est alors votre backend qui décide, voir `failOpen`) ;
//                                       par défaut, le formulaire n'est pas envoyé.
// Événements émis sur le formulaire :
//   `turing-trace:verified`     detail { score, pass }
//   `turing-trace:rejected`     detail : résultat du serveur (le visiteur est refusé)
//   `turing-trace:stepup`       score limite : une vérification supplémentaire (calcul d'environ une seconde) est en cours
//   `turing-trace:unavailable`  le serveur Turing Trace est injoignable ou trop lent (detail { error })
import { collectFingerprint } from './fingerprint.js';
import { Recorder } from './behavior.js';
import { evaluate } from './scoring.js';
import { solvePow, buildToken, resolveStepUp } from './token.js';
import { behaviorOf, buildSignals } from './signals.js';

// Le serveur Turing Trace est celui qui sert ce fichier (…/js/widget.js → …/).
const ENDPOINT = new URL('../', import.meta.url).href;
const CHALLENGE_MAX_AGE = 100_000; // le serveur refuse au-delà de 120 s
const FETCH_TIMEOUT_MS = 5000; // au-delà, le serveur est considéré comme indisponible

const postJson = (path, body) =>
  fetch(new URL(path, ENDPOINT), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).then((r) => r.json());

const fpPromise = collectFingerprint().then((r) => r.signals);

function challenger() {
  let current = null;
  const fresh = async () => {
    const r = await fetch(new URL('api/challenge', ENDPOINT), {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`turing-trace: challenge HTTP ${r.status}`);
    const ch = await r.json();
    current = { ch, pow: solvePow(ch.nonce, ch.bits) };
    return current;
  };
  return {
    renew: fresh,
    async get() {
      if (!current || Date.now() - current.ch.ts > CHALLENGE_MAX_AGE) await fresh();
      return { ch: current.ch, pow: await current.pow };
    },
  };
}

function addHidden(form, name) {
  let el = form.querySelector(`input[name="${name}"]`);
  if (!el) {
    el = Object.assign(document.createElement('input'), { type: 'hidden', name });
    form.append(el);
  }
  return el;
}

function addHoneypot(form) {
  const box = document.createElement('div');
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText =
    'position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden';
  const input = Object.assign(document.createElement('input'), {
    type: 'text',
    name: 'nc_website',
    tabIndex: -1,
    autocomplete: 'off',
  });
  box.append(input);
  form.append(box);
  return input;
}

function protect(form) {
  if (form.__turingTrace) return;
  form.__turingTrace = true;
  const rec = new Recorder(form);
  const hp = addHoneypot(form);
  const passField = addHidden(form, 'turing_trace_pass');
  const ch = challenger();
  ch.renew().catch(() => {}); // précharge le défi et la preuve de travail
  let busy = false;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    const submitter = e.submitter;
    try {
      const [fp, { ch: challenge, pow }] = await Promise.all([fpPromise, ch.get()]);
      const behavior = behaviorOf(rec);
      const signals = buildSignals(fp, rec, behavior, { powSolved: true });
      const { token } = buildToken(challenge, pow, evaluate(signals).score, signals, behavior.raw);
      const body = { website: hp.value, cf_token: token };
      let res = await postJson('api/verify', body);
      if (!res.ok && res.stepUp) {
        // Score limite : plutôt qu'un refus, une vérification supplémentaire (preuve de travail plus lourde, ~1 s).
        form.dispatchEvent(new CustomEvent('turing-trace:stepup'));
        res = await postJson('api/verify', await resolveStepUp(body, res.stepUp));
      }
      ch.renew().catch(() => {}); // le défi est consommé : en préparer un autre
      if (!res.ok) {
        form.dispatchEvent(new CustomEvent('turing-trace:rejected', { detail: res }));
        return;
      }
      passField.value = res.pass;
      rec.clearBehavior(); // le prochain jeton ne doit pas rejouer la même trajectoire
      form.dispatchEvent(
        new CustomEvent('turing-trace:verified', { detail: { score: res.score, pass: res.pass } }),
      );
      if (form.dataset.turingTrace !== 'event') {
        // Conserver le bouton d'envoi utilisé (name/value) puis soumettre sans redéclencher ce gestionnaire.
        if (submitter?.name) addHidden(form, submitter.name).value = submitter.value;
        HTMLFormElement.prototype.submit.call(form);
      }
    } catch (err) {
      // Réseau coupé, délai dépassé, réponse illisible : le serveur Turing Trace est indisponible (≠ visiteur refusé).
      form.dispatchEvent(
        new CustomEvent('turing-trace:unavailable', { detail: { error: String(err) } }),
      );
      if (form.dataset.turingTraceFallback === 'submit') {
        if (submitter?.name) addHidden(form, submitter.name).value = submitter.value;
        HTMLFormElement.prototype.submit.call(form);
      }
    } finally {
      busy = false;
    }
  });
}

const scan = () => document.querySelectorAll('form[data-turing-trace]').forEach(protect);
scan();
new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
