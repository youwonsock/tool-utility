import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  dataRoot,
  exec,
  PROTOCOL,
  STORE_FORMAT,
  exportHost,
  platforms,
  alive,
  loadState,
  attemptsStopped,
  validateStoredState,
} = await import(pathToFileURL(path.join(source, 'dist', 'index.mjs')).href);
const root = process.env.AGENT_DELEGATION_INSTALL_ROOT || path.join(dataRoot(), 'install');
function pending(reason) {
  console.log(JSON.stringify({ update_pending: true, code: 'UPDATE_PENDING', reason }, null, 2));
  process.exit(0);
}
// Verify current storage before creating a release or changing registration.
// Unsupported data is neither converted nor repaired by installation.
try {
  for (const [file, protocol] of [
    ['service.json', PROTOCOL],
    ['state.json', STORE_FORMAT],
  ]) {
    const location = path.join(dataRoot(), file);
    if (fs.existsSync(location) && JSON.parse(fs.readFileSync(location)).protocol !== protocol)
      pending('Protocol/storage version differs. Existing files and registration were preserved.');
  }
  const snapshot = loadState(dataRoot()).state;
  if (snapshot) validateStoredState(snapshot);
  const descriptorFile = path.join(dataRoot(), 'service.json'),
    descriptor = fs.existsSync(descriptorFile) ? JSON.parse(fs.readFileSync(descriptorFile)) : undefined;
  const stopped = !snapshot || (await Promise.all(snapshot.runs.map(attemptsStopped))).every(Boolean);
  if (!stopped || (descriptor?.owner && (await alive(descriptor.owner))))
    pending(
      'Finish/cancel owned attempts and stop the current service before switching. Runtime termination must be confirmed; records and registration were preserved.',
    );
} catch (error) {
  pending(
    error.code === 'UPDATE_PENDING'
      ? error.message
      : 'Current storage could not be verified. Existing files and registration were preserved.',
  );
}
const bundle = fs.readFileSync(path.join(source, 'dist', 'cli.mjs'));
const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).version;
const checksum = crypto.createHash('sha256').update(bundle);
function fingerprint(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    checksum.update(path.relative(source, file));
    if (entry.isDirectory()) fingerprint(file);
    else checksum.update(fs.readFileSync(file));
  }
}
fingerprint(path.join(source, 'plugins'));
fingerprint(path.join(source, '.agents'));
fingerprint(path.join(source, 'dist', 'skills'));
checksum.update(fs.readFileSync(path.join(source, 'dist', 'workflow.md')));
checksum.update(fs.readFileSync(path.join(source, 'dist', 'contract.md')));
checksum.update(fs.readFileSync(path.join(source, 'dist', 'storage-worker.mjs')));
const stamp = checksum.digest('hex').slice(0, 12);
const release = path.join(root, 'releases', `${version}-${stamp}`);
const installedCli = path.join(release, 'plugins', 'agent-delegation', 'runtime', 'cli.mjs');
const staging = path.join(root, 'releases', `.stage-${crypto.randomUUID()}`);
if (!fs.existsSync(release)) {
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    // Keep Node 22 on its JS traversal path: the native cpSync directory fast path
    // mishandles non-ASCII Windows paths (nodejs/node#61950).
    const copyOptions = { recursive: true, mode: fs.constants.COPYFILE_FICLONE, filter: () => true };
    fs.cpSync(path.join(source, 'plugins'), path.join(staging, 'plugins'), copyOptions);
    fs.cpSync(path.join(source, '.agents'), path.join(staging, '.agents'), copyOptions);
    const plugin = path.join(staging, 'plugins', 'agent-delegation');
    const pluginManifestFile = path.join(plugin, '.codex-plugin/plugin.json');
    const pluginManifest = JSON.parse(fs.readFileSync(pluginManifestFile));
    // Each immutable deployment has its own cache version even between source releases.
    pluginManifest.version = `${pluginManifest.version.split('+')[0]}+codex.${stamp}`;
    fs.writeFileSync(pluginManifestFile, JSON.stringify(pluginManifest, null, 2));
    fs.mkdirSync(path.join(plugin, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'runtime', 'cli.mjs'), bundle);
    fs.copyFileSync(
      path.join(source, 'dist', 'storage-worker.mjs'),
      path.join(plugin, 'runtime', 'storage-worker.mjs'),
    );
    fs.copyFileSync(path.join(source, 'dist', 'workflow.md'), path.join(plugin, 'runtime', 'workflow.md'));
    fs.copyFileSync(path.join(source, 'dist', 'contract.md'), path.join(plugin, 'runtime', 'contract.md'));
    // Generated skills replace source-only wrappers. Removing that owned directory
    // avoids Node 22 cpSync's broken Windows overwrite path for Unicode filenames.
    fs.rmSync(path.join(plugin, 'skills'), { recursive: true, force: true });
    fs.cpSync(path.join(source, 'dist', 'skills'), path.join(plugin, 'skills'), copyOptions);
    fs.writeFileSync(
      path.join(plugin, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            'agent-delegation': {
              command: process.execPath,
              args: [installedCli, 'mcp'],
              env: { AGENT_DELEGATION_HOME: dataRoot() },
            },
          },
        },
        null,
        2,
      ),
    );
    const workflow = fs.readFileSync(path.join(source, 'dist', 'workflow.md'), 'utf8');
    for (const platform of platforms)
      exportHost(platform, path.join(staging, 'hosts', platform), installedCli, workflow);
    if (!fs.existsSync(release)) fs.renameSync(staging, release);
    else fs.rmSync(staging, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
const noRegister = process.argv.includes('--no-register');
if (!noRegister) {
  const codex = process.env.AGENT_DELEGATION_CODEX_EXECUTABLE || 'codex';
  const run = async (args) => {
    const r = await exec(codex, args, { timeout: 120000 });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    if (r.code !== 0) throw new Error(`codex ${args.join(' ')} failed (${r.code})`);
  };
  const name = JSON.parse(fs.readFileSync(path.join(release, '.agents/plugins/marketplace.json'))).name;
  const listed = await exec(codex, ['plugin', 'marketplace', 'list', '--json']);
  if (listed.code !== 0) throw new Error('Could not inspect existing Codex marketplace registrations.');
  const existing = JSON.parse(listed.stdout).marketplaces?.find((entry) => entry.name === name);
  if (existing) {
    const relative = path.relative(root, existing.root);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error(
        `Marketplace ${name} belongs to another source (${existing.root}). Choose a distinct marketplace with plugin-creator before installing; the existing source was preserved.`,
      );
  }
  const replacing = existing && path.resolve(existing.root) !== path.resolve(release);
  if (replacing) await run(['plugin', 'marketplace', 'remove', name]);
  try {
    await run(['plugin', 'marketplace', 'add', release]);
    await run(['plugin', 'add', `agent-delegation@${name}`]);
  } catch (error) {
    if (replacing) {
      await exec(codex, ['plugin', 'marketplace', 'remove', name]);
      await run(['plugin', 'marketplace', 'add', existing.root]);
      await run(['plugin', 'add', `agent-delegation@${name}`]);
    }
    throw error;
  }
}
const current = path.join(root, 'current.json');
const temp = `${current}.tmp`;
fs.writeFileSync(
  temp,
  JSON.stringify(
    {
      version,
      release,
      cli: installedCli,
      marketplace: path.join(release, '.agents/plugins/marketplace.json'),
      registered: !noRegister,
    },
    null,
    2,
  ),
);
fs.renameSync(temp, current);
console.log(
  JSON.stringify(
    {
      installed: release,
      cli: installedCli,
      registered: !noRegister,
      next: 'Open a new Codex conversation and use $delegate-agents.',
    },
    null,
    2,
  ),
);
