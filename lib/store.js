// Stockage de l'état du serveur (nonces, jetons de passage, réputation, limiteur de débit, journal des décisions).
// Interface synchrone minimale ; deux implémentations :
//   - mémoire (défaut) : rapide, perdue au redémarrage, non partagée entre instances ;
//   - SQLite (STORE=sqlite:./data/turing-trace.db, module intégré node:sqlite) : survit au redémarrage.
// Pour plusieurs instances, écrire une troisième implémentation (Redis, par exemple) de la même interface.
import fs from 'node:fs';
import path from 'node:path';
import { capMap, DEFAULT_MAX_ENTRIES } from './bounded.js';

const RETAIN_MS = 15 * 60_000; // les compteurs plus anciens que la plus longue fenêtre utilisée sont supprimés
const LOG_CAP = 5000;

/**
 * Interface :
 *   add(ns, key, now, windowMs)   enregistre un événement et renvoie combien en compte la fenêtre
 *   count(ns, key, now, windowMs) nombre d'événements dans la fenêtre
 *   set(ns, key, expiresAt)       pose un marqueur (nonce, jeton de passage)
 *   take(ns, key, now)            consomme le marqueur : vrai une seule fois, et seulement avant expiration
 *   size(ns)                      nombre de marqueurs
 *   append(ns, entry) / entries(ns, since)  journal borné (les entrées portent un champ t)
 *   sweep(now), close()
 */
export function createMemoryStore({ maxEntries = DEFAULT_MAX_ENTRIES, sweepMs = 30_000 } = {}) {
  const counters = new Map(); // ns -> Map(key -> [timestamps])
  const markers = new Map(); // ns -> Map(key -> expiresAt)
  const logs = new Map(); // ns -> [entrées]
  const table = (m, ns) => m.get(ns) ?? m.set(ns, new Map()).get(ns);

  const store = {
    kind: 'memory',
    add(ns, key, now, windowMs) {
      const m = table(counters, ns);
      const arr = (m.get(key) || []).filter((t) => now - t < windowMs);
      arr.push(now);
      m.delete(key);
      m.set(key, arr); // réinsérer : la clé la plus récemment vue est la dernière à être évincée
      capMap(m, maxEntries);
      return arr.length;
    },
    count(ns, key, now, windowMs) {
      return (table(counters, ns).get(key) || []).filter((t) => now - t < windowMs).length;
    },
    set(ns, key, expiresAt) {
      const m = table(markers, ns);
      m.delete(key);
      m.set(key, expiresAt);
      capMap(m, maxEntries);
    },
    take(ns, key, now) {
      const m = table(markers, ns);
      const exp = m.get(key);
      if (exp === undefined) return false;
      m.delete(key);
      return exp >= now;
    },
    size: (ns) => table(markers, ns).size,
    append(ns, entry) {
      const a = logs.get(ns) ?? [];
      a.push(entry);
      while (a.length > LOG_CAP) a.shift();
      logs.set(ns, a);
    },
    entries: (ns, since = 0) => (logs.get(ns) || []).filter((e) => e.t >= since),
    sweep(now = Date.now()) {
      for (const m of counters.values())
        for (const [k, arr] of m) if (!arr.some((t) => now - t < RETAIN_MS)) m.delete(k);
      for (const m of markers.values()) for (const [k, exp] of m) if (exp < now) m.delete(k);
    },
    close() {
      clearInterval(timer);
    },
  };
  const timer = setInterval(() => store.sweep(), sweepMs);
  timer.unref();
  return store;
}

