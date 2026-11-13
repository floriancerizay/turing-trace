# Intégrer Turing Trace à un site

[English](../integration.md) · Français

Trois lignes côté page, une côté backend. Un exemple complet se trouve dans `examples/site/` :

```bash
ALLOWED_ORIGINS=http://localhost:4000 npm start
npm run example    # http://localhost:4000
```

## Le widget

Ajoutez `data-turing-trace` au formulaire et chargez le widget depuis votre serveur Turing Trace :

```html
<form method="post" action="/contact" data-turing-trace>...</form>
<script type="module" src="https://turing-trace.example.org/widget.js"></script>
```

Autorisez ce site côté Turing Trace avec `ALLOWED_ORIGINS=https://monsite.fr`. Sans cela, le navigateur bloque le chargement du widget (CORS) et le formulaire part sans jeton : le middleware de votre backend répond alors `missing-pass`. Le serveur le signale au démarrage quand la variable est vide.

Le widget suit la souris, le tactile et la frappe, ajoute un champ piège invisible et prépare le défi pendant que l'utilisateur remplit le formulaire. À l'envoi, il fait vérifier le jeton puis soumet le formulaire avec un champ caché `turing_trace_pass`.

Si votre page envoie elle-même ses données en JavaScript, mettez `data-turing-trace="event"` et récupérez le jeton dans l'événement `turing-trace:verified` (`event.detail.pass`).

### Un seul fichier, à épingler

Le widget est un fichier unique de 25 Ko environ (construit par `npm run build`), donc une seule requête réseau. Deux adresses :

- `/widget.js` : adresse stable, qui suit les mises à jour du serveur ; mise en cache 5 minutes ;
- `/dist/widget-<empreinte>.js` : le nom contient l'empreinte du contenu, donc le fichier ne change jamais ; mise en cache d'un an.

Pour épingler la version, lisez `/dist/manifest.json` (`file` et `integrity`) et recopiez-les dans la balise :

```html
<script
  type="module"
  src="https://turing-trace.example.org/dist/widget-c06b9faa4c.js"
  integrity="sha384-…"
  crossorigin="anonymous"
></script>
```

Si le serveur Turing Trace était compromis, ou le fichier modifié en route, le navigateur refuse de l'exécuter. Le prix : à chaque mise à jour du widget, il faut recopier le nouveau nom et la nouvelle empreinte. Si vous avez une politique de sécurité du contenu, autorisez l'origine du serveur Turing Trace dans `script-src` et `connect-src`. Le site d'exemple (`examples/site/`) utilise la version épinglée.

### Événements

Le formulaire en émet quatre :

| Événement                  | Quand                                                                             |
| -------------------------- | --------------------------------------------------------------------------------- |
| `turing-trace:verified`    | le visiteur est accepté (`detail.score`, `detail.pass`)                           |
| `turing-trace:rejected`    | le visiteur est refusé ; le formulaire n'est pas envoyé                           |
| `turing-trace:stepup`      | score limite : une vérification supplémentaire d'environ une seconde est en cours |
| `turing-trace:unavailable` | le serveur Turing Trace ne répond pas, ou en plus de 5 secondes                   |

### Si le serveur Turing Trace est en panne

Par défaut, le formulaire n'est pas envoyé et la page peut prévenir le visiteur (événement `unavailable`). Avec `data-turing-trace-fallback="submit"`, il part quand même, sans jeton ; c'est alors le backend du site qui décide (voir `failOpen` ci-dessous).

## Le middleware Express

Le paquet n'est pas publié sur npm. Deux façons de l'utiliser :

- copier `lib/middleware.js` dans votre projet : c'est un seul fichier, sans dépendance, et il suffit de l'importer par son chemin ;
- ou, une fois le dépôt publié sur GitHub, `npm install github:<compte>/turing-trace`, puis `import { requireHuman } from 'turing-trace/middleware'`.

Côté backend, il refuse les requêtes sans jeton valide :

```js
import { requireHuman } from './middleware.js';

app.post(
  '/contact',
  express.urlencoded({ extended: false }),
  requireHuman({ verifyUrl: 'https://turing-trace.example.org/api/siteverify', minScore: 60 }),
  (req, res) => res.send(`Merci (score ${req.turingTrace.score})`),
);
```

Il lit le jeton dans `turing_trace_pass` ou dans l'en-tête `X-Turing-Trace-Pass`.

Quand le serveur Turing Trace est en mode observation, le jeton porte `observed` : le middleware ne refuse pas sur le score et `req.turingTrace.observed` vaut `true`.

Options : `minScore`, `field`, `timeoutMs`, `onReject(req, res, raison)`, `healthUrl`, et `redeem(pass, ip)` pour remplacer l'appel HTTP quand tout tourne dans le même processus.

### Si le serveur Turing Trace ne répond pas

La requête est refusée par défaut. Avec `failOpen: true`, elle passe, marquée `req.turingTrace.unverified` :

- un jeton présent mais impossible à vérifier est accepté ;
- une requête sans jeton n'est acceptée que si le serveur Turing Trace est réellement injoignable (sonde `GET /api/health`). Tant que le service répond, omettre le jeton ne suffit donc pas.

C'est un compromis : pendant une panne, ou une attaque qui rend le service injoignable, le site accepte des requêtes non vérifiées.

## Sans le middleware

Le jeton de passage est valable 5 minutes et ne sert qu'une fois. Votre backend le vérifie ainsi :

```bash
curl -X POST https://turing-trace.example.org/api/siteverify \
  -H 'Content-Type: application/json' \
  -d '{"pass": "...", "remoteip": "203.0.113.7"}'
```

La réponse est `{"success": true, "score": 87}` ou `{"success": false, "error": "..."}`, avec l'une de ces erreurs : `malformed`, `bad-signature`, `expired`, `already-used`, `ip-mismatch`. `remoteip` est facultatif ; s'il est fourni, il doit correspondre à l'IP qui a obtenu le jeton.

Cet appel doit venir de votre serveur, jamais du navigateur.
