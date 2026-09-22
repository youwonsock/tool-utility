import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { schemas, VERSION, type ToolName } from './types.js';
import { remoteCall } from './service.js';

const descriptions: Record<ToolName, string> = {
  doctor: 'Check local installation, OpenCode baseline, configuration and resource registrations. No model call.',
  submit_tasks: 'Create a run or append tasks. Requires a clean named Git checkout for a new run. Workers implement; Codex plans and reviews. Idempotent request_id required.',
  list_runs: 'Discover local runs. Paginated; follow next_cursor.',
  get_run: 'Read compact task, attempt, review, input and validation state. Follow next_cursor.',
  wait_run: 'Wait up to 30 seconds for events after a cursor. Returns only changes; use the returned after cursor.',
  get_artifact: 'Read a bounded UTF-8 artifact page. Follow next_offset. Includes observed checks, diffs and model reports.',
  review_task: 'Approve an exact attempt/commit after inspecting evidence, or request a correction with instructions. No autonomous retries.',
  respond_to_request: 'Answer an OpenCode question or permission request. Decisions are persisted before delivery; never blindly replay uncertain replies.',
  reconcile_run: 'Compare durable state with real worker processes, sessions, integration and target Git state; never reset user changes.',
  cancel_run: 'Request cancellation, preserve results and track confirmed worker termination. Cancelling is not yet cancelled.',
  validate_run: 'Freeze revision, commit, context and commands and start final verification in a dedicated worktree. Does not approve or finalize.',
  finalize_run: 'Codex final approval: supply the exact successful validation ID, commit and revision. Rechecks checkout and fast-forwards safely.',
};
export async function mcp(root: string, executableFile: string) {
  const server = new McpServer({ name: 'codex-opencode', version: VERSION });
  for (const name of Object.keys(schemas) as ToolName[]) {
    server.registerTool(name, { description: descriptions[name], inputSchema: schemas[name].shape,
      annotations: { readOnlyHint: ['doctor','list_runs','get_run','wait_run','get_artifact'].includes(name), idempotentHint: true, openWorldHint: true } },
    async (args: any) => {
      try {
        const result: any = await remoteCall(root, executableFile, name, args, '/call', 'mcp');
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: !!result?.error };
      } catch (e) { return { content: [{ type: 'text' as const, text: JSON.stringify({ error: (e as Error).message }) }], isError: true }; }
    });
  }
  await server.connect(new StdioServerTransport());
}
