<img src="docs/logo.svg" alt="" width="96" height="96">

# Turing Trace

English · [Français](README.fr.md)

A CAPTCHA with no test to pass. The browser collects signals (hardware, mouse, touch and keyboard behavior, signs of automation), turns them into a score from 0 to 100, and an Express server checks everything before accepting the form.

## Getting started

```bash
npm install
npm start          # http://localhost:3000
npm test
```

In production, set `CAPTCHA_SECRET` and, behind a reverse proxy, `TRUST_PROXY`. For a first deployment, `OBSERVE=1` logs decisions without blocking anyone, so you can tune the thresholds on real traffic. All options are described in the [configuration guide](guide/configuration.md).

MIT license.

## Protecting a form

On the page, add `data-turing-trace` to the form and load the widget from your Turing Trace server:

```html
<form method="post" action="/contact" data-turing-trace>...</form>
<script type="module" src="https://turing-trace.example.org/widget.js"></script>
```

Allow this site on the Turing Trace side with `ALLOWED_ORIGINS=https://mysite.com`. Without it, the browser blocks the widget and the form is sent without a token.

On the backend, the middleware rejects requests without a valid token. The package is not published on npm: copy `lib/middleware.js` (a single file with no dependencies) or install it from the repository (see the [integration guide](guide/integration.md)).

```js
import { requireHuman } from './middleware.js';

app.post(
  '/contact',
  express.urlencoded({ extended: false }),
  requireHuman({ verifyUrl: 'https://turing-trace.example.org/api/siteverify', minScore: 60 }),
  (req, res) => res.send(`Thanks (score ${req.turingTrace.score})`),
);
```

A complete example is in `examples/site/` (`npm run example`).

## Limits

Anything computed by the browser can be forged by someone who has read the code. The server checks that the signals agree with each other and recomputes behavior itself from raw data, but it cannot prove they are true. Signed challenges, proof of work and rate limits make an attack more expensive without making it impossible. What is blocked and what still gets through is detailed in the [security guide](guide/security.md).

Fingerprints can identify a browser: inform your visitors and keep only the score.

## Going further

- [Configuration](guide/configuration.md): variables, proxy, secret rotation, SQLite storage, statistics, security headers
- [Integration](guide/integration.md): widget, events, service outage, middleware, verification API
- [Verification](guide/verification.md): the server's checks, mobile, AI agents, extra verification
- [Security](guide/security.md): limits, penetration tests, privacy, accessibility
- [Development](guide/development.md): code layout, translations, GitHub Pages demo, tests

## License

MIT (see `LICENSE`).