export function createSqliteStore(
  file,
  { maxEntries = DEFAULT_MAX_ENTRIES, sweepMs = 30_000 } = {},
) {
  const sqlite = process.getBuiltinModule?.('node:sqlite');
  if (!sqlite)
    throw new Error('STORE=sqlite demande Node.js 22.5 ou plus récent (module node:sqlite)');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS counters (ns TEXT NOT NULL, k TEXT NOT NULL, t INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS counters_idx ON counters (ns, k, t);
    CREATE TABLE IF NOT EXISTS markers (ns TEXT NOT NULL, k TEXT NOT NULL, exp INTEGER NOT NULL, PRIMARY KEY (ns, k));
    CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ns TEXT NOT NULL, t INTEGER NOT NULL, json TEXT NOT NULL);
  `);
  const q = {
    insCounter: db.prepare('INSERT INTO counters (ns, k, t) VALUES (?, ?, ?)'),
    count: db.prepare('SELECT COUNT(*) AS n FROM counters WHERE ns = ? AND k = ? AND t > ?'),
    setMarker: db.prepare('INSERT OR REPLACE INTO markers (ns, k, exp) VALUES (?, ?, ?)'),
    takeMarker: db.prepare('DELETE FROM markers WHERE ns = ? AND k = ? AND exp >= ?'),
    dropMarker: db.prepare('DELETE FROM markers WHERE ns = ? AND k = ?'),
    size: db.prepare('SELECT COUNT(*) AS n FROM markers WHERE ns = ?'),
    insLog: db.prepare('INSERT INTO logs (ns, t, json) VALUES (?, ?, ?)'),
    trimLog: db.prepare(
      'DELETE FROM logs WHERE ns = ? AND id <= (SELECT id FROM logs WHERE ns = ? ORDER BY id DESC LIMIT 1 OFFSET ?)',
    ),
    entries: db.prepare('SELECT json FROM logs WHERE ns = ? AND t >= ? ORDER BY id'),
    sweepCounters: db.prepare('DELETE FROM counters WHERE t < ?'),
    sweepMarkers: db.prepare('DELETE FROM markers WHERE exp < ?'),
    countRows: db.prepare('SELECT ns, COUNT(*) AS n FROM counters GROUP BY ns'),
    trimCounters: db.prepare(
      'DELETE FROM counters WHERE rowid IN (SELECT rowid FROM counters WHERE ns = ? ORDER BY t ASC LIMIT ?)',
    ),
    countMarkers: db.prepare('SELECT ns, COUNT(*) AS n FROM markers GROUP BY ns'),
    trimMarkers: db.prepare(
      'DELETE FROM markers WHERE rowid IN (SELECT rowid FROM markers WHERE ns = ? ORDER BY rowid ASC LIMIT ?)',
    ),
  };

  // Plafond de lignes par espace de noms, vérifié périodiquement et tous les 200 ajouts (un COUNT à chaque ajout coûterait cher).
  const enforceCaps = () => {
    for (const { ns, n } of q.countRows.all())
      if (n > maxEntries) q.trimCounters.run(ns, n - maxEntries);
    for (const { ns, n } of q.countMarkers.all())
      if (n > maxEntries) q.trimMarkers.run(ns, n - maxEntries);
  };
  let writes = 0;
  const wrote = () => {
    if (++writes % 200 === 0) enforceCaps();
  };

  const store = {
    kind: 'sqlite',
    add(ns, key, now, windowMs) {
      q.insCounter.run(ns, key, now);
      wrote();
      return q.count.get(ns, key, now - windowMs).n;
    },
    count: (ns, key, now, windowMs) => q.count.get(ns, key, now - windowMs).n,
    set(ns, key, expiresAt) {
      q.setMarker.run(ns, key, expiresAt);
      wrote();
    },
    take(ns, key, now) {
      const taken = Number(q.takeMarker.run(ns, key, now).changes) > 0;
      if (!taken) q.dropMarker.run(ns, key); // marqueur expiré : le retirer aussi
      return taken;
    },
    size: (ns) => q.size.get(ns).n,
    append(ns, entry) {
      q.insLog.run(ns, entry.t, JSON.stringify(entry));
      q.trimLog.run(ns, ns, LOG_CAP);
    },
    entries: (ns, since = 0) => q.entries.all(ns, since).map((r) => JSON.parse(r.json)),
    sweep(now = Date.now()) {
      q.sweepCounters.run(now - RETAIN_MS);
      q.sweepMarkers.run(now);
      enforceCaps();
    },
    close() {
      clearInterval(timer);
      db.close();
    },
  };
  const timer = setInterval(() => store.sweep(), sweepMs);
  timer.unref();
  return store;
}

/** `spec` : instance déjà créée, « memory » (ou vide), ou « sqlite:chemin/vers/fichier.db ». */
export function createStore(spec, opts = {}) {
  if (spec && typeof spec === 'object') return spec;
  if (!spec || spec === 'memory') return createMemoryStore(opts);
  const m = /^sqlite:(.+)$/.exec(spec);
  if (m) return createSqliteStore(m[1], opts);
  throw new Error(`STORE inconnu : « ${spec} » (attendu : memory ou sqlite:chemin)`);
}
