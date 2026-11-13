// Clé de regroupement d'un client à partir de son adresse IP.
// Un attaquant IPv6 contrôle en général un préfixe /64 entier (2^64 adresses) : compter par adresse exacte laisserait
// contourner toutes les limites. IPv4 est gardée telle quelle ; « ::ffff:1.2.3.4 » désigne le même client que « 1.2.3.4 ».

const MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Remplace un suffixe IPv4 pointé (« ::1.2.3.4 ») par deux groupes hexadécimaux. */
function expandDotted(groups) {
  const last = groups[groups.length - 1];
  if (!last || !last.includes('.')) return groups;
  const parts = last.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !(n >= 0 && n <= 255))) return groups;
  const hex = (a, b) => ((a << 8) | b).toString(16);
  return [...groups.slice(0, -1), hex(parts[0], parts[1]), hex(parts[2], parts[3])];
}

export function clientKey(ip) {
  const s = String(ip ?? '')
    .trim()
    .replace(/%.*$/, '')
    .toLowerCase();
  const mapped = s.match(MAPPED);
  if (mapped) return mapped[1];
  if (!s.includes(':')) return s || 'unknown'; // IPv4 (ou valeur inconnue)

  let groups;
  if (s.includes('::')) {
    const [head, tail] = s.split('::');
    const left = expandDotted(head ? head.split(':') : []);
    const right = expandDotted(tail ? tail.split(':') : []);
    groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  } else {
    groups = expandDotted(s.split(':'));
  }
  const prefix = groups.slice(0, 4).map((g) => (parseInt(g || '0', 16) || 0).toString(16));
  return `${prefix.join(':')}::/64`;
}
