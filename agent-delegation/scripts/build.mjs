import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Dist is entirely tool-owned. Remove stale SDK/native assets before every build.
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/cli.ts', 'src/index.ts', 'src/storage-worker.ts'],
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  logLevel: 'warning',
});
fs.writeFileSync(
  path.join(root, 'dist', 'build.json'),
  JSON.stringify({ version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version, node: '>=22' }),
);
fs.copyFileSync(path.join(root, 'docs', 'workflow.md'), path.join(root, 'dist', 'workflow.md'));
fs.copyFileSync(
  path.join(root, 'plugins', 'agent-delegation', 'skills', 'delegate-agents', 'references', 'contract.md'),
  path.join(root, 'dist', 'contract.md'),
);
const { buildBindings } = await import('./build-bindings.mjs');
buildBindings(root);
