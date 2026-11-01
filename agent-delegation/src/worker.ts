import fs from 'node:fs';
import path from 'node:path';
import {
  WORKER_FORMAT,
  workerSchema,
  Fault,
  invariant,
  type WorkerSpec,
  type WorkerState,
  type WorkerPhase,
} from './types.js';
import { uid, writeJson, readJson, durableWrite, exclusiveJson, processIdentity, sleep, samePath } from './io.js';
import { moveWorker, workerTerminal } from './lifecycle.js';
import { createBackend, type WorkerBackend, type Answer } from './backends/index.js';
import { stopOwned } from './backends/process.js';
import { runVerification } from './verification.js';
import { assertRuntimeUnchanged } from './runtime.js';
import { ScopeGuard, awaitGuardedTermination } from './scope-guard.js';

export async function worker(jobDir: string) {
  const spec = readJson<WorkerSpec>(path.join(jobDir, 'spec.json'))!;
  invariant(spec && spec.job_dir === jobDir, 'WORKER_SPEC', 'Invalid worker specification.');
  invariant(spec.protocol === WORKER_FORMAT, 'UPDATE_PENDING', 'Worker specification format differs.');
  invariant(
    typeof spec.host_executable === 'string' &&
      path.isAbsolute(spec.host_executable) &&
      process.argv[1] &&
      samePath(spec.host_executable, process.argv[1]),
    'WORKER_SPEC',
    'Invalid worker specification: host_executable must identify the current absolute CLI path.',
  );
  invariant(
    spec.worker &&
      workerSchema.safeParse({ platform: spec.worker.platform, model: spec.worker.model, profile: spec.worker.profile })
        .success,
    'WORKER_SPEC',
    'Invalid worker specification: missing or unknown worker selection.',
  );
  const host = await processIdentity(process.pid);
  exclusiveJson(path.join(jobDir, 'started.json'), { host, at: Date.now() });
  const state: WorkerState = {
    protocol: WORKER_FORMAT,
    id: spec.id,
    phase: 'starting',
    updated: Date.now(),
    host,
    prompt_id: uid('msg'),
    verification: [],
    inputs: [],
    replies: {},
  };
  const save = () => {
    state.updated = Date.now();
    writeJson(path.join(jobDir, 'worker.json'), state);
  };
  save();
  const context = { spec, state, save };
  const guard = spec.diagnostic
    ? undefined
    : new ScopeGuard(context, async () => {
        await backend?.cancel().catch(() => undefined);
        await stopOwned(context);
      });
  let backend: WorkerBackend | undefined,
    cancelled = false,
    controlBusy = false,
    resumePhase: WorkerPhase = 'implementing';
  const deadline = Date.now() + spec.timeout_ms;
  const cancelledNow = () => cancelled || fs.existsSync(path.join(jobDir, 'cancel.json')) || Date.now() >= deadline;
  const control = async () => {
    if (controlBusy || workerTerminal(state) || !cancelledNow()) return;
    controlBusy = true;
    cancelled = true;
    try {
      if (state.phase !== 'cancelling') moveWorker(state, 'cancelling');
      save();
      await backend?.cancel().catch(() => undefined);
      await stopOwned(context);
    } catch (e) {
      state.error = (e as Error).message;
      save();
    } finally {
      controlBusy = false;
    }
  };
  const timer = setInterval(() => {
    void control();
  }, 250);
  try {
    invariant(!cancelledNow(), 'CANCELLED', 'Cancelled before start.');
    await guard?.start();
    if (!spec.validation || spec.diagnostic) {
      backend = createBackend(context);
      await backend.start();
      invariant(!cancelledNow(), 'CANCELLED', 'Cancelled during native startup.');
      moveWorker(state, 'creating_session');
      save();
      await backend.createSession();
      if (spec.diagnostic) {
        state.diagnostic_stage = 'termination';
        moveWorker(state, 'verifying');
        moveWorker(state, 'completed');
        save();
        return;
      }
      moveWorker(state, 'implementing');
      save();
      const prompt = [
        'You are an implementation worker supervised by the current planning and review agent. Implement only this assigned task.',
        'Do not delegate, invoke agent platforms, commit, change branches, push, or modify protected context/rules. Ask when blocked. Keep edits inside the declared scope.',
        `Scope: ${JSON.stringify(spec.scope)}`,
        `Goal:\n${spec.goal}`,
        `Acceptance:\n${spec.acceptance.join('\n')}`,
        `Read these context files, including ignored rules: ${spec.context.map((c) => c.path).join(', ') || '(none)'}`,
        `Declared verification commands will be executed separately: ${spec.verification.map((c) => c.command).join('; ')}`,
        'Finish with changed files, limitations and checks you ran. Your report is not verification evidence.',
      ].join('\n\n');
      durableWrite(path.join(jobDir, 'prompt.txt'), prompt);
      await assertRuntimeUnchanged(spec.worker, state.runtime!);
      invariant(!cancelledNow(), 'CANCELLED', 'Cancelled before model dispatch.');
      state.prompt_intent = Date.now();
      save();
      try {
        await backend.dispatch(prompt, state.prompt_id);
        state.prompt_accepted = true;
        save();
      } catch {
        moveWorker(state, 'reconciling_delivery');
        state.error = 'Prompt response lost; inspecting the same session without resending.';
        save();
      }
      while (true) {
        await guard?.check();
        guard?.assertHealthy();
        await control();
        invariant(!cancelledNow(), 'CANCELLED', 'Execution cancelled or timed out.');
        const observed = await backend.observe();
        guard?.assertHealthy();
        for (const id of observed.reply_confirmations ?? []) if (state.replies[id]) state.replies[id] = 'sent';
        durableWrite(path.join(jobDir, 'transcript.json'), JSON.stringify(observed.transcript));
        state.transcript = 'transcript.json';
        state.prompt_accepted ||= observed.accepted;
        state.inputs = observed.inputs;
        if (state.inputs.length && state.phase !== 'needs_input') {
          resumePhase = state.phase;
          moveWorker(state, 'needs_input');
        } else if (!state.inputs.length && state.phase === 'needs_input') moveWorker(state, resumePhase);
        save();
        for (const input of state.inputs) {
          guard?.assertHealthy();
          const answer =
            readJson<Answer>(path.join(jobDir, 'replies', `${Buffer.from(input.id).toString('hex')}.json`)) ??
            (input.grant_key && state.permission_grants?.includes(input.grant_key)
              ? { decision: 'once' as const }
              : undefined);
          if (!answer || state.replies[input.id]) continue;
          invariant(
            !input.supported_decisions || input.supported_decisions.includes(answer.decision),
            'INPUT_UNSUPPORTED',
            'Native input does not support this decision.',
          );
          state.replies[input.id] = 'intent';
          if (answer.decision === 'always' && input.grant_key) (state.permission_grants ??= []).push(input.grant_key);
          save();
          try {
            state.replies[input.id] = await backend.reply(input, answer);
          } catch (e) {
            state.replies[input.id] = 'uncertain';
            state.error = `Input reply delivery is uncertain. It was not replayed: ${(e as Error).message}`;
          }
          save();
        }
        invariant(!observed.error, 'MODEL_ERROR', observed.error ?? 'Native implementation failed.');
        if (observed.accepted && observed.complete && !state.inputs.length) {
          state.summary = observed.summary;
          state.usage = observed.usage;
          state.error = undefined;
          moveWorker(state, 'verifying');
          save();
          invariant(
            await backend.confirmStopped(),
            'STOP_UNCERTAIN',
            'Implementation runtime termination could not be confirmed.',
          );
          backend = undefined;
          break;
        }
        if (!observed.accepted && Date.now() - state.prompt_intent! > 30000 && state.phase !== 'needs_input')
          moveWorker(state, 'delivery_uncertain');
        await sleep(200);
      }
    } else {
      moveWorker(state, 'creating_session');
      moveWorker(state, 'verifying');
      save();
    }
    await guard?.beginVerification();
    for (let index = 0; index < spec.verification.length; index++) {
      guard?.assertHealthy();
      invariant(!cancelledNow(), 'CANCELLED', 'Verification cancelled or timed out.');
      const evidence = await runVerification(
        context,
        index,
        spec.verification[index]!,
        () => cancelledNow() || state.scope_guard?.status === 'violated' || state.scope_guard?.status === 'unknown',
      );
      await guard?.flush();
      guard?.assertHealthy();
      state.verification.push(evidence);
      save();
      if (evidence.status === 'unknown' || evidence.status === 'cancelled') break;
    }
    await guard?.flush();
    guard?.assertHealthy();
    moveWorker(state, cancelledNow() ? 'cancelled' : 'completed');
    save();
  } catch (e) {
    e = guard?.fault() ?? e;
    moveWorker(state, cancelledNow() ? 'cancelled' : 'failed');
    state.error = e instanceof Fault ? `${e.code}: ${e.message}` : (e as Error).message;
    if (e instanceof Fault) {
      state.error_code = e.code;
      state.error_details = e.details;
    }
    save();
  } finally {
    clearInterval(timer);
    while (controlBusy) await sleep(50);
    if (backend) await backend.cancel().catch(() => undefined);
    state.stopped = backend ? await backend.confirmStopped() : await stopOwned(context);
    if (!state.stopped) {
      moveWorker(state, 'stop_uncertain');
      state.error ??= 'Owned process termination could not be confirmed.';
    }
    if (!state.stopped) {
      save();
      await awaitGuardedTermination(guard, async () => {
        state.stopped = backend ? await backend.confirmStopped() : await stopOwned(context);
        save();
        return state.stopped;
      });
    }
    await guard?.flush();
    await guard?.stop();
    save();
  }
}
