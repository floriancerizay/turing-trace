<img src="docs/logo.svg" alt="" width="96" height="96">

# Turing Trace

[English](README.md) · Français

Un CAPTCHA sans test à passer. Le navigateur collecte des signaux (matériel, comportement de la souris, du tactile et du clavier, indices d'automatisation), en tire un score de 0 à 100, et un serveur Express vérifie le tout avant d'accepter le formulaire.

## Démarrer

```bash
npm install
npm start          # http://localhost:3000
npm test
```

En production, fixez `CAPTCHA_SECRET` et, derrière un reverse proxy, `TRUST_PROXY`. Pour un premier déploiement, `OBSERVE=1` journalise les décisions sans bloquer personne, le temps de régler les seuils sur du vrai trafic. Toutes les options sont décrites dans la [configuration](guide/fr/configuration.md).

Licence MIT.

## Protéger un formulaire

Sur la page, ajoutez `data-turing-trace` au formulaire et chargez le widget depuis votre serveur Turing Trace :

```html
<form method="post" action="/contact" data-turing-trace>...</form>
<script type="module" src="https://turing-trace.example.org/widget.js"></script>
```

Autorisez ce site côté Turing Trace avec `ALLOWED_ORIGINS=https://monsite.fr`. Sans cela, le navigateur bloque le widget et le formulaire part sans jeton.

Côté backend, le middleware refuse les requêtes sans jeton valide. Le paquet n'est pas publié sur npm : copiez `lib/middleware.js` (un seul fichier, sans dépendance) ou installez-le depuis le dépôt (voir l'[intégration](guide/fr/integration.md)).

```js
import { requireHuman } from './middleware.js';

app.post(
  '/contact',
  express.urlencoded({ extended: false }),
  requireHuman({ verifyUrl: 'https://turing-trace.example.org/api/siteverify', minScore: 60 }),
  (req, res) => res.send(`Merci (score ${req.turingTrace.score})`),
);
```

Un exemple complet se trouve dans `examples/site/` (`npm run example`).

## Limites

Tout ce que calcule le navigateur peut être falsifié par quelqu'un qui a lu le code. Le serveur vérifie que les signaux sont cohérents entre eux et recalcule lui-même le comportement à partir de données brutes, mais il ne peut pas prouver qu'ils sont vrais. Les défis signés, la preuve de travail et les limites de fréquence rendent l'attaque plus coûteuse, sans la rendre impossible. Le détail de ce qui est bloqué et de ce qui passe encore est dans [sécurité](guide/fr/securite.md).

Les empreintes permettent d'identifier un navigateur : informez vos visiteurs et ne conservez que le score.

## Pour aller plus loin

- [Configuration](guide/fr/configuration.md) : variables, proxy, stockage SQLite, statistiques, en-têtes de sécurité
- [Intégration](guide/fr/integration.md) : widget, événements, panne du service, middleware, API de vérification
- [Vérification](guide/fr/verification.md) : les étapes du serveur, mobile, agents IA, vérification supplémentaire
- [Sécurité](guide/fr/securite.md) : limites, tests d'intrusion, vie privée, accessibilité
- [Développement](guide/fr/developpement.md) : organisation du code, traductions, démo GitHub Pages, tests

## Licence

MIT (voir `LICENSE`).
