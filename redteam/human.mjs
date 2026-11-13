// Gestes « humains » pour Playwright : trajectoire courbe bruitée vers un point quelconque de la cible, appui de durée variable.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pos = new WeakMap();

export async function humanMove(page, tx, ty) {
  const [x, y] = pos.get(page) || [60 + Math.random() * 200, 80 + Math.random() * 200];
  const cx = (x + tx) / 2 + (Math.random() - 0.5) * 220,
    cy = (y + ty) / 2 + (Math.random() - 0.5) * 220;
  const steps = 18 + Math.floor(Math.random() * 14);
  for (let i = 1; i <= steps; i++) {
    const u = i / steps,
      e = u * u * (3 - 2 * u);
    await page.mouse.move(
      (1 - e) ** 2 * x + 2 * (1 - e) * e * cx + e * e * tx + (Math.random() - 0.5) * 1.8,
      (1 - e) ** 2 * y + 2 * (1 - e) * e * cy + e * e * ty + (Math.random() - 0.5) * 1.8,
    );
    await wait(5 + Math.random() * 14);
  }
  pos.set(page, [tx, ty]);
}

export async function humanClick(page, selector) {
  // Centrer la cible (le bandeau fixe peut masquer le haut de la page), puis viser dans sa zone visible.
  await page.locator(selector).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await wait(150);
  const box = await page.locator(selector).boundingBox();
  const tx = box.x + box.width * (0.25 + Math.random() * 0.5) + 2;
  const ty = box.y + box.height * (0.3 + Math.random() * 0.4) + 1;
  await humanMove(page, tx, ty);
  await wait(60 + Math.random() * 120);
  await page.mouse.down();
  await wait(50 + Math.random() * 70);
  await page.mouse.up();
}

export async function humanType(page, text) {
  for (const ch of text) {
    await page.keyboard.down(ch);
    await wait(55 + Math.random() * 70);
    await page.keyboard.up(ch);
    await wait(40 + Math.random() * 150);
  }
}

export async function wander(page, n = 4) {
  for (let i = 0; i < n; i++)
    await humanMove(page, 120 + Math.random() * 900, 140 + Math.random() * 480);
}

/** Identité « Chrome 130 sous Linux » pour Emulation.setUserAgentOverride : UA, Client Hints JS et en-têtes Sec-CH-UA cohérents. */
export function normalBrowserIdentity({
  platform = 'Linux',
  uaPlatform = 'X11; Linux x86_64',
  navPlatform = 'Linux x86_64',
  platformVersion = '6.5.0',
} = {}) {
  const brands = [
    { brand: 'Google Chrome', version: '130' },
    { brand: 'Chromium', version: '130' },
    { brand: 'Not?A_Brand', version: '99' },
  ];
  return {
    userAgent: `Mozilla/5.0 (${uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36`,
    acceptLanguage: 'en-US,en;q=0.9',
    platform: navPlatform,
    userAgentMetadata: {
      brands,
      fullVersionList: brands.map((b) => ({
        ...b,
        version: b.brand === 'Not?A_Brand' ? '99.0.0.0' : '130.0.6723.70',
      })),
      platform,
      platformVersion,
      architecture: 'x86',
      model: '',
      mobile: false,
      bitness: '64',
    },
  };
}

// ── Tactile (protocole DevTools : Input.dispatchTouchEvent) ──────────────────────────────────────────

const touchPoint = (x, y) => ({
  x,
  y,
  id: 1,
  radiusX: 4 + Math.random() * 4,
  radiusY: 4 + Math.random() * 4,
  force: 0.2 + Math.random() * 0.5,
});

/** Tape au doigt : durée d'appui, surface de contact et pression variables. */
export async function humanTap(cdp, x, y) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [touchPoint(x, y)],
  });
  await wait(55 + Math.random() * 90);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Glissement : trajectoire légèrement courbe et bruitée, vitesse en cloche, contact qui varie. */
export async function humanSwipe(cdp, x0, y0, x1, y1, steps = 26) {
  const bend = (Math.random() - 0.5) * 50;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [touchPoint(x0, y0)],
  });
  for (let i = 1; i <= steps; i++) {
    const u = i / steps,
      e = u * u * (3 - 2 * u);
    await wait(9 + Math.random() * 14);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        touchPoint(
          x0 + (x1 - x0) * e + Math.sin(u * Math.PI) * bend + (Math.random() - 0.5) * 1.4,
          y0 + (y1 - y0) * e + (Math.random() - 0.5) * 1.4,
        ),
      ],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
