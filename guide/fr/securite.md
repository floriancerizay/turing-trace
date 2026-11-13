# Sécurité, limites et vie privée

[English](../security.md) · Français

## Limites

Tout ce que calcule le navigateur peut être falsifié par quelqu'un qui a lu le code. Le serveur vérifie que les signaux sont cohérents entre eux, pas qu'ils sont vrais. Les défis signés, la preuve de travail et les limites de fréquence rendent l'attaque plus coûteuse, sans la rendre impossible.

Pour aller plus loin, il faudrait des signaux hors de portée du navigateur : empreinte TLS, réputation des adresses IP, comportement sur toute la session. Détecter les trajectoires générées demanderait un modèle statistique entraîné sur du vrai trafic.

## Déployer prudemment

Commencez par le mode `OBSERVE=1` (voir [configuration](configuration.md)) : les seuils par défaut n'ont pas été mesurés sur de vrais visiteurs.

## Tester ses propres défenses

Le script `redteam/attacks.mjs` rejoue des attaques de plus en plus soignées contre votre propre instance. Il ne cible que localhost :

```bash
RATE_LIMIT=1000 SCORE_API=1 npm start
CHROMIUM_PATH=/chemin/vers/chrome node redteam/attacks.mjs http://127.0.0.1:3000
```

`RATE_LIMIT=1000` évite que le limiteur de débit interrompe le script. `SCORE_API=1` active l'oracle ci-dessous, nécessaire pour tester l'attaque qui l'exploite. Relancez un serveur neuf à chaque exécution : la réputation garde en mémoire les validations précédentes.

Il bloque actuellement les bots naïfs, le rejeu d'un jeton ou d'une trajectoire identique, les scores et résumés de comportement falsifiés, les navigateurs headless même maquillés en JavaScript, les agents IA, les jetons revendus par des fermes à CAPTCHA et l'envoi massif d'une même empreinte.

Quatre attaques passent :

- fabriquer sans navigateur une trajectoire et un rythme de frappe plausibles : le serveur ne peut plus être trompé par de simples chiffres inventés, mais un script qui génère des courbes irrégulières passe ;
- rejouer une trajectoire enregistrée avec un bruit de ±1 px, car seule une trajectoire strictement identique est reconnue ;
- utiliser `/api/score` pour savoir quelles règles retirer ;
- piloter un navigateur dont l'identité est modifiée au niveau du moteur, avec des gestes simulés.

### L'oracle `/api/score`

Il renvoie le détail du score sans consommer le défi. C'est pratique pour tester, mais cela renseigne aussi un attaquant : il est donc désactivé tant que `SCORE_API=1` n'est pas défini. Ne l'activez pas en production.

## Vie privée

Les empreintes collectées permettent d'identifier un navigateur. Informez vos visiteurs (RGPD, ePrivacy) et ne conservez que le score. Le journal des décisions n'enregistre aucune donnée personnelle (voir [configuration](configuration.md)).

La démo ne contacte aucun tiers, sauf ipify quand on clique sur « Afficher mon IP publique ». Pico CSS est copié dans `docs/vendor/` (licence MIT) plutôt que chargé depuis un CDN.

## Accessibilité

Il n'y a aucun test visuel. Ne pas utiliser de souris ne coûte que 10 points, pour ne pas pénaliser les personnes qui naviguent au clavier ou avec un lecteur d'écran.
