# Integrating Turing Trace into a site

English · [Français](fr/integration.md)

Three lines on the page, one on the backend. A complete example is in `examples/site/`:

```bash
ALLOWED_ORIGINS=http://localhost:4000 npm start
npm run example    # http://localhost:4000
```

## The widget

Add `data-turing-trace` to the form and load the widget from your Turing Trace server:

```html
<form method="post" action="/contact" data-turing-trace>...</form>
<script type="module" src="https://turing-trace.example.org/widget.js"></script>
```

Allow this site on the Turing Trace side with `ALLOWED_ORIGINS=https://mysite.com`. Without it, the browser blocks the widget loading (CORS) and the form is sent without a token: your backend's middleware then answers `missing-pass`. The server warns about it at startup when the variable is empty.

The widget follows the mouse, touch and keystrokes, adds an invisible trap field and prepares the challenge while the user fills in the form. On submit, it has the token verified and then submits the form with a hidden `turing_trace_pass` field.

If your page sends its own data in JavaScript, use `data-turing-trace="event"` and read the token from the `turing-trace:verified` event (`event.detail.pass`).

### One file, which you can pin

The widget is a single file of about 25 KB (built by `npm run build`), so one network request. Two addresses:

- `/widget.js`: the stable address, which follows the server's updates; cached for 5 minutes;
- `/dist/widget-<hash>.js`: the name contains the hash of the content, so the file never changes; cached for a year.

To pin the version, read `/dist/manifest.json` (`file` and `integrity`) and copy them into the tag:

```html
<script
  type="module"
  src="https://turing-trace.example.org/dist/widget-c06b9faa4c.js"
  integrity="sha384-…"
  crossorigin="anonymous"
></script>
```

If the Turing Trace server were compromised, or the file modified in transit, the browser refuses to run it. The price: at every widget update you must copy the new name and hash. If you have a content security policy, allow the Turing Trace server's origin in `script-src` and `connect-src`. The example site (`examples/site/`) uses the pinned version.

### Events

The form emits four:

| Event                      | When                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| `turing-trace:verified`    | the visitor is accepted (`detail.score`, `detail.pass`)               |
| `turing-trace:rejected`    | the visitor is refused; the form is not sent                          |
| `turing-trace:stepup`      | borderline score: an extra verification of about a second is running  |
| `turing-trace:unavailable` | the Turing Trace server does not answer, or takes more than 5 seconds |

### If the Turing Trace server is down

By default, the form is not sent and the page can warn the visitor (`unavailable` event). With `data-turing-trace-fallback="submit"`, it is sent anyway, without a token; the site's backend then decides (see `failOpen` below).

## The Express middleware

The package is not published on npm. Two ways to use it:

- copy `lib/middleware.js` into your project: it is a single file with no dependencies, and you only need to import it by its path;
- or, once the repository is published on GitHub, `npm install github:<account>/turing-trace`, then `import { requireHuman } from 'turing-trace/middleware'`.

On the backend, it rejects requests without a valid token:

```js
import { requireHuman } from './middleware.js';

app.post(
  '/contact',
  express.urlencoded({ extended: false }),
  requireHuman({ verifyUrl: 'https://turing-trace.example.org/api/siteverify', minScore: 60 }),
  (req, res) => res.send(`Thanks (score ${req.turingTrace.score})`),
);
```

It reads the token from `turing_trace_pass` or from the `X-Turing-Trace-Pass` header.

When the Turing Trace server is in observation mode, the token carries `observed`: the middleware does not reject on score and `req.turingTrace.observed` is `true`.

Options: `minScore`, `field`, `timeoutMs`, `onReject(req, res, reason)`, `healthUrl`, and `redeem(pass, ip)` to replace the HTTP call when everything runs in the same process.

### If the Turing Trace server does not answer

The request is rejected by default. With `failOpen: true`, it goes through, marked `req.turingTrace.unverified`:

- a token that is present but cannot be verified is accepted;
- a request without a token is accepted only if the Turing Trace server is genuinely unreachable (probe `GET /api/health`). As long as the service answers, omitting the token is therefore not enough.

It is a trade-off: during an outage, or an attack that makes the service unreachable, the site accepts unverified requests.

## Without the middleware

The pass token is valid for 5 minutes and can be used only once. Your backend verifies it like this:

```bash
curl -X POST https://turing-trace.example.org/api/siteverify \
  -H 'Content-Type: application/json' \
  -d '{"pass": "...", "remoteip": "203.0.113.7"}'
```

The response is `{"success": true, "score": 87}` or `{"success": false, "error": "..."}`, with one of these errors: `malformed`, `bad-signature`, `expired`, `already-used`, `ip-mismatch`. `remoteip` is optional; if given, it must match the IP that obtained the token.

This call must come from your server, never from the browser.
