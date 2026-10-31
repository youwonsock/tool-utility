import fs from 'node:fs';
import path from 'node:path';
import { exportHost, platforms, skillContent } from '../dist/index.mjs';
export function buildBindings(source) {
  const body = fs.readFileSync(path.join(source, 'docs', 'workflow.md'), 'utf8');
  const output = path.join(source, 'dist', 'bindings');
  fs.rmSync(output, { recursive: true, force: true });
  for (const platform of platforms)
    exportHost(platform, path.join(output, platform), path.join(source, 'dist', 'cli.mjs'), body);
  const skills = path.join(source, 'dist', 'skills');
  fs.rmSync(skills, { recursive: true, force: true });
  const directory = path.join(skills, 'delegate-agents');
  fs.mkdirSync(path.join(directory, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), skillContent(body));
  fs.mkdirSync(path.join(directory, 'references'), { recursive: true });
  fs.copyFileSync(path.join(source, 'dist', 'contract.md'), path.join(directory, 'references', 'contract.md'));
  fs.writeFileSync(
    path.join(directory, 'agents', 'openai.yaml'),
    'interface:\n  display_name: "Delegate Agents"\n  short_description: "Plan, delegate, review and finalize changes"\n  default_prompt: "Use $delegate-agents to delegate implementation and review observed evidence."\n',
  );
}
