// Plafonne une Map : au-delà de `max` entrées, supprime les plus anciennes (une Map itère dans l'ordre d'insertion).
// Évite qu'un attaquant qui varie IP, empreintes ou défis fasse grossir la mémoire du serveur sans limite.
export const DEFAULT_MAX_ENTRIES = 100_000;

export function capMap(map, max = DEFAULT_MAX_ENTRIES) {
  while (map.size > max) map.delete(map.keys().next().value);
  return map;
}
