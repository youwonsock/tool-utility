import path from 'node:path';
import { VERSION } from './types.js';
import { readJson } from './io.js';

export function deploymentVersion(executableFile: string): string {
  const manifest = readJson<{ version?: unknown }>(
    path.resolve(path.dirname(executableFile), '../.codex-plugin/plugin.json'),
  );
  return typeof manifest?.version === 'string' ? manifest.version : VERSION;
}
