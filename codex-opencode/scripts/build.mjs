import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({ absWorkingDir: root, entryPoints: ['src/cli.ts','src/index.ts'], outdir: 'dist', outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', target: 'node22', format: 'esm', sourcemap: false,
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' }, logLevel: 'warning' });
fs.writeFileSync(path.join(root, 'dist', 'build.json'), JSON.stringify({ version: JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version, node: '>=22' }));
