# Développement

[English](../development.md) · Français

## Organisation du code

- `docs/js/fingerprint.js` : collecte (WebGL, WebGPU, canvas, audio, polices, Client Hints, permissions, voix, codecs, préférences, réseau, stockage)
- `docs/js/behavior.js` : souris, tactile, frappe, et signaux propres aux agents IA
- `docs/js/signals.js` : résumé des signaux et données brutes joints au jeton
- `docs/js/scoring.js` : les règles et leurs poids, utilisées par le navigateur et par le serveur
- `docs/js/verify.js` : les étapes de vérification, partagées elles aussi
- `docs/js/widget.js` : le widget à intégrer (source ; `docs/dist/` contient sa version construite)
- `scripts/build-widget.mjs` : construction du widget en un seul fichier
- `docs/js/i18n.js` : tous les textes de la démo, en anglais et en français
- `lib/` : jetons, réputation, stockage, journal, contrôle des en-têtes, middleware
- `redteam/` : attaques et générateurs de gestes humains, utilisés aussi par les tests
- `examples/site/` : un site qui intègre le widget

## Le widget en un seul fichier

Les sources du widget sont des modules (`docs/js/widget.js` et ses imports). `npm run build` les assemble avec esbuild dans `docs/dist/widget-<empreinte>.js` et écrit `docs/dist/manifest.json` (nom du fichier et empreinte d'intégrité). Ce résultat est versionné, pour qu'on puisse utiliser le dépôt sans étape de construction. Un test échoue quand les sources ont changé sans reconstruction : lancez alors `npm run build`.

## Traductions

Les modules partagés avec le serveur (`scoring.js`, `verify.js`) ne contiennent aucun texte : ils renvoient des identifiants et des paramètres, que la page traduit. Pour ajouter une langue, il suffit d'un dictionnaire de plus dans `i18n.js` ; `npm test` signale les clés manquantes.

## La démo sur GitHub Pages

Le workflow `.github/workflows/pages.yml` publie `docs/` à chaque push sur `main`. Il faut avoir choisi « GitHub Actions » comme source dans les réglages Pages du dépôt.

Sans serveur, la page passe en mode démo : la vérification est simulée dans le navigateur et ne protège rien. On peut forcer le mode avec `?mode=demo` ou `?mode=server`.

## Tests

```bash
npm test                                             # règles, jetons, stockage, API, middleware, traductions
CHROMIUM_PATH=/chemin/vers/chrome npm run test:e2e   # dans un vrai navigateur, y compris le widget sur un site tiers
```

Les tests en navigateur couvrent la démo, le tactile, le widget (panne, palier), la page d'administration et la politique de sécurité. En CI, `.github/workflows/ci.yml` installe Chromium et lance les deux.
