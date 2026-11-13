# Development

English · [Français](fr/developpement.md)

## Code layout

- `docs/js/fingerprint.js`: collection (WebGL, WebGPU, canvas, audio, fonts, Client Hints, permissions, voices, codecs, preferences, network, storage)
- `docs/js/behavior.js`: mouse, touch, keystrokes, and signals specific to AI agents
- `docs/js/signals.js`: summary of signals and raw data attached to the token
- `docs/js/scoring.js`: the rules and their weights, used by the browser and by the server
- `docs/js/verify.js`: the verification steps, shared as well
- `docs/js/widget.js`: the widget to embed (source; `docs/dist/` holds its built version)
- `docs/js/i18n.js`: all the demo's texts, in English and French
- `scripts/build-widget.mjs`: builds the widget into a single file
- `lib/`: tokens, reputation, storage, log, header checks, middleware
- `redteam/`: attacks and human gesture generators, also used by the tests
- `examples/site/`: a site that embeds the widget

## The widget in a single file

The widget sources are modules (`docs/js/widget.js` and its imports). `npm run build` bundles them with esbuild into `docs/dist/widget-<hash>.js` and writes `docs/dist/manifest.json` (file name and integrity hash). This output is versioned, so the repository can be used without a build step. A test fails when the sources have changed without a rebuild: run `npm run build` then.

## Translations

The modules shared with the server (`scoring.js`, `verify.js`) contain no text: they return identifiers and parameters, which the page translates. To add a language, one more dictionary in `i18n.js` is enough; `npm test` reports missing keys.

## The demo on GitHub Pages

The `.github/workflows/pages.yml` workflow publishes `docs/` on every push to `main`. You must have chosen "GitHub Actions" as the source in the repository's Pages settings.

Without a server, the page switches to demo mode: verification is simulated in the browser and protects nothing. You can force the mode with `?mode=demo` or `?mode=server`.

## Tests

```bash
npm test                                             # rules, tokens, storage, API, middleware, translations
CHROMIUM_PATH=/path/to/chrome npm run test:e2e       # in a real browser, including the widget on a third-party site
```

The browser tests cover the demo, touch, the widget (outage, step-up, integrity), the admin page and the security policy. In CI, `.github/workflows/ci.yml` installs Chromium and runs both.
