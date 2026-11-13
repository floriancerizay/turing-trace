# What the server checks

English · [Français](fr/verification.md)

`POST /api/verify` checks, in order:

1. the trap field is empty;
2. the challenge was signed by this server, for this client (IP, User-Agent, language);
3. the challenge has not been used before;
4. it is between 2 seconds and 2 minutes old;
5. the proof of work is correct;
6. the declared behavior (mouse, touch, keystrokes) is the one described by the raw data attached to the token, and this trajectory has not already been accepted;
7. the declared User-Agent is the one of the request;
8. the `Sec-CH-UA`, `Sec-CH-UA-Platform` and `Accept-Language` headers agree with what the JavaScript declared;
9. the fingerprint and the IP have not been validated too often recently;
10. the score recomputed on the server does not differ by more than 15 points from the one sent;
11. this score reaches `MIN_SCORE`.

The difficulty of the proof of work increases when the same IP requests many challenges.

## Behavior is proven, not declared (step 6)

The token contains the last 300 mouse points and the last 200 keyboard events. The server computes linearity, tremor or rhythm itself, and that result is what goes into the score: an invented summary is rejected.

Keys are not transmitted. Only the rhythm is, and keys are replaced by their order of first appearance. The typed text therefore cannot be reconstructed, but you can see which keystrokes repeat (a rank that comes back).

Replay is only detected for a strictly identical trajectory. The widget clears its recording after every validation so that two successive submissions do not share the same trajectory.

### Mobile

The last 12 touch gestures (at most 30 points each, with contact area and pressure) are attached to the token and recomputed. These are penalized:

- a perfectly straight swipe with no tremor;
- taps that all last the same time, or are almost instantaneous (under 20 ms: a finger does not make a tap faster than that). A browser that heavily rounds its clocks to protect privacy, such as Firefox with strict fingerprinting protection, can trigger this rule wrongly;
- a contact radius that never changes (5 points only: this rule has not been checked on real devices).

Only real touch gestures lift the "no interaction" penalty: the touch flag declared by the page proves nothing.

### AI agents

A browser agent (computer use, Playwright `click` and `fill`) gives itself away differently from a scripted bot: its cursor appears directly on the target with no trajectory, it clicks the exact center of elements and inserts text without any keystroke. Voice dictation also inserts text without keystrokes; the matching rule therefore has a moderate weight.

## HTTP headers against JavaScript (step 8)

A stealth script can rewrite `navigator.userAgentData` in JavaScript, but not the headers that the browser engine builds itself. Firefox and Safari do not send these headers; for them, only the language is compared.

## Tokens bound to the client

The challenge signature includes a fingerprint of the connection (IP, User-Agent, language). A token solved by a human on another device and then relayed to a bot (a CAPTCHA farm) fails the signature check. The pass token is bound to the IP in the same way.

## Borderline score: extra verification

A borderline score is not refused right away. If it is between `MIN_SCORE - 20` and `MIN_SCORE`, with no sign of automation (no rule of the "automation" group fired), the server offers a new challenge, signed as a step-up challenge, with a heavier proof of work (`STEP_UP_BITS`). If the visitor solves it, the same behavior is accepted with a threshold lowered by 20 points.

This reduces false positives (virtual machine, voice dictation, keyboard navigation) without opening the door to detected robots: the step-up challenge cannot be fabricated, cannot be disguised as a normal challenge, and is offered only once.
