import fs from 'node:fs';
import { Fault, invariant, type Resource } from './types.js';
import { exec, samePath } from './io.js';

export async function probeResources(resources: Resource[], directory: string) {
  for (const resource of resources) {
    const replace = (s: string) => s.replaceAll('{{worktree}}', directory);
    const r = await exec(replace(resource.probe.executable), resource.probe.args.map(replace), {
      cwd: directory,
      timeout: 15000,
      limit: 65536,
    }).catch((e) => {
      throw new Fault('RESOURCE_UNVERIFIED', `Probe failed for ${resource.resource_key}: ${(e as Error).message}`, {
        worktree: directory,
      });
    });
    let result;
    try {
      result = JSON.parse(r.stdout);
    } catch {
      throw new Fault('RESOURCE_UNVERIFIED', `Probe did not return JSON for ${resource.resource_key}`);
    }
    const details = {
      resource_key: resource.resource_key,
      worktree: directory,
      expected_instance: resource.expected_instance,
      observed_instance: result.instance_id,
      observed_project: result.project_path,
    };
    invariant(
      r.code === 0 && result.instance_id === resource.expected_instance,
      'RESOURCE_MISMATCH',
      `Wrong or unverified instance for ${resource.resource_key}`,
      details,
    );
    if (resource.project_bound) {
      let matches = false;
      try {
        matches =
          typeof result.project_path === 'string' &&
          samePath(fs.realpathSync(result.project_path), fs.realpathSync(directory));
      } catch {
        /* Unknown paths are not verified. */
      }
      invariant(
        matches,
        'RESOURCE_PROJECT_MISMATCH',
        `Resource ${resource.resource_key} must bind to ${directory}. Rebind it and call reconcile_run.`,
        details,
      );
    }
  }
}
