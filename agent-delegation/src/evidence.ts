import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Fault, type Attempt } from './types.js';
import { inside, safeRelative } from './io.js';
import { authenticationFile, git, status } from './git.js';
import type { Store } from './store.js';

const PREVIEW_BYTES = 64 * 1024;
async function untrackedFile(cwd: string, relative: string) {
  safeRelative(relative);
  const parent = relative.includes('/') ? inside(cwd, path.posix.dirname(relative)) : cwd;
  const file = path.join(parent, path.posix.basename(relative)), stat = fs.lstatSync(file);
  if (authenticationFile(relative)) return { size: stat.size, omitted: 'authentication_file' };
  if (stat.isSymbolicLink()) return { size: stat.size, kind: 'symlink', target: fs.readlinkSync(file) };
  if (!stat.isFile()) return { size: stat.size, omitted: 'not_regular_file' };
  const digest = crypto.createHash('sha256'), prefix: Buffer[] = [];
  let bytes = 0, kept = 0, text = true;
  const decoder = new TextDecoder('utf-8',{fatal:true});
  for await (const chunk of fs.createReadStream(file)) {
    const data = chunk as Buffer; digest.update(data); bytes += data.length;
    if (data.includes(0)) text=false;
    if (text) { try { decoder.decode(data,{stream:true}); } catch { text=false; } }
    const take = Math.min(data.length, PREVIEW_BYTES + 4 - kept);
    if (take > 0) { prefix.push(data.subarray(0, take)); kept += take; }
  }
  if (text) { try { decoder.decode(); } catch { text=false; } }
  const data = Buffer.concat(prefix); let end = Math.min(data.length, PREVIEW_BYTES);
  while (end < data.length && end > 0 && (data[end]! & 0xc0) === 0x80) end--;
  let preview: string | undefined;
  try { if (text) preview = new TextDecoder('utf-8', {fatal:true}).decode(data.subarray(0,end)); } catch { /* Binary files only expose metadata. */ }
  return { kind: preview === undefined ? 'binary' : 'text', size: bytes, sha256: digest.digest('hex'),
    ...(preview === undefined ? {} : {preview, preview_bytes:end, truncated:bytes > end}) };
}

// Diagnostic failure must not replace the reason why a result was rejected.
export async function rejectedEvidence(store: Store, runID: string, attempt: Attempt, error: unknown): Promise<string[]> {
  const artifacts: string[] = [], collection_errors: string[] = [], changed_files: Record<string,unknown>[] = [];
  try { artifacts.push(store.artifact(runID,'rejected-diff.patch',(await git(attempt.directory,['diff','HEAD','--binary'])).stdout)); }
  catch (e) { collection_errors.push(`tracked diff: ${(e as Error).message}`); }
  try {
    const changes = (await status(attempt.directory)).filter(f => !attempt.context.some(c=>!c.tracked && c.path===f.path));
    for (const change of changes) {
      let detail: Record<string,unknown> = {};
      if (change.kind === '??') {
        try { detail = await untrackedFile(attempt.directory,change.path); }
        catch (e) { detail = { collection_error:(e as Error).message }; }
      }
      changed_files.push({...change,...detail});
    }
  } catch (e) { collection_errors.push(`file list: ${(e as Error).message}`); }
  try {
    artifacts.push(store.artifact(runID,'rejected-result.json',JSON.stringify({
      code:error instanceof Fault ? error.code : 'INTERNAL', message:(error as Error).message,
      details:error instanceof Fault ? error.details : undefined, changed_files, collection_errors,
    })));
  } catch (e) { process.stderr.write(`Rejected evidence unavailable: ${(e as Error).message}\n`); }
  return artifacts;
}
