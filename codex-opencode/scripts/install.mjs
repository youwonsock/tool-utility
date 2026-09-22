import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { dataRoot, exec, PROTOCOL } = await import(pathToFileURL(path.join(source, 'dist', 'index.mjs')).href);
const root = process.env.CODEX_OPENCODE_INSTALL_ROOT || path.join(dataRoot(), 'install');
const bundle = fs.readFileSync(path.join(source, 'dist', 'cli.mjs'));
const version = JSON.parse(fs.readFileSync(path.join(source,'package.json'))).version;
const checksum = crypto.createHash('sha256').update(bundle);
function fingerprint(directory) { for (const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) { const file=path.join(directory,entry.name); checksum.update(path.relative(source,file)); if(entry.isDirectory())fingerprint(file); else checksum.update(fs.readFileSync(file)); } }
fingerprint(path.join(source,'plugins')); fingerprint(path.join(source,'.agents'));
const stamp = checksum.digest('hex').slice(0,12);
const release = path.join(root, 'releases', `${version}-${stamp}`);
const staging = path.join(root, 'releases', `.stage-${crypto.randomUUID()}`);
fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
// Keep Node 22 on its JS traversal path: the native cpSync directory fast path
// mishandles non-ASCII Windows paths (nodejs/node#61950).
const copyOptions = { recursive: true, filter: () => true };
fs.cpSync(path.join(source, 'plugins'), path.join(staging, 'plugins'), copyOptions);
fs.cpSync(path.join(source, '.agents'), path.join(staging, '.agents'), copyOptions);
const plugin = path.join(staging, 'plugins', 'codex-opencode');
const pluginManifestFile = path.join(plugin,'.codex-plugin/plugin.json');
const pluginManifest = JSON.parse(fs.readFileSync(pluginManifestFile));
// Each immutable deployment has its own cache version even between source releases.
pluginManifest.version = `${pluginManifest.version.split('+')[0]}+codex.${stamp}`;
fs.writeFileSync(pluginManifestFile,JSON.stringify(pluginManifest,null,2));
fs.mkdirSync(path.join(plugin, 'runtime'), { recursive: true });
fs.writeFileSync(path.join(plugin, 'runtime', 'cli.mjs'), bundle);
const installedCli = path.join(release, 'plugins', 'codex-opencode', 'runtime', 'cli.mjs');
fs.writeFileSync(path.join(plugin,'.mcp.json'), JSON.stringify({ mcpServers: { 'codex-opencode': { command: process.execPath, args: [installedCli,'mcp'], env: { CODEX_OPENCODE_HOME: dataRoot() } } } }, null, 2));
if (!fs.existsSync(release)) fs.renameSync(staging, release); else fs.rmSync(staging, { recursive: true, force: true });
const noRegister = process.argv.includes('--no-register');
for(const file of ['service.json','state.json']) {
  const location=path.join(dataRoot(),file);
  if(fs.existsSync(location)&&JSON.parse(fs.readFileSync(location)).protocol!==PROTOCOL) {
    console.log(JSON.stringify({staged:release,update_pending:true,reason:'Protocol/storage version differs. Finish existing work with the previous release; it was preserved.'},null,2));
    process.exit(0);
  }
}
if (!noRegister) {
  const codex = process.env.CODEX_EXECUTABLE || 'codex';
  const run = async args => { const r = await exec(codex,args,{timeout:120000}); process.stdout.write(r.stdout); process.stderr.write(r.stderr); if(r.code!==0)throw new Error(`codex ${args.join(' ')} failed (${r.code})`); };
  const name = JSON.parse(fs.readFileSync(path.join(release,'.agents/plugins/marketplace.json'))).name;
  const listed = await exec(codex,['plugin','marketplace','list','--json']);
  if(listed.code!==0)throw new Error('Could not inspect existing Codex marketplace registrations.');
  const existing=JSON.parse(listed.stdout).marketplaces?.find(entry=>entry.name===name);
  if(existing) {
    const relative=path.relative(root,existing.root);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error(`Marketplace ${name} belongs to another source (${existing.root}). Choose a distinct marketplace with plugin-creator before installing; the existing source was preserved.`);
  }
  const replacing=existing&&path.resolve(existing.root)!==path.resolve(release);
  if(replacing)await run(['plugin','marketplace','remove',name]);
  try {
    await run(['plugin','marketplace','add',release]);
    await run(['plugin','add',`codex-opencode@${name}`]);
  } catch(error) {
    if(replacing) {
      await exec(codex,['plugin','marketplace','remove',name]);
      await run(['plugin','marketplace','add',existing.root]);
      await run(['plugin','add',`codex-opencode@${name}`]);
    }
    throw error;
  }
}
const current = path.join(root, 'current.json'); const temp = `${current}.tmp`;
fs.writeFileSync(temp, JSON.stringify({ version, release, cli: installedCli, marketplace: path.join(release,'.agents/plugins/marketplace.json'), registered: !noRegister }, null, 2)); fs.renameSync(temp, current);
console.log(JSON.stringify({ installed: release, cli: installedCli, registered: !noRegister, next: 'Open a new Codex conversation and use $delegate-opencode.' }, null, 2));
