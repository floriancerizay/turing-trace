# Configuration

[English](../configuration.md) · Français

Toutes les options se règlent par variables d'environnement (ou par les options de `createApp` dans `server.js`).

| Variable                  | Défaut    |                                                                                                       |
| ------------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| `CAPTCHA_SECRET`          | aléatoire | secret HMAC ; sans lui, les jetons en cours deviennent invalides à chaque redémarrage                 |
| `CAPTCHA_SECRET_PREVIOUS` | aucun     | ancien(s) secret(s) encore acceptés pour vérifier pendant une rotation, séparés par des virgules      |
| `MIN_SCORE`               | 60        | score minimal pour accepter                                                                           |
| `ALLOWED_ORIGINS`         |           | sites autorisés à charger le widget, séparés par des virgules                                         |
| `RATE_LIMIT`              | 30        | requêtes par minute et par IP sur `/api/*`                                                            |
| `FP_MAX`                  | 5         | validations d'une même empreinte en 10 minutes                                                        |
| `PASS_PER_IP`             | 10        | validations réussies par IP en 10 minutes                                                             |
| `STEP_UP_BITS`            | 4         | bits de preuve de travail ajoutés pour la vérification supplémentaire (16 fois plus de calcul pour 4) |
| `STORE`                   | `memory`  | `sqlite:./data/turing-trace.db` pour que l'état survive au redémarrage                                |
| `ADMIN_TOKEN`             | aucun     | active `GET /api/stats` et la page `admin.html`                                                       |
| `OBSERVE`                 | désactivé | mettre `1` pour le mode observation (voir plus bas)                                                   |
| `SCORE_API`               | désactivé | mettre `1` pour exposer `/api/score` (voir [sécurité](securite.md))                                   |
| `TRUST_PROXY`             | aucun     | sauts de proxy de confiance (`1`), `true`, ou liste d'adresses                                        |
| `MAX_ENTRIES`             | 100000    | plafond de chaque table en mémoire                                                                    |
| `PORT`                    | 3000      |                                                                                                       |

En production : `CAPTCHA_SECRET=$(openssl rand -hex 32) NODE_ENV=production npm start`.

## Rotation du secret

Pour changer `CAPTCHA_SECRET` sans invalider les défis et jetons de passage déjà émis :

1. déployez avec le nouveau secret dans `CAPTCHA_SECRET` et l'ancien dans `CAPTCHA_SECRET_PREVIOUS` ;
2. attendez au moins 5 minutes (durée de vie d'un jeton de passage) ;
3. retirez `CAPTCHA_SECRET_PREVIOUS`.

Les anciens secrets ne servent qu'à vérifier : tout ce qui est émis ensuite est signé avec le nouveau, et un ancien secret retiré n'est plus accepté.

Cela n'a d'effet que si l'état survit au redémarrage (`STORE=sqlite:…`, ou plusieurs instances redémarrées l'une après l'autre sur un stockage partagé). Avec le stockage en mémoire, les défis et jetons en cours sont de toute façon perdus quand le serveur redémarre, quel que soit le secret.

## Mode observation

Mes seuils sont des estimations : ils n'ont jamais été mesurés sur de vrais visiteurs, et les règles tactiles n'ont jamais été essayées sur de vrais téléphones. La façon prudente de déployer est donc de commencer par `OBSERVE=1`.

Le serveur calcule alors chaque décision et la journalise normalement, mais ne bloque personne : la réponse de `/api/verify` accepte toujours, avec `observed: true` (et `wouldReject: true` quand le visiteur aurait été refusé), et le jeton de passage porte `observed`, que `siteverify` et le middleware respectent en ne refusant pas sur le score. Il n'y a pas de vérification supplémentaire en observation.

La page `/admin.html` (avec `ADMIN_TOKEN`) affiche un bandeau rappelant que les refus affichés sont ceux qui auraient eu lieu. Quand les statistiques paraissent saines (peu de refus parmi des visiteurs que vous savez légitimes), retirez `OBSERVE`.

Ce mode ne protège rien : n'y laissez pas un site exposé à des attaques réelles.

## Derrière un reverse proxy

Fixez `TRUST_PROXY`, par exemple `TRUST_PROXY=1` pour un seul proxy devant l'application. Sinon tous les visiteurs ont l'IP du proxy, et les limites par IP comme la liaison des jetons ne servent plus à rien. À l'inverse, ne l'activez pas sans proxy : un visiteur pourrait alors choisir son IP avec l'en-tête `X-Forwarded-For`.

## Regroupement par IP

Les limites et la liaison des jetons comptent par adresse IPv4 ou, en IPv6, par préfixe /64 : un attaquant IPv6 contrôle en général tout son /64 et changerait d'adresse à chaque requête.

## Stockage

Par défaut, nonces, réputation et limites sont gardés en mémoire, plafonnés par `MAX_ENTRIES` (les plus anciennes entrées sont supprimées en premier), et perdus au redémarrage.

`STORE=sqlite:./data/turing-trace.db` les garde dans une base SQLite (module `node:sqlite`, Node 22.13 ou plus récent) : un jeton déjà accepté reste refusé après un redémarrage. SQLite ne partage rien entre plusieurs instances. Pour cela, il faudrait écrire pour Redis une implémentation de l'interface décrite en tête de `lib/store.js` ; je ne l'ai pas testée.

## Statistiques et journal

Avec `ADMIN_TOKEN`, le serveur expose `GET /api/stats` (en-tête `Authorization: Bearer <jeton>`) et la page `/admin.html` : taux d'acceptation, répartition des scores, règles les plus déclenchées et étapes qui refusent le plus, sur les dernières 24 heures. C'est ce qui permet de régler `MIN_SCORE` et les poids sur du vrai trafic plutôt qu'au jugé.

Le journal n'enregistre ni adresse IP, ni empreinte, ni contenu de formulaire : seulement la date, la décision, le score, l'étape qui a refusé et les identifiants des règles déclenchées. Sans `ADMIN_TOKEN`, l'endpoint n'existe pas.

## En-têtes de sécurité

Le serveur envoie une politique de sécurité du contenu stricte (pas de script ni de style en ligne, seuls ses propres fichiers, `api.ipify.org` pour le bouton d'IP), `X-Content-Type-Options`, `Referrer-Policy: no-referrer` et l'interdiction d'être placé dans un cadre.

Le widget, chargé par d'autres sites, n'est pas concerné : une politique s'applique à la page qui la reçoit. Le site d'exemple (`examples/site/`) montre celle à appliquer sur le site qui intègre le widget : un nonce par réponse, et le serveur Turing Trace comme seule origine externe autorisée.
