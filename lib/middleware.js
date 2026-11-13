// Middleware Express pour VOTRE backend : exige un jeton de passage Turing Trace valide.
//
//   import { requireHuman } from 'turing-trace/middleware';
//   app.post('/contact', express.urlencoded({ extended: false }),
//     requireHuman({ verifyUrl: 'https://turing-trace.example.org/api/siteverify', minScore: 60 }),
//     (req, res) => res.send(`Merci (score ${req.turingTrace.score})`));
//
// Le jeton est lu dans le champ `turing_trace_pass` du corps (ajouté par le widget) ou dans l'en-tête `X-Turing-Trace-Pass`.
// En cas d'indisponibilité du serveur Turing Trace, la requête est refusée (fail closed), sauf `failOpen: true` :
// le middleware laisse alors passer la requête en la marquant `req.turingTrace.unverified`. Sans jeton, il ne le fait que si
// le serveur Turing Trace est réellement injoignable (sonde GET /api/health), pour qu'un bot ne puisse pas simplement omettre
// le jeton pendant que le service fonctionne.

export function requireHuman({
  verifyUrl,
  redeem, // alternative à verifyUrl : (pass, ip) => { success, score, error } (même processus)
  minScore = 0,
  field = 'turing_trace_pass',
  timeoutMs = 3000,
  failOpen = false,
  healthUrl, // sonde de disponibilité (défaut : ./health à côté de verifyUrl)
  onReject = (req, res, reason) => res.status(403).json({ ok: false, error: reason }),
} = {}) {
  if (!verifyUrl && !redeem) throw new Error('requireHuman : verifyUrl ou redeem requis');

  const check =
    redeem ??
    (async (pass, remoteip) => {
      const r = await fetch(verifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass, remoteip }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return r.json();
    });

  const probe = healthUrl ?? (verifyUrl ? new URL('./health', verifyUrl).href : null);
  const reachable = async () => {
    if (!probe) return true; // mode `redeem` : même processus, toujours joignable
    try {
      return (await fetch(probe, { signal: AbortSignal.timeout(timeoutMs) })).ok;
    } catch {
      return false;
    }
  };

  return async (req, res, next) => {
    const pass = req.body?.[field] ?? req.get('x-turing-trace-pass');
    if (!pass) {
      // Service en panne et site configuré pour continuer : le widget a soumis sans jeton (data-turing-trace-fallback="submit").
      if (failOpen && !(await reachable())) {
        req.turingTrace = { success: false, unverified: true };
        return next();
      }
      return onReject(req, res, 'missing-pass');
    }
    let r;
    try {
      r = await check(pass, req.ip);
    } catch {
      if (failOpen) {
        req.turingTrace = { success: false, unverified: true };
        return next();
      }
      return onReject(req, res, 'verifier-unreachable');
    }
    if (!r?.success) return onReject(req, res, r?.error || 'invalid-pass');
    // Mode observation du serveur Turing Trace : le jeton porte `observed`, le score n'est pas appliqué (il est seulement journalisé).
    if (r.score < minScore && !r.observed) return onReject(req, res, 'low-score');
    req.turingTrace = r;
    next();
  };
}
