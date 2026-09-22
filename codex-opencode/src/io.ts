import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import spawn from 'cross-spawn';
import { Fault, invariant, type ProcessIdentity } from './types.js';

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
export const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
export const digest = (value: unknown) => hash(canonical(value));
export function dataRoot(): string {
  return process.env.CODEX_OPENCODE_HOME || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'codex-opencode')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'codex-opencode')
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'codex-opencode'));
}
export function mkdir(dir: string) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
export function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
export function durableWrite(file: string, data: string | Buffer) {
  mkdir(path.dirname(file));
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  if (process.platform !== 'win32') { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
}
export const writeJson = (file: string, data: unknown) => durableWrite(file, JSON.stringify(data));
export function exclusiveJson(file: string, data: unknown) {
  mkdir(path.dirname(file)); const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function safeRelative(relative: string): string {
  invariant(relative.length > 0 && !relative.includes('\0') && !relative.includes('\\') && !path.posix.isAbsolute(relative) && !/^[A-Za-z]:/.test(relative), 'PATH', `Expected repository-relative path: ${relative}`);
  const parts = relative.split('/');
  invariant(!parts.some(p => p === '..' || p === '.git' || p === '' || p === '.'), 'PATH', `Unsafe path: ${relative}`);
  return relative;
}
export function inside(root: string, relative: string): string {
  const file = path.resolve(root, safeRelative(relative));
  let current = root;
  for (const part of relative.split('/')) { current = path.join(current, part); if (fs.existsSync(current)) invariant(!fs.lstatSync(current).isSymbolicLink(), 'SYMLINK', `Symlink path is not allowed: ${relative}`); }
  return file;
}
export function samePath(a: string, b: string): boolean {
  // Native realpath expands Windows 8.3 aliases (for example RUNNER~1), which
  // Git reports using the long spelling. Resolve existing paths before compare.
  const norm = (p: string) => { const v = fs.existsSync(p) ? fs.realpathSync.native(p) : path.resolve(p); return process.platform === 'win32' ? v.toLowerCase() : v; };
  return norm(a) === norm(b);
}
export type ExecResult = { stdout: string; stderr: string; code: number | null };
export function exec(executable: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; limit?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env ?? process.env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    const out: Buffer[] = [], err: Buffer[] = []; let size = 0, failed = false;
    const fail = (error: Error) => { if (failed) return; failed = true; child.kill(); reject(error); };
    const timer = setTimeout(() => fail(new Fault('TIMEOUT', `${executable} timed out`)), options.timeout ?? 30000);
    child.on('error', fail);
    const collect = (buffers: Buffer[]) => (data: Buffer) => { size += data.length; if (size > (options.limit ?? 16 * 1024 * 1024)) fail(new Fault('OUTPUT_LIMIT', `${executable} output too large`)); else buffers.push(data); };
    child.stdout!.on('data', collect(out)); child.stderr!.on('data', collect(err));
    child.on('close', code => { clearTimeout(timer); if (!failed) resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code }); });
  });
}
export async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  invariant(Number.isSafeInteger(pid) && pid > 0, 'PID', 'Invalid PID');
  try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return undefined; throw e; }
  const r = process.platform === 'win32'
    ? await exec('powershell.exe', ['-NoProfile','-NonInteractive','-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate.ToUniversalTime().ToString('o')`])
    : await exec('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'stat='], { env: { ...process.env, TZ: 'UTC' } });
  if (r.code !== 0 || !r.stdout.trim() || /\bZ\w*$/.test(r.stdout.trim())) return undefined;
  // Unix process state changes; only the creation timestamp forms the identity.
  return { pid, birth: process.platform === 'win32' ? r.stdout.trim() : r.stdout.trim().replace(/\s+\S+$/, '') };
}
export async function alive(identity?: ProcessIdentity): Promise<boolean> {
  if (!identity) return false;
  const current = await processIdentity(identity.pid); return current?.birth === identity.birth;
}
let boot: string | undefined;
export async function bootId(): Promise<string> {
  if (boot) return boot;
  if (process.platform === 'linux') boot = fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
  else {
    const result = process.platform === 'darwin' ? await exec('sysctl',['-n','kern.boottime']) : await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',"(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')"]);
    invariant(result.code === 0 && result.stdout.trim(), 'BOOT_ID', 'Cannot determine OS boot identity.'); boot = result.stdout.trim();
  }
  return boot;
}
export async function treeAlive(identity: ProcessIdentity): Promise<boolean> {
  if (process.platform === 'win32') return alive(identity);
  const current = await processIdentity(identity.pid);
  if (current && current.birth !== identity.birth) return false;
  const result = await exec('ps', ['-axo','pgid=,stat=']);
  invariant(result.code === 0, 'PROCESS_CHECK', 'Cannot verify the owned process group.');
  return result.stdout.split('\n').some(line => { const [pid, stat] = line.trim().split(/\s+/); return Number(pid) === identity.pid && !stat?.startsWith('Z'); });
}
export async function terminate(identity: ProcessIdentity, group = false): Promise<boolean> {
  const current = await processIdentity(identity.pid);
  if (group && process.platform === 'win32' && !current) return false; // A dead parent alone cannot prove its Windows descendants stopped.
  if (current && current.birth !== identity.birth) return true; // PID belongs to somebody else now.
  const groupAlive = async () => {
    if (!group || process.platform === 'win32') return alive(identity);
    return treeAlive(identity);
  };
  if (!(await groupAlive())) return true;
  if (process.platform === 'win32') {
    const stopped = await exec('taskkill.exe', ['/PID', String(identity.pid), ...(group ? ['/T'] : []), '/F']);
    if (stopped.code !== 0 && await alive(identity)) return false;
  } else { try { process.kill(group ? -identity.pid : identity.pid, 'SIGTERM'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } }
  for (let i = 0; i < 20; i++) { if (!(await groupAlive())) return true; await sleep(100); }
  if (process.platform !== 'win32' && await groupAlive()) { try { process.kill(group ? -identity.pid : identity.pid, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } }
  for (let i = 0; i < 20; i++) { if (!(await groupAlive())) return true; await sleep(100); }
  return false;
}
