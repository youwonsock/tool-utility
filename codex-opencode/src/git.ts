import fs from 'node:fs';
import path from 'node:path';
import { exec, hash, inside, mkdir, safeRelative, samePath, digest } from './io.js';
import { invariant, Fault, type ContextFile } from './types.js';
import type { Store } from './store.js';

export async function git(cwd: string, args: string[], allowFailure = false) {
  const result = await exec('git', ['-c','core.quotepath=false', ...args], { cwd, timeout: 120000 });
  if (result.code !== 0 && !allowFailure) throw new Fault('GIT', result.stderr || result.stdout || 'Git failed', { args, code: result.code });
  return result;
}
export const head = async (cwd: string) => (await git(cwd, ['rev-parse','HEAD'])).stdout.trim();
export const branch = async (cwd: string) => (await git(cwd, ['symbolic-ref','--quiet','--short','HEAD'], true)).stdout.trim();
export async function status(cwd: string) {
  return (await git(cwd, ['status','--porcelain=v1','-z','--untracked-files=all','--no-renames'])).stdout.split('\0').filter(Boolean).map(line => ({ kind: line.slice(0, 2), path: line.slice(3) }));
}
export async function clean(cwd: string, excluded: string[] = []) {
  const changes = (await status(cwd)).filter(item => !excluded.includes(item.path));
  invariant(changes.length === 0, 'DIRTY_WORKTREE', 'Working tree contains source changes.', changes);
}
export async function repository(directory: string) {
  const repo = fs.realpathSync.native((await git(directory, ['rev-parse','--show-toplevel'])).stdout.trim());
  invariant(samePath(repo, directory), 'REPO_ROOT', 'Supply the checkout root, not a subdirectory.', { supplied: directory, resolved: repo });
  const name = await branch(repo); invariant(name, 'DETACHED_HEAD', 'Start from a named checked-out branch.');
  await clean(repo);
  const common = fs.realpathSync.native(path.resolve(repo, (await git(repo, ['rev-parse','--git-common-dir'])).stdout.trim()));
  return { repo, branch: name, base: await head(repo), common_dir: common };
}
export async function worktree(repo: string, directory: string, commit: string, name?: string) {
  mkdir(path.dirname(directory));
  await git(repo, ['worktree','add', ...(name ? ['-b', name] : ['--detach']), directory, commit]);
}
export function scopeAllows(scope: string[], file: string) {
  safeRelative(file);
  if (file.split('/').some(p => p === '.git')) return false;
  return scope.some(entry => entry === '**' || (entry.endsWith('/**') ? file.startsWith(entry.slice(0, -2)) : entry.endsWith('/') ? file.startsWith(entry) : file === entry));
}
export function validateScope(scope: string[]) {
  for (const p of scope) if (p !== '**') { safeRelative(p.replace(/\/\*\*$|\/$/, '')); invariant(!p.replace(/\/\*\*$/, '').includes('*'), 'SCOPE', 'Use exact paths, directories ending in /, or /**.'); }
}
const forbiddenContext = /(^|\/)(\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|id_(?:rsa|ed25519)|config\.toml)$/i;
export async function snapshot(store: Store, runID: string, repo: string, paths: string[]): Promise<ContextFile[]> {
  const files: ContextFile[] = [];
  const tracked = new Set((await git(repo, ['ls-files','-z'])).stdout.split('\0'));
  for (const relative of [...new Set(paths)].sort()) {
    invariant(!forbiddenContext.test(relative), 'CONTEXT_SECRET', `Authentication/config files cannot be context: ${relative}`);
    const absolute = inside(repo, relative); const stat = fs.statSync(absolute);
    invariant(stat.isFile() && stat.size <= 2 * 1024 * 1024, 'CONTEXT_FILE', `Context must be a file up to 2 MiB: ${relative}`);
    const data = fs.readFileSync(absolute);
    files.push({ path: relative, hash: hash(data), artifact: store.artifact(runID, 'context', data), tracked: tracked.has(relative), mode: stat.mode & 0o777 });
  }
  return files;
}
export async function materialize(store: Store, cwd: string, files: ContextFile[]) {
  const tracked = new Set((await git(cwd, ['ls-files','-z'])).stdout.split('\0'));
  for (const file of files) {
    const destination = inside(cwd, file.path);
    if (tracked.has(file.path) || fs.existsSync(destination)) {
      invariant(fs.existsSync(destination) && hash(fs.readFileSync(destination)) === file.hash, 'CONTEXT_COLLISION', `Context would overwrite existing source: ${file.path}`); continue;
    }
    const data = fs.readFileSync(inside(path.join(store.root, 'artifacts'), file.artifact));
    invariant(hash(data) === file.hash, 'CONTEXT_HASH', 'Stored context hash mismatch.');
    mkdir(path.dirname(destination)); fs.writeFileSync(destination, data, { flag: 'wx', mode: file.mode });
  }
}
export function checkContext(cwd: string, files: ContextFile[]) {
  for (const file of files) invariant(fs.existsSync(inside(cwd, file.path)) && hash(fs.readFileSync(inside(cwd, file.path))) === file.hash, 'CONTEXT_CHANGED', `Context changed: ${file.path}`);
}
export const contextHash = (files: ContextFile[]) => digest(files.map(f => ({ path: f.path, hash: f.hash })));
export async function resultCommit(cwd: string, base: string, scope: string[], context: ContextFile[], title: string) {
  invariant(await head(cwd) === base, 'WORKER_CHANGED_HEAD', 'Worker changed HEAD. Review its Git history before correction.');
  checkContext(cwd, context);
  const changed = (await status(cwd)).filter(item => !context.some(c => !c.tracked && c.path === item.path));
  const violations = changed.filter(item => !scopeAllows(scope, item.path));
  invariant(violations.length === 0, 'SCOPE_VIOLATION', 'Changes exceed the declared scope.', violations);
  // Stage named paths only; never sweep context or ignored files into the commit.
  for (const file of changed) await git(cwd, ['add','-A','--', file.path]);
  const staged = (await git(cwd, ['diff','--cached','--name-only','-z','--no-renames'])).stdout.split('\0').filter(Boolean);
  invariant(staged.every(p => scopeAllows(scope, p) && !context.some(c => c.path === p)), 'CONTEXT_STAGED', 'Worker staged context or out-of-scope files.');
  await git(cwd, ['-c','user.name=Codex OpenCode','-c','user.email=codex-opencode@localhost','-c','core.hooksPath=/dev/null','commit','--allow-empty','-m', title]);
  return head(cwd);
}
export async function integrate(cwd: string, expected: string, commit: string) {
  await clean(cwd); invariant(await head(cwd) === expected, 'INTEGRATION_MOVED', 'Integration branch changed outside this service.');
  const result = await git(cwd, ['-c','user.name=Codex OpenCode','-c','user.email=codex-opencode@localhost','-c','core.hooksPath=/dev/null','cherry-pick','--allow-empty', commit], true);
  if (result.code !== 0) {
    const evidence = { stdout: result.stdout, stderr: result.stderr, conflicts: (await git(cwd, ['diff','--name-only','--diff-filter=U'])).stdout };
    await git(cwd, ['cherry-pick','--abort'], true);
    throw new Fault('INTEGRATION_CONFLICT', 'Accepted change cannot be integrated. Codex must give correction instructions.', evidence);
  }
  return head(cwd);
}
export async function targetReady(repo: string, expectedBranch: string, expectedHead: string) {
  invariant(await branch(repo) === expectedBranch, 'TARGET_BRANCH_CHANGED', 'Target checkout branch changed.');
  invariant(await head(repo) === expectedHead, 'TARGET_HEAD_CHANGED', 'Target branch moved. Start a new run from its new base.');
  await clean(repo);
}
