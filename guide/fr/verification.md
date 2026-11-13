# Ce que vérifie le serveur

[English](../verification.md) · Français

`POST /api/verify` contrôle, dans l'ordre :

1. le champ piège est vide ;
2. le défi a bien été signé par ce serveur, pour ce client (IP, User-Agent, langue) ;
3. le défi n'a pas déjà servi ;
4. il a entre 2 secondes et 2 minutes ;
5. la preuve de travail est correcte ;
6. le comportement déclaré (souris, tactile, frappe) est bien celui que décrivent les données brutes jointes au jeton, et cette trajectoire n'a pas déjà été acceptée ;
7. le User-Agent déclaré est celui de la requête ;
8. les en-têtes `Sec-CH-UA`, `Sec-CH-UA-Platform` et `Accept-Language` concordent avec ce que le JavaScript a déclaré ;
9. l'empreinte et l'IP n'ont pas été validées trop souvent récemment ;
10. le score recalculé côté serveur ne s'écarte pas de plus de 15 points de celui envoyé ;
11. ce score atteint `MIN_SCORE`.

La difficulté de la preuve de travail augmente quand une même IP demande beaucoup de défis.

## Le comportement est prouvé, pas déclaré (point 6)

Le jeton contient les 300 derniers points de souris et les 200 derniers événements de frappe. Le serveur calcule lui-même la linéarité, le tremblement ou le rythme, et c'est ce résultat qui entre dans le score : un résumé inventé est refusé.

Les touches ne sont pas transmises. Seul le rythme l'est, et les touches sont remplacées par leur ordre de première apparition. On ne peut donc pas reconstituer le texte, mais on voit quelles frappes se répètent (un rang qui revient).

Le rejeu n'est détecté que pour une trajectoire strictement identique. Le widget vide son enregistrement après chaque validation pour que deux envois successifs ne partagent pas la même trajectoire.

### Mobile

Les 12 derniers gestes tactiles (30 points au plus chacun, avec la surface de contact et la pression) sont joints au jeton et recalculés. Sont pénalisés :

- un glissement parfaitement droit et sans tremblement ;
- des tapes toutes de la même durée, ou quasi instantanées (moins de 20 ms : un doigt ne pose pas une tape plus vite). Un navigateur qui arrondit fortement les horloges pour protéger la vie privée, comme Firefox avec la protection anti-pistage renforcée, peut déclencher cette règle à tort ;
- un rayon de contact qui ne change jamais (5 points seulement : cette règle n'a pas été vérifiée sur des appareils réels).

Seuls de vrais gestes tactiles lèvent la pénalité « aucune interaction » : le drapeau tactile déclaré par la page ne prouve rien.

### Agents IA

Un agent de navigateur (computer use, Playwright `click` et `fill`) se trahit autrement qu'un bot scripté : son curseur apparaît directement sur la cible sans trajectoire, il clique au centre exact des éléments et insère le texte sans aucune frappe. La dictée vocale insère aussi du texte sans frappe ; la règle correspondante a donc un poids modéré.

## En-têtes HTTP contre JavaScript (point 8)

Un script de furtivité peut réécrire `navigator.userAgentData` en JavaScript, pas les en-têtes que le moteur du navigateur construit lui-même. Firefox et Safari n'envoient pas ces en-têtes ; pour eux, seule la langue est comparée.

## Jetons liés au client

La signature du défi inclut une empreinte de la connexion (IP, User-Agent, langue). Un jeton résolu par un humain sur un autre appareil, puis relayé à un bot (ferme à CAPTCHA), échoue à la vérification de signature. Le jeton de passage est lié à l'IP de la même façon.

## Score limite : vérification supplémentaire

Un score limite n'est pas refusé tout de suite. S'il est entre `MIN_SCORE - 20` et `MIN_SCORE`, sans signe d'automatisation (aucune règle du groupe « automatisation » déclenchée), le serveur propose un nouveau défi, signé comme défi de palier, dont la preuve de travail est plus lourde (`STEP_UP_BITS`). Si le visiteur la résout, le même comportement est accepté avec un seuil abaissé de 20 points.

Cela réduit les faux positifs (machine virtuelle, dictée vocale, navigation au clavier) sans ouvrir la porte aux robots détectés : le défi de palier ne se fabrique pas, ne se déguise pas en défi normal, et n'est proposé qu'une fois.
