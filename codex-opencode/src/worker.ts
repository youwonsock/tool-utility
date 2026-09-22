import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL, invariant, type WorkerSpec, type WorkerState, type Evidence } from './types.js';
import { uid, writeJson, readJson, durableWrite, exclusiveJson, processIdentity, sleep, terminate } from './io.js';
import { launchOpenCode } from './opencode.js';

// A separate supervisor process survives service/MCP restarts. The exclusive start record
// is a launch fence: an uncertain dispatch can never execute a second model invocation.
export async function worker(jobDir: string) {
  const spec = readJson<WorkerSpec>(path.join(jobDir, 'spec.json'))!;
  invariant(spec && spec.job_dir === jobDir, 'WORKER_SPEC', 'Invalid worker specification.');
  const host = await processIdentity(process.pid);
  exclusiveJson(path.join(jobDir, 'started.json'), { host, at: Date.now() });
  const state: WorkerState = { protocol: PROTOCOL, id: spec.id, phase: 'starting', updated: Date.now(), host, prompt_id: uid('msg'), verification: [], inputs: [], replies: {} };
  const save = () => { state.updated = Date.now(); writeJson(path.join(jobDir, 'worker.json'), state); };
  save();
  let api: Awaited<ReturnType<typeof launchOpenCode>> | undefined;
  let controlBusy = false, cancelled = false, fatal: Error | undefined;
  let terminationConfirmed = false;
  const deadline = Date.now() + spec.timeout_ms;
  const cancelledNow = () => fs.existsSync(path.join(jobDir, 'cancel.json')) || Date.now() > deadline;
  const control = async () => {
    if (controlBusy || !api || !state.session_id) return;
    controlBusy = true;
    try {
      if (cancelledNow()) {
        cancelled = true; state.phase = 'cancelling'; save();
        await api.client.session.abort({ sessionID: state.session_id }, { throwOnError: true, signal: AbortSignal.timeout(5000) }).catch(() => undefined);
        if (state.server) terminationConfirmed = await terminate(state.server, true);
        return;
      }
      const permissions = (await api.client.permission.list({}, { throwOnError: true })).data!;
      const questions = (await api.client.question.list({}, { throwOnError: true })).data!;
      state.inputs = [
        ...permissions.filter(p => p.sessionID === state.session_id).map(p => ({ id: p.id, kind: 'permission' as const, details: p })),
        ...questions.filter(q => q.sessionID === state.session_id).map(q => ({ id: q.id, kind: 'question' as const, details: q })),
      ];
      if (state.inputs.length) state.phase = 'needs_input';
      else if (state.phase === 'needs_input') state.phase = 'implementing';
      save();
      for (const input of state.inputs) {
        const answer = readJson<{ decision: 'once'|'always'|'reject'|'answer'; answers?: string[][] }>(path.join(jobDir, 'replies', `${Buffer.from(input.id).toString('hex')}.json`));
        if (!answer || state.replies[input.id]) continue;
        state.replies[input.id] = 'intent'; save();
        try {
          if (input.kind === 'permission') { invariant(answer.decision !== 'answer', 'INPUT', 'Permission requires an allow/reject decision.'); await api.client.permission.reply({ requestID: input.id, reply: answer.decision }, { throwOnError: true }); }
          else if (answer.decision === 'reject') await api.client.question.reject({ requestID: input.id }, { throwOnError: true });
          else { invariant(answer.decision === 'answer' && answer.answers, 'INPUT', 'Question requires answers.'); await api.client.question.reply({ requestID: input.id, answers: answer.answers }, { throwOnError: true }); }
          state.replies[input.id] = 'sent';
        } catch { state.replies[input.id] = 'uncertain'; state.error = 'Input reply delivery is uncertain; reconcile the OpenCode request. It was not replayed.'; }
        save();
      }
    } catch (e) { if (!cancelled) fatal = e as Error; } finally { controlBusy = false; }
  };
  const timer = setInterval(() => { void control(); }, 500);
  try {
    invariant(!cancelledNow(), 'CANCELLED', 'Cancelled before start.');
    api = await launchOpenCode(spec, state, save);
    invariant(!cancelledNow(), 'CANCELLED', 'Cancelled during OpenCode startup.');
    // The session-create intent is durable. A lost response stops here rather than creating a second session.
    state.phase = 'creating_session'; save();
    let session;
    try { session = (await api.client.session.create({ title: `delegation:${spec.id}`, model: { id: state.model!.modelID, providerID: state.model!.providerID }, agent: 'delegate-worker' }, { throwOnError: true })).data!; }
    catch {
      const matches = (await api.client.session.list({}, { throwOnError: true })).data!.filter(s => s.title === `delegation:${spec.id}`);
      invariant(matches.length === 1, 'SESSION_UNCERTAIN', 'Session creation response was lost and no unique existing session could be identified. No request was replayed.');
      session = matches[0]!;
    }
    state.session_id = session.id; state.phase = spec.validation ? 'verifying' : 'implementing'; save();
    if (!spec.validation) {
      const prompt = [
        'You are an implementation worker supervised by Codex. Implement only this assigned task.',
        'Do not delegate to other agents, invoke Codex/OpenCode, commit, change branches, push, or change context/rules. Ask when blocked. Keep edits inside the declared scope.',
        `Scope: ${JSON.stringify(spec.scope)}`, `Goal:\n${spec.goal}`, `Acceptance:\n${spec.acceptance.join('\n')}`,
        `Read these context files, including ignored rules: ${spec.context.map(c => c.path).join(', ') || '(none)'}`,
        `The supervisor will execute these verification commands separately: ${spec.verification.map(c => c.command).join('; ')}`,
        'Finish with a concise account of changed files, limitations and any checks you ran. Your report is not verification evidence.',
      ].join('\n\n');
      durableWrite(path.join(jobDir, 'prompt.txt'), prompt);
      state.prompt_intent = Date.now(); save();
      invariant(!cancelledNow(), 'CANCELLED', 'Cancelled before model dispatch.');
      try {
        await api.client.session.promptAsync({ sessionID: session.id, messageID: state.prompt_id, model: state.model!, agent: 'delegate-worker', parts: [{ type: 'text', text: prompt }] }, { throwOnError: true });
        state.prompt_accepted = true; save();
      } catch { state.phase = 'reconciling_delivery'; state.error = 'Prompt response lost; inspecting the existing session without resending.'; save(); }
      let seen = false;
      while (true) {
        await control(); invariant(!cancelled, 'CANCELLED', 'Execution cancelled or timed out.');
        if (fatal) throw fatal;
        const messages = (await api.client.session.messages({ sessionID: session.id }, { throwOnError: true })).data!;
        durableWrite(path.join(jobDir, 'transcript.json'), JSON.stringify(messages)); state.transcript = 'transcript.json';
        seen ||= messages.some(m => m.info.id === state.prompt_id && m.info.role === 'user');
        const replies = messages.filter(m => m.info.role === 'assistant' && m.info.parentID === state.prompt_id);
        const last = replies.at(-1);
        const statuses = (await api.client.session.status({}, { throwOnError: true })).data!;
        const idle = !statuses[session.id] || statuses[session.id]?.type === 'idle';
        if (seen && last?.info.role === 'assistant' && last.info.time.completed && idle && !last.parts.some(p => p.type === 'tool' && ['pending','running'].includes(p.state.status))) {
          invariant(!last.info.error, 'MODEL_ERROR', JSON.stringify(last.info.error));
          invariant(last.info.finish !== 'tool-calls' && last.info.finish !== 'unknown', 'INCOMPLETE_MODEL', 'Assistant did not finish its implementation turn.');
          state.summary = replies.flatMap(m => m.parts.filter(p => p.type === 'text').map(p => p.type === 'text' ? p.text : '')).join('\n');
          state.usage = replies.map(m => m.info.role === 'assistant' ? { model: `${m.info.providerID}/${m.info.modelID}`, tokens: m.info.tokens, cost: m.info.cost } : {});
          state.error = undefined; state.phase = 'verifying'; save(); break;
        }
        if (!seen && Date.now() - state.prompt_intent! > 30000) { state.phase = 'delivery_uncertain'; save(); }
        await sleep(500);
      }
    }
    for (let i = 0; i < spec.verification.length; i++) {
      invariant(!cancelledNow(), 'CANCELLED', 'Execution cancelled or timed out.');
      const command = spec.verification[i]!;
      state.shell_intent = { index: i, message_id: uid('msg'), command: command.command }; save();
      let message: any;
      try {
        message = (await api.client.session.shell({ sessionID: state.session_id!, agent: 'delegate-worker', model: state.model, command: command.command, messageID: state.shell_intent.message_id }, { throwOnError: true, signal: AbortSignal.timeout(command.timeout_ms) })).data;
      } catch {
        // Shell requests are never replayed. Inspect this exact message if HTTP completion was lost.
        const messages = (await api.client.session.messages({ sessionID: state.session_id! }, { throwOnError: true }).catch(() => ({ data: [] }))).data ?? [];
        message = messages.find((m: any) => m.info.id === state.shell_intent!.message_id || m.info.parentID === state.shell_intent!.message_id);
      }
      const file = `verification-${i}.json`; durableWrite(path.join(jobDir, file), JSON.stringify(message ?? { unavailable: true }));
      const tool = message?.parts?.find((p: any) => p.type === 'tool' && p.tool === 'bash' && p.state?.input?.command === command.command);
      const exit = tool?.state?.status === 'completed' && Number.isInteger(tool.state.metadata?.exit) ? tool.state.metadata.exit as number : null;
      const evidence: Evidence = { command: command.command, exit_code: exit, status: cancelled ? 'cancelled' : exit === null ? 'unknown' : exit === 0 ? 'passed' : 'failed', artifact: file };
      state.verification.push(evidence); state.shell_intent = undefined; save();
      if (exit === null) break;
    }
    state.phase = cancelled ? 'cancelled' : 'completed'; save();
  } catch (e) { state.phase = cancelled || cancelledNow() ? 'cancelled' : 'failed'; state.error = (e as Error).message; save(); }
  finally {
    clearInterval(timer);
    while (controlBusy) await sleep(50);
    // No terminal worker state is consumable until OpenCode and its subprocess tree are stopped.
    state.stopped = terminationConfirmed || (state.server ? await terminate(state.server, true) : true);
    if (!state.stopped) { state.phase = 'stop_uncertain'; state.error = 'OpenCode termination could not be confirmed.'; }
    api?.log.end(); save();
  }
}
