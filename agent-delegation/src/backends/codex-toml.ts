import { invariant } from '../types.js';

function string(value: string): string {
  // A custom .cmd forwarding %* parses arguments a second time. Preserve the
  // exact TOML string while keeping CMD operators out of string/key contents.
  return JSON.stringify(value).replace(
    /[<>&|%^!()]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
export function codexToml(value: unknown): string {
  if (typeof value === 'string') return string(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(codexToml).join(',')}]`;
  invariant(value && typeof value === 'object', 'CONFIG', 'Unsupported native configuration value.');
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== null)
    .map(([key, item]) => `${string(key)}=${codexToml(item)}`)
    .join(',')}}`;
}
