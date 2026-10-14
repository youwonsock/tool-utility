import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const plugin=path.join(root,'plugins/agent-delegation');
const manifest=JSON.parse(fs.readFileSync(path.join(plugin,'.codex-plugin/plugin.json')));
assert.equal(manifest.name,'agent-delegation'); assert.match(manifest.version,/^\d+\.\d+\.\d+(?:\+.+)?$/);
for(const key of ['description','author','interface','skills','mcpServers']) assert.ok(manifest[key],key);
assert.equal(manifest.skills,'./skills/'); assert.equal(manifest.mcpServers,'./.mcp.json');
assert.ok(!JSON.stringify(manifest).includes('TODO'));
const mcp=JSON.parse(fs.readFileSync(path.join(plugin,'.mcp.json'))); assert.ok(mcp.mcpServers['agent-delegation'].command);
const market=JSON.parse(fs.readFileSync(path.join(root,'.agents/plugins/marketplace.json')));
const entry=market.plugins.find(p=>p.name===manifest.name); assert.equal(entry.source.path,'./plugins/agent-delegation');
assert.equal(entry.policy.installation,'AVAILABLE'); assert.equal(entry.policy.authentication,'ON_INSTALL');
const skill=fs.readFileSync(path.join(plugin,'skills/delegate-agents/SKILL.md'),'utf8').replaceAll('\r\n','\n');
assert.match(skill,/^---\nname: delegate-agents\ndescription: .+\n---\n/); assert.ok(!skill.includes('TODO')); assert.ok(skill.split('\n').length<500);
for(const name of ['doctor','submit_tasks','list_runs','get_run','wait_run','get_artifact','review_task','respond_to_request','reconcile_run','cancel_run','validate_run','finalize_run']) assert.ok(skill.includes(name),name);
const interfaceFile=fs.readFileSync(path.join(plugin,'skills/delegate-agents/agents/openai.yaml'),'utf8'); assert.ok(interfaceFile.includes('$delegate-agents'));
console.log('Plugin, marketplace and delegation skill contracts validated.');
for(const name of ['delegate-agents']) {
  const generated=fs.readFileSync(path.join(root,'dist','skills',name,'SKILL.md'),'utf8').replaceAll('\r\n','\n');
  assert.ok(generated.startsWith(`---\nname: ${name}\n`));assert.ok(generated.split('\n').length<500);
  for(const tool of ['doctor','submit_tasks','list_runs','get_run','wait_run','get_artifact','review_task','respond_to_request','reconcile_run','cancel_run','validate_run','finalize_run'])assert.ok(generated.includes(tool),`${name}/${tool}`);
}
for(const platform of ['opencode','codex','claude-code','kilo']) {
  const binding=JSON.parse(fs.readFileSync(path.join(root,'dist','bindings',platform,'binding.json')));
  assert.equal(binding.platform,platform);assert.equal(binding.support.model_tasks,'not exercised');assert.equal(binding.support.ide_desktop_gui,'unconfirmed');
}
for(const entry of ['runtime_modules','runtime-manifest.json'])assert.equal(fs.existsSync(path.join(root,'dist',entry)),false,`Platform runtime must not be bundled: ${entry}`);
const dependencies=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
for(const name of ['@agent-delegation/claude-runtime','@opencode-ai/sdk','@kilocode/sdk','@anthropic-ai/claude-agent-sdk'])assert.ok(!dependencies.dependencies?.[name]&&!dependencies.devDependencies?.[name],name);
