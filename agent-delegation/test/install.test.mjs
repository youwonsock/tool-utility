import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, processIdentity } from '../dist/index.mjs';
import { root, temporaryRoot } from './helpers.mjs';

test('installer updates its own marketplaces in each host, retains old releases, and rolls back failed registration', async () => {
  const dir = fs.mkdtempSync(path.join(temporaryRoot, '업데이트 검증 ')),
    source = path.join(dir, 'source'),
    install = path.join(dir, 'install'),
    data = path.join(dir, 'data');
  fs.mkdirSync(source);
  for (const entry of ['dist', 'plugins', '.agents', '.claude-plugin', 'scripts', 'package.json'])
    fs.cpSync(path.join(root, entry), path.join(source, entry), {
      recursive: true,
      mode: fs.constants.COPYFILE_FICLONE,
      filter: () => true,
    });
  assert.ok(
    fs.existsSync(path.join(source, 'scripts/install.mjs')),
    `Copied installer missing: ${JSON.stringify(fs.readdirSync(source))}`,
  );
  const fakeHost = (label, manifest, installCommand, list) => {
    const stateFile = path.join(dir, `fake-${label}-state.json`);
    fs.writeFileSync(stateFile, JSON.stringify({ marketplaces: [] }));
    const script = path.join(dir, `fake-${label}.mjs`);
    fs.writeFileSync(
      script,
      `import fs from 'node:fs';import path from 'node:path';const file=${JSON.stringify(stateFile)};const state=JSON.parse(fs.readFileSync(file));const a=process.argv.slice(2);const save=()=>fs.writeFileSync(file,JSON.stringify(state));if(a[0]==='--version')process.exit(0);if(a[1]==='marketplace'&&a[2]==='list')console.log(JSON.stringify(${list}));else if(a[1]==='marketplace'&&a[2]==='remove'){state.marketplaces=state.marketplaces.filter(m=>m.name!==a[3]);save();}else if(a[1]==='marketplace'&&a[2]==='add'){const name=JSON.parse(fs.readFileSync(path.join(a[3],${JSON.stringify(manifest)}))).name;if(state.marketplaces.some(m=>m.name===name&&m.root!==a[3]))process.exit(1);state.marketplaces=[{name,root:a[3]}];save();}else if(a[1]===${JSON.stringify(installCommand)}){if(state.fail_next_add){state.fail_next_add=false;save();process.exit(1);}state.pluginRoot=state.marketplaces[0].root;save();}else process.exit(2);`,
    );
    const executable = path.join(dir, process.platform === 'win32' ? `fake ${label}.cmd` : `fake ${label}`);
    fs.writeFileSync(
      executable,
      process.platform === 'win32'
        ? `@"${process.execPath}" "%~dp0fake-${label}.mjs" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      { mode: 0o755 },
    );
    const read = () => JSON.parse(fs.readFileSync(stateFile));
    return { executable, read, write: (state) => fs.writeFileSync(stateFile, JSON.stringify(state)) };
  };
  const codex = fakeHost('codex', '.agents/plugins/marketplace.json', 'add', 'state');
  const claude = fakeHost(
    'claude',
    '.claude-plugin/marketplace.json',
    'install',
    "state.marketplaces.map(m=>({name:m.name,source:'directory',path:m.root}))",
  );
  const env = {
    ...process.env,
    AGENT_DELEGATION_CODEX_EXECUTABLE: codex.executable,
    AGENT_DELEGATION_CLAUDE_EXECUTABLE: claude.executable,
    AGENT_DELEGATION_INSTALL_ROOT: install,
    AGENT_DELEGATION_HOME: data,
  };
  const run = (overrides = {}) =>
    exec(process.execPath, [path.join(source, 'scripts/install.mjs')], {
      env: { ...env, ...overrides },
      timeout: 120000,
    });
  let result = await run();
  assert.equal(result.code, 0, result.stderr);
  const first = JSON.parse(fs.readFileSync(path.join(install, 'current.json')));
  assert.equal(fs.existsSync(path.join(path.dirname(first.cli), 'storage-worker.mjs')), true);
  assert.deepEqual(first.registered, ['codex', 'claude-code']);
  assert.equal(codex.read().pluginRoot, first.release);
  assert.equal(claude.read().pluginRoot, first.release);
  const skill = path.join(source, 'plugins/agent-delegation/skills/delegate-agents/SKILL.md');
  fs.appendFileSync(skill, '\n');
  result = await run();
  assert.equal(result.code, 0, result.stderr);
  const second = JSON.parse(fs.readFileSync(path.join(install, 'current.json')));
  assert.notEqual(first.release, second.release);
  assert.ok(fs.existsSync(first.cli));
  for (const folder of ['.codex-plugin', '.claude-plugin']) {
    const manifest = (r) =>
      JSON.parse(fs.readFileSync(path.join(r.release, 'plugins/agent-delegation', folder, 'plugin.json')));
    assert.notEqual(manifest(first).version, manifest(second).version);
  }
  // A failure in either host restores both to the previous release.
  for (const failed of [codex, claude]) {
    fs.appendFileSync(skill, '\n');
    failed.write({ ...failed.read(), fail_next_add: true });
    result = await run();
    assert.notEqual(result.code, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(install, 'current.json'))).release, second.release);
    assert.equal(codex.read().marketplaces[0].root, second.release);
    assert.equal(claude.read().marketplaces[0].root, second.release);
    assert.equal(claude.read().pluginRoot, second.release);
  }
  // A marketplace from another source stops the update before any host changes.
  const claudeState = claude.read();
  claude.write({ ...claudeState, marketplaces: [{ name: 'personal', root: path.join(dir, 'other') }] });
  fs.appendFileSync(skill, '\n');
  result = await run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /belongs to another source/);
  assert.equal(codex.read().marketplaces[0].root, second.release);
  claude.write(claudeState);
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(
    path.join(data, 'state.json'),
    JSON.stringify({
      protocol: 2,
      revision: 0,
      events: [],
      requests: {},
      runs: [{ tasks: [{ attempts: [{ state: 'stop_uncertain' }] }] }],
    }),
  );
  result = await run();
  assert.equal(JSON.parse(result.stdout).code, 'UPDATE_PENDING');
  assert.equal(JSON.parse(fs.readFileSync(path.join(install, 'current.json'))).release, second.release);
  fs.rmSync(path.join(data, 'state.json'));
  fs.writeFileSync(
    path.join(data, 'service.json'),
    JSON.stringify({ protocol: 1, owner: await processIdentity(process.pid) }),
  );
  result = await run();
  assert.equal(JSON.parse(result.stdout).code, 'UPDATE_PENDING');
  assert.equal(JSON.parse(fs.readFileSync(path.join(install, 'current.json'))).release, second.release);
  fs.rmSync(path.join(data, 'service.json'));
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ protocol: 99 }));
  result = await run();
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).update_pending, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(install, 'current.json'))).release, second.release);
  fs.rmSync(path.join(data, 'state.json'));
  // A host CLI that is not installed is left out, not an error.
  result = await run({ AGENT_DELEGATION_CLAUDE_EXECUTABLE: path.join(dir, 'missing-claude') });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(install, 'current.json'))).registered, ['codex']);
});
