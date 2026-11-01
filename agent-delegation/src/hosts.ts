import fs from 'node:fs';
import path from 'node:path';
import { platforms, invariant, type Platform } from './types.js';
import { mkdir, writeJson, durableWrite, dataRoot } from './io.js';

export function skillContent(body: string) {
  return `---\nname: delegate-agents\ndescription: Plan changes in the current agent platform, delegate implementation to persistent local workers, review observed Git and verification evidence, request corrections, and finalize validated commits.\n---\n\n${body}\nRead [the tool contract and examples](references/contract.md) for input details.\n`;
}
export function supervisorBinding(platform: Platform, cli: string, root: string) {
  invariant(platforms.includes(platform), 'PLATFORM', 'Unknown supervisor platform.');
  invariant(
    path.isAbsolute(cli) && path.isAbsolute(root),
    'PATH',
    'Host bindings require absolute runtime and data paths.',
  );
  const stdio = { command: process.execPath, args: [cli, 'mcp'], env: { AGENT_DELEGATION_HOME: root } };
  const engine = { type: 'local', command: [stdio.command, ...stdio.args], environment: stdio.env, enabled: true };
  return {
    platform,
    stdio,
    config:
      platform === 'codex'
        ? { mcp_servers: { 'agent-delegation': stdio } }
        : platform === 'opencode' || platform === 'kilo'
          ? { mcp: { 'agent-delegation': engine } }
          : { mcpServers: { 'agent-delegation': stdio } },
    ide_config: { mcpServers: { 'agent-delegation': stdio } },
    skills: platform === 'claude-code' ? '.claude/skills' : '.agents/skills',
    support: {
      contract: 'tested by automated fixtures',
      cli_connection: 'requires connection check',
      model_tasks: 'not exercised',
      ide_desktop_gui: 'unconfirmed',
    },
  };
}
function tomlString(value: string) {
  return JSON.stringify(value);
}
export function exportHost(platform: Platform, output: string, cli: string, body: string, root = dataRoot()) {
  invariant(
    !fs.existsSync(output),
    'EXPORT_COLLISION',
    'Export destination already exists. Choose an empty output path.',
  );
  const binding = supervisorBinding(platform, cli, root);
  mkdir(output);
  writeJson(path.join(output, 'binding.json'), binding);
  if (platform === 'codex')
    durableWrite(
      path.join(output, 'config.toml'),
      `[mcp_servers.agent-delegation]\ncommand = ${tomlString(binding.stdio.command)}\nargs = [${binding.stdio.args.map(tomlString).join(', ')}]\n[mcp_servers.agent-delegation.env]\nAGENT_DELEGATION_HOME = ${tomlString(root)}\n`,
    );
  else
    writeJson(
      path.join(output, platform === 'opencode' ? 'opencode.json' : platform === 'kilo' ? 'kilo.json' : '.mcp.json'),
      binding.config,
    );
  if (platform === 'kilo') writeJson(path.join(output, 'ide-mcp.json'), binding.ide_config);
  const skill = path.join(output, binding.skills, 'delegate-agents');
  durableWrite(path.join(skill, 'SKILL.md'), skillContent(body));
  durableWrite(
    path.join(skill, 'references', 'contract.md'),
    fs.readFileSync(new URL('./contract.md', import.meta.url), 'utf8'),
  );
  if (platform === 'codex')
    durableWrite(
      path.join(skill, 'agents', 'openai.yaml'),
      'interface:\n  display_name: "Delegate Agents"\n  short_description: "Plan, delegate, review and finalize changes"\n  default_prompt: "Use $delegate-agents to delegate implementation and review observed evidence."\n',
    );
  durableWrite(
    path.join(output, 'README.md'),
    `# ${platform} supervisor binding\n\nThis export does not change global configuration. Merge the MCP entry using the\nplatform's official configuration UI or CLI and copy the generated skills to\nits supported project or user skill directory. Keep the absolute Node/runtime\npaths. Kilo's IDE variant is ide-mcp.json; its CLI/runtime variant is kilo.json.\n\nThe supervisor is your current conversation. Choose any of the four worker\nplatforms using submit_tasks.worker. Installed runtimes must pass doctor.\n\nCLI/API connectivity does not prove model-task or IDE/desktop GUI behavior.\nThese exports do not activate the installed plugin.\n`,
  );
  return { platform, output, runtime: cli, registered: false };
}
