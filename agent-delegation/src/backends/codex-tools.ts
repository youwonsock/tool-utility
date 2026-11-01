import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { invariant, type WorkerSpec } from '../types.js';
import { checkedMutationPath } from '../scope.js';
import { toolPolicy } from './policy.js';

export const CODEX_READ_TOOL = 'delegate_read_file';
export const CODEX_COMMAND_TOOL = 'delegate_run_command';
const MAX_READ_BYTES = 64 * 1024;
type ReadPolicy = Pick<WorkerSpec, 'directory' | 'scope' | 'context'>;

export function codexWindowsSandbox(
  config: { windows?: { sandbox?: unknown } | null },
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== 'win32') return;
  const mode = config.windows?.sandbox ?? undefined;
  invariant(
    mode === undefined || mode === 'mxc' || mode === 'elevated' || mode === 'unelevated',
    'MCP_POLICY',
    'Configured Windows sandbox implementation is unsupported.',
  );
  // Pinned Codex maps workspace-write to read-only on Windows without a local
  // implementation. Keep explicit choices; the restricted-token default
  // needs no administrative setup and is passed only to this owned invocation.
  return mode ?? 'unelevated';
}

function object(input: unknown, keys: string[]): Record<string, unknown> {
  invariant(input && typeof input === 'object' && !Array.isArray(input), 'INPUT', 'Tool arguments must be an object.');
  invariant(
    Object.keys(input).every((key) => keys.includes(key)),
    'INPUT',
    'Tool arguments contain an unsupported field.',
  );
  return input as Record<string, unknown>;
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  invariant(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max,
    'INPUT',
    'Tool argument is outside its permitted integer range.',
  );
  return value;
}
export const codexDynamicTools = [
  {
    type: 'function',
    name: CODEX_READ_TOOL,
    description:
      'Read a bounded UTF-8 file from the declared task scope or protected context. Use byte offsets to continue. Links, Git metadata and paths outside the checkout are forbidden.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_READ_BYTES },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: CODEX_COMMAND_TOOL,
    description:
      'Run a foreground shell command after supervisor approval. Commands cannot delegate, mutate Git ownership, run in the background, or reference protected context. Use delegate_read_file to read protected context.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, maxLength: 8192 },
        cwd: { type: 'string', minLength: 1 },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 3_600_000 },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
] as const;

export function readCodexFile(spec: ReadPolicy, input: unknown) {
  const args = object(input, ['path', 'offset', 'limit']);
  invariant(typeof args.path === 'string' && args.path.length > 0, 'INPUT', 'A file path is required.');
  const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    limit = integer(args.limit, 16 * 1024, 1, MAX_READ_BYTES);
  // Reuse the direct-edit resolver with context as exact read-only additions.
  // It rejects links, parent traversal, Git metadata, streams and unsafe aliases.
  const allowed = [...spec.scope, ...spec.context.map((file) => file.path)];
  const relative = checkedMutationPath(spec.directory, args.path, allowed, []),
    file = path.resolve(spec.directory, relative);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd);
    invariant(before.isFile(), 'INPUT', 'Only regular files can be read.');
    invariant(offset <= before.size, 'INPUT', 'Read offset exceeds the file size.');
    const bytes = Buffer.alloc(Math.min(limit, before.size - offset));
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, offset + count);
      if (!read) break;
      count += read;
    }
    // Trim a trailing partial UTF-8 sequence, but reject invalid input or a
    // continuation offset. Never silently replace bytes in source content.
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text: string | undefined,
      end = count;
    for (let trim = 0; trim <= Math.min(3, count); trim++) {
      try {
        text = decoder.decode(bytes.subarray(0, count - trim));
        end = count - trim;
        break;
      } catch {
        if (offset + count >= before.size) break;
      }
    }
    invariant(
      text !== undefined && !text.includes('\0') && (end > 0 || offset === before.size),
      'INPUT',
      'File is not UTF-8 text or the read range splits a character.',
    );
    const after = fs.fstatSync(fd),
      observed = fs.lstatSync(file);
    invariant(
      checkedMutationPath(spec.directory, args.path, allowed, []) === relative &&
        !observed.isSymbolicLink() &&
        observed.dev === before.dev &&
        observed.ino === before.ino &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs,
      'SCOPE_VIOLATION',
      'File changed while being read.',
    );
    return {
      path: relative,
      offset,
      next_offset: offset + end,
      total_bytes: before.size,
      truncated: offset + end < before.size,
      text,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function codexCommand(spec: ReadPolicy, input: unknown) {
  const args = object(input, ['command', 'cwd', 'timeout_ms']);
  invariant(
    typeof args.command === 'string' &&
      args.command.length > 0 &&
      args.command.length <= 8192 &&
      !args.command.includes('\0'),
    'INPUT',
    'A bounded shell command is required.',
  );
  invariant(
    args.cwd === undefined || (typeof args.cwd === 'string' && args.cwd.length > 0),
    'INPUT',
    'Command cwd must be a path.',
  );
  const timeout_ms = integer(args.timeout_ms, 600_000, 100, 3_600_000);
  const cwd = path.resolve(spec.directory, (args.cwd as string) ?? '.'),
    command = args.command;
  invariant(
    toolPolicy(
      'Bash',
      { command, cwd },
      spec.directory,
      spec.context.map((file) => file.path),
      spec.scope,
    ) === 'ask',
    'MCP_POLICY',
    'Command does not satisfy the hard worker policy.',
  );
  return { command, cwd, timeout_ms };
}
