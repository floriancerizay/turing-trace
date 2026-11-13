# Security, limits and privacy

English · [Français](fr/securite.md)

## Limits

Anything computed by the browser can be forged by someone who has read the code. The server checks that the signals agree with each other, not that they are true. Signed challenges, proof of work and rate limits make an attack more expensive without making it impossible.

To go further, you would need signals out of the browser's reach: TLS fingerprint, IP address reputation, behavior across a whole session. Detecting generated trajectories would require a statistical model trained on real traffic.

## Deploy carefully

Start with `OBSERVE=1` mode (see [configuration](configuration.md)): the default thresholds have not been measured on real visitors.

## Testing your own defenses

The `redteam/attacks.mjs` script replays increasingly careful attacks against your own instance. It only targets localhost:

```bash
RATE_LIMIT=1000 SCORE_API=1 npm start
CHROMIUM_PATH=/path/to/chrome node redteam/attacks.mjs http://127.0.0.1:3000
```

`RATE_LIMIT=1000` prevents the rate limiter from interrupting the script. `SCORE_API=1` enables the oracle below, needed to test the attack that exploits it. Restart a fresh server for every run: reputation remembers earlier validations.

It currently blocks naive bots, replay of a token or of an identical trajectory, forged scores and behavior summaries, headless browsers even disguised in JavaScript, AI agents, tokens resold by CAPTCHA farms and mass submission of the same fingerprint.

Four attacks get through:

- fabricating, without a browser, a plausible trajectory and typing rhythm: the server can no longer be fooled by invented numbers, but a script that generates irregular curves gets through;
- replaying a recorded trajectory with ±1 px of noise, because only a strictly identical trajectory is recognized;
- using `/api/score` to learn which rules to remove;
- driving a browser whose identity is modified at the engine level, with simulated gestures.

### The `/api/score` oracle

It returns the score breakdown without consuming the challenge. That is handy for testing, but it also informs an attacker: it is therefore disabled until `SCORE_API=1` is set. Do not enable it in production.

## Privacy

The collected fingerprints can identify a browser. Inform your visitors (GDPR, ePrivacy) and keep only the score. The decision log records no personal data (see [configuration](configuration.md)).

The demo contacts no third party, except ipify when you click "Show my public IP". Pico CSS is copied into `docs/vendor/` (MIT license) rather than loaded from a CDN.

## Accessibility

There is no visual test. Not using a mouse costs only 10 points, so as not to penalize people who navigate by keyboard or with a screen reader.
