// Journal des décisions : de quoi régler les seuils sur du vrai trafic et repérer les faux positifs.
// Vie privée : on n'enregistre NI adresse IP NI empreinte NI contenu de formulaire, seulement la date, la décision,
// le score, l'étape qui a refusé et les identifiants des règles déclenchées.

export function createStats(store, { windowMs = 24 * 3600_000 } = {}) {
  return {
    record(d) {
      store.append('decision', {
        t: Date.now(),
        ok: !!d.ok,
        score: d.score ?? null,
        step: d.step ?? null,
        rules: d.rules ?? [],
      });
    },
    summary(now = Date.now()) {
      const entries = store.entries('decision', now - windowMs);
      const histogram = Array.from({ length: 10 }, (_, i) => ({
        from: i * 10,
        to: i === 9 ? 100 : i * 10 + 9,
        count: 0,
      }));
      const rules = {},
        steps = {};
      let accepted = 0;
      for (const e of entries) {
        if (e.ok) accepted++;
        if (e.score != null) histogram[Math.min(9, Math.floor(e.score / 10))].count++;
        for (const r of e.rules || []) rules[r] = (rules[r] || 0) + 1;
        if (e.step) steps[e.step] = (steps[e.step] || 0) + 1;
      }
      const top = (o, n = 10) =>
        Object.entries(o)
          .sort((a, b) => b[1] - a[1])
          .slice(0, n)
          .map(([id, count]) => ({ id, count }));
      return {
        windowHours: windowMs / 3600_000,
        total: entries.length,
        accepted,
        acceptanceRate: entries.length ? accepted / entries.length : null,
        histogram,
        topRules: top(rules),
        topSteps: top(steps),
      };
    },
  };
}
