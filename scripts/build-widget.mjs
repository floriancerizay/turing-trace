// Construit le widget en UN SEUL fichier (esbuild) : un seul aller-retour réseau au lieu d'une dizaine de modules.
//   npm run build        écrit docs/dist/widget-<empreinte>.js et docs/dist/manifest.json
//
// Le nom du fichier contient l'empreinte de son contenu : il ne change jamais pour un contenu donné, donc le serveur
// peut le faire mettre en cache pour un an (« immutable »). Le manifeste donne le fichier courant et son empreinte
// d'intégrité (SRI), que les sites qui intègrent le widget peuvent épingler dans la balise <script>.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIST = path.join(root, 'docs', 'dist');

/** Construit le widget en mémoire. Déterministe : mêmes sources et même version d'esbuild, même fichier. */
export async function buildWidget() {
  const result = await build({
    entryPoints: [path.join(root, 'docs/js/widget.js')],
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2022',
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].text;
  const hash = crypto.createHash('sha256').update(code).digest('hex').slice(0, 10);
  const integrity = `sha384-${crypto.createHash('sha384').update(code).digest('base64')}`;
  return { file: `widget-${hash}.js`, code, integrity, bytes: Buffer.byteLength(code) };
}

async function main() {
  const w = await buildWidget();
  fs.mkdirSync(DIST, { recursive: true });
  for (const old of fs.readdirSync(DIST))
    if (/^widget-.*\.js$/.test(old) && old !== w.file) fs.unlinkSync(path.join(DIST, old));
  fs.writeFileSync(path.join(DIST, w.file), w.code);
  fs.writeFileSync(
    path.join(DIST, 'manifest.json'),
    JSON.stringify({ file: w.file, integrity: w.integrity, bytes: w.bytes }, null, 2) + '\n',
  );
  console.log(`docs/dist/${w.file}  ${(w.bytes / 1024).toFixed(1)} Ko\n${w.integrity}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
