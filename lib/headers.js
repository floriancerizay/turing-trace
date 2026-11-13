// Compare les en-têtes HTTP envoyés par le moteur du navigateur aux signaux déclarés par le JavaScript de la page.
// Un script de furtivité peut réécrire navigator.userAgentData ou navigator.languages, mais pas les en-têtes
// Sec-CH-UA* et Accept-Language que Chromium construit lui-même.

const brandNames = (list) =>
  new Set(list.map((b) => b.trim()).filter((b) => b && !/Not.?A.?Brand/i.test(b)));

/** Marques de l'en-tête Sec-CH-UA : `"Chromium";v="130", "Google Chrome";v="130"` → Set des noms. */
export const parseSecChUa = (h) =>
  brandNames([...String(h || '').matchAll(/"([^"]+)";\s*v=/g)].map((m) => m[1]));

/**
 * @param {object} h       en-têtes de la requête (noms en minuscules)
 * @param {object} s       signaux déclarés par le navigateur
 * @param {boolean} secure contexte sécurisé (HTTPS ou localhost) : seul cas où Chromium envoie les Client Hints
 * @returns {[boolean, string, object]} au format des étapes de verify.js
 */
export function checkHeaders(h, s, secure) {
  const codes = [];
  const chua = h['sec-ch-ua'];
  const platform = h['sec-ch-ua-platform']?.replace(/"/g, '');

  if (chua && /Headless/i.test(chua)) codes.push('headless_brand');

  if (s.uachPlatform) {
    // Le JavaScript expose userAgentData (moteur Chromium) : le moteur doit aussi envoyer les en-têtes.
    if (!chua && secure) codes.push('hints_missing');
    if (platform && platform !== s.uachPlatform)
      codes.push(`platform|${s.uachPlatform}|${platform}`);
    if (chua && s.uachBrands) {
      const js = brandNames(s.uachBrands.split(',').map((b) => b.replace(/\s+[\d.]+$/, '')));
      const http = parseSecChUa(chua);
      const same = js.size === http.size && [...js].every((b) => http.has(b));
      if (!same) codes.push(`brand_mismatch|${[...js].join(' + ')}|${[...http].join(' + ')}`);
    }
  }

  const al = String(h['accept-language'] || '')
    .split(',')[0]
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (al && al !== '*' && s.lang && al.split('-')[0] !== String(s.lang).split('-')[0].toLowerCase())
    codes.push(`lang|${s.lang}|${al}`);

  return codes.length ? [false, 'mismatch', { codes }] : [true, 'ok'];
}
