# Configuration

English · [Français](fr/configuration.md)

Every option is set through environment variables (or through the options of `createApp` in `server.js`).

| Variable                  | Default  |                                                                                              |
| ------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `CAPTCHA_SECRET`          | random   | HMAC secret; without it, tokens in flight become invalid at every restart                    |
| `CAPTCHA_SECRET_PREVIOUS` | none     | old secret(s) still accepted for verification during a rotation, comma-separated             |
| `MIN_SCORE`               | 60       | minimum score to accept                                                                      |
| `ALLOWED_ORIGINS`         |          | sites allowed to load the widget, comma-separated                                            |
| `RATE_LIMIT`              | 30       | requests per minute per IP on `/api/*`                                                       |
| `FP_MAX`                  | 5        | validations of the same fingerprint in 10 minutes                                            |
| `PASS_PER_IP`             | 10       | successful validations per IP in 10 minutes                                                  |
| `STEP_UP_BITS`            | 4        | proof-of-work bits added for the extra verification (4 bits means 16 times more computation) |
| `STORE`                   | `memory` | `sqlite:./data/turing-trace.db` so that state survives a restart                             |
| `ADMIN_TOKEN`             | none     | enables `GET /api/stats` and the `admin.html` page                                           |
| `OBSERVE`                 | off      | set to `1` for observation mode (see below)                                                  |
| `SCORE_API`               | off      | set to `1` to expose `/api/score` (see [security](security.md))                              |
| `TRUST_PROXY`             | none     | number of trusted proxy hops (`1`), `true`, or a list of addresses                           |
| `MAX_ENTRIES`             | 100000   | cap on each in-memory table                                                                  |
| `PORT`                    | 3000     |                                                                                              |

In production: `CAPTCHA_SECRET=$(openssl rand -hex 32) NODE_ENV=production npm start`.

## Secret rotation

To change `CAPTCHA_SECRET` without invalidating the challenges and pass tokens already issued:

1. deploy with the new secret in `CAPTCHA_SECRET` and the old one in `CAPTCHA_SECRET_PREVIOUS`;
2. wait at least 5 minutes (the lifetime of a pass token);
3. remove `CAPTCHA_SECRET_PREVIOUS`.

Old secrets are only used to verify: everything issued afterwards is signed with the new one, and an old secret that has been removed is no longer accepted.

This only matters if state survives the restart (`STORE=sqlite:…`, or several instances restarted one after another on a shared store). With in-memory storage, the challenges and tokens in flight are lost when the server restarts anyway, whatever the secret.

## Observation mode

My thresholds are estimates: they have never been measured on real visitors, and the touch rules have never been tried on real phones. The careful way to deploy is therefore to start with `OBSERVE=1`.

The server then computes and logs every decision as usual but blocks nobody: the response of `/api/verify` always accepts, with `observed: true` (and `wouldReject: true` when the visitor would have been refused), and the pass token carries `observed`, which `siteverify` and the middleware honor by not rejecting on score. There is no extra verification in observation mode.

The `/admin.html` page (with `ADMIN_TOKEN`) shows a banner reminding you that the refusals displayed are the ones that would have happened. When the statistics look healthy (few refusals among visitors you know are legitimate), remove `OBSERVE`.

This mode protects nothing: do not leave a site exposed to real attacks in it.

## Behind a reverse proxy

Set `TRUST_PROXY`, for example `TRUST_PROXY=1` for a single proxy in front of the application. Otherwise every visitor has the proxy's IP, and the per-IP limits and the token binding become useless. Conversely, do not enable it without a proxy: a visitor could then choose their own IP with the `X-Forwarded-For` header.

## Grouping by IP

Limits and token binding count per IPv4 address or, for IPv6, per /64 prefix: an IPv6 attacker usually controls their whole /64 and would change address on every request.

## Storage

By default, nonces, reputation and limits are kept in memory, capped by `MAX_ENTRIES` (the oldest entries are dropped first), and lost on restart.

`STORE=sqlite:./data/turing-trace.db` keeps them in an SQLite database (the `node:sqlite` module, Node 22.13 or newer): a token that was already accepted stays refused after a restart. SQLite shares nothing between several instances. For that, you would write a Redis implementation of the interface described at the top of `lib/store.js`; I have not tested one.

## Statistics and log

With `ADMIN_TOKEN`, the server exposes `GET /api/stats` (header `Authorization: Bearer <token>`) and the `/admin.html` page: acceptance rate, score distribution, most triggered rules and steps that reject the most, over the last 24 hours. This is what lets you tune `MIN_SCORE` and the weights on real traffic instead of guessing.

The log records no IP address, no fingerprint and no form content: only the date, the decision, the score, the step that refused and the identifiers of the rules that fired. Without `ADMIN_TOKEN`, the endpoint does not exist.

## Security headers

The server sends a strict content security policy (no inline script or style, only its own files, `api.ipify.org` for the IP button), `X-Content-Type-Options`, `Referrer-Policy: no-referrer` and a ban on being placed in a frame.

The widget, which other sites load, is not affected: a policy applies to the document that receives it, not to the scripts it loads. The example site (`examples/site/`) shows the one to apply on the site that embeds the widget: a nonce per response, and the Turing Trace server as the only allowed external origin.
