import fs from 'node:fs';
import path from 'node:path';

// Compare file identities and original bytes, including unrelated retained
// evidence. A rejected format must not create, repair, convert or remove files.
export function storageTree(root) {
  const result = {};
  if (!fs.existsSync(root)) return result;
  const visit = (directory, relative = '') => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const key = relative ? `${relative}/${entry.name}` : entry.name,
        file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        result[key] = { directory: true };
        visit(file, key);
      } else if (entry.isSymbolicLink()) result[key] = { link: fs.readlinkSync(file) };
      else result[key] = { bytes: fs.readFileSync(file).toString('base64') };
    }
  };
  visit(root);
  return result;
}
