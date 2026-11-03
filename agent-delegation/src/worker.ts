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
import { stopOwned } from './process.js';
import { runVerification } from './verification.js';
import { assertRuntimeUnchanged } from './runtime.js';
import { ScopeGuard, awaitGuardedTermination } from './scope-guard.js';

function readSpec(jobDir: string) {
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
  return spec;
}

const workerPrompt = (spec: WorkerSpec) =>
  [
    'You are an implementation worker supervised by the current planning and review agent. Implement only this assigned task.',
    'Do not delegate, invoke agent platforms, commit, change branches, push, or modify protected context/rules. Ask when blocked. Keep edits inside the declared scope.',
    `Scope: ${JSON.stringify(spec.scope)}`,
    `Goal:\n${spec.goal}`,
    `Acceptance:\n${spec.acceptance.join('\n')}`,
    `Read these context files, including ignored rules: ${spec.context.map((c) => c.path).join(', ') || '(none)'}`,
    `Declared verification commands will be executed separately: ${spec.verification.map((c) => c.command).join('; ')}`,
    'Finish with changed files, limitations and checks you ran. Your report is not verification evidence.',
  ].join('\n\n');

// policy-hook reads scope_guard.checked_at from worker.json and rejects it after 10 seconds.
const refreshInterval = 2000;

class WorkerRecord {
  private savedAt = 0;
  private savedKey = '';
  private transcript: string | undefined;
  private transcriptWritten: string | undefined;
  private transcriptAt = 0;
  constructor(
    private jobDir: string,
    private state: WorkerState,
  ) {}
  private changeKey() {
    const { state } = this;
    return JSON.stringify({
      ...state,
      updated: 0,
      last_activity_at: 0,
      scope_guard: state.scope_guard && { ...state.scope_guard, checked_at: 0 },
    });
  }
  save = () => {
    this.state.updated = Date.now();
    writeJson(path.join(this.jobDir, 'worker.json'), this.state);
    this.savedAt = Date.now();
    this.savedKey = this.changeKey();
  };
  refresh = () => {
    if (this.changeKey() !== this.savedKey || Date.now() - this.savedAt >= refreshInterval) this.save();
  };
  observeTranscript(value: unknown, force: boolean) {
    const observed = JSON.stringify(value);
    if (observed !== this.transcript) this.state.last_activity_at = Date.now();
    this.transcript = observed;
    this.writeTranscript(force);
  }
  writeTranscript(force = false) {
    if (this.transcript === undefined || this.transcript === this.transcriptWritten) return;
    if (!force && Date.now() - this.transcriptAt < refreshInterval) return;
    durableWrite(path.join(this.jobDir, 'transcript.json'), this.transcript);
    this.transcriptWritten = this.transcript;
    this.transcriptAt = Date.now();
    this.state.transcript = 'transcript.json';
  }
}

class WorkerRun {
  private backend: WorkerBackend | undefined;
  private cancelled = false;
  private controlBusy = false;
  private resumePhase: WorkerPhase = 'implementing';
  private deadline: number;
  private context: { spec: WorkerSpec; state: WorkerState; save: () => void; refresh: () => void };
  guard: ScopeGuard | undefined;
  constructor(
    private jobDir: string,
    private spec: WorkerSpec,
    private state: WorkerState,
    private record: WorkerRecord,
  ) {
    this.context = { spec, state, save: record.save, refresh: record.refresh };
    this.guard = spec.diagnostic
      ? undefined
      : new ScopeGuard(this.context, async () => {
          await this.backend?.cancel().catch(() => undefined);
          await stopOwned(this.context);
        });
    this.deadline = Date.now() + spec.timeout_ms;
  }
  cancelledNow() {
    return this.cancelled || fs.existsSync(path.join(this.jobDir, 'cancel.json')) || Date.now() >= this.deadline;
  }
  async control() {
    const { state } = this;
    if (this.controlBusy || workerTerminal(state) || !this.cancelledNow()) return;
    this.controlBusy = true;
    this.cancelled = true;
    try {
      if (state.phase !== 'cancelling') moveWorker(state, 'cancelling');
      this.record.save();
      await this.backend?.cancel().catch(() => undefined);
      await stopOwned(this.context);
    } catch (e) {
      state.error = (e as Error).message;
      this.record.save();
    } finally {
      this.controlBusy = false;
    }
  }
  // Returns false when the attempt ends here without declared verification.
  async implement() {
    const { spec, state, record } = this;
    if (spec.validation && !spec.diagnostic) {
      moveWorker(state, 'creating_session');
      moveWorker(state, 'verifying');
      record.save();
      return true;
    }
    const backend = createBackend(this.context);
    this.backend = backend;
    await backend.start();
    invariant(!this.cancelledNow(), 'CANCELLED', 'Cancelled during native startup.');
    moveWorker(state, 'creating_session');
    record.save();
    await backend.createSession();
    if (spec.diagnostic) {
      state.diagnostic_stage = 'termination';
      moveWorker(state, 'verifying');
      moveWorker(state, 'completed');
      record.save();
      return false;
    }
    moveWorker(state, 'implementing');
    record.save();
    const prompt = workerPrompt(spec);
    durableWrite(path.join(this.jobDir, 'prompt.txt'), prompt);
    await assertRuntimeUnchanged(spec.worker, state.runtime!);
    invariant(!this.cancelledNow(), 'CANCELLED', 'Cancelled before model dispatch.');
    state.prompt_intent = Date.now();
    record.save();
    try {
      await backend.dispatch(prompt, state.prompt_id);
      state.prompt_accepted = true;
      record.save();
    } catch {
      moveWorker(state, 'reconciling_delivery');
      state.error = 'Prompt response lost; inspecting the same session without resending.';
      record.save();
    }
    await this.followTurn(backend);
    return true;
  }
  private async followTurn(backend: WorkerBackend) {
    const { state, record, guard } = this;
    while (true) {
      await guard?.check();
      guard?.assertHealthy();
      await this.control();
      invariant(!this.cancelledNow(), 'CANCELLED', 'Execution cancelled or timed out.');
      const observed = await backend.observe();
      guard?.assertHealthy();
      for (const id of observed.reply_confirmations ?? []) if (state.replies[id]) state.replies[id] = 'sent';
      record.observeTranscript(
        observed.transcript,
        observed.complete || observed.error !== undefined || observed.inputs.length > 0,
      );
      state.prompt_accepted ||= observed.accepted;
      state.usage = observed.usage ?? state.usage;
      state.inputs = observed.inputs;
      if (state.inputs.length && state.phase !== 'needs_input') {
        this.resumePhase = state.phase;
        moveWorker(state, 'needs_input');
      } else if (!state.inputs.length && state.phase === 'needs_input') moveWorker(state, this.resumePhase);
      record.refresh();
      await this.answerInputs(backend);
      invariant(!observed.error, 'MODEL_ERROR', observed.error ?? 'Native implementation failed.');
      if (observed.accepted && observed.complete && !state.inputs.length) {
        state.summary = observed.summary;
        state.error = undefined;
        moveWorker(state, 'verifying');
        record.save();
        invariant(
          await backend.confirmStopped(),
          'STOP_UNCERTAIN',
          'Implementation runtime termination could not be confirmed.',
        );
        this.backend = undefined;
        return;
      }
      if (!observed.accepted && Date.now() - state.prompt_intent! > 30000 && state.phase !== 'needs_input')
        moveWorker(state, 'delivery_uncertain');
      await sleep(200);
    }
  }
  private async answerInputs(backend: WorkerBackend) {
    const { state, record, guard } = this;
    for (const input of state.inputs) {
      guard?.assertHealthy();
      const answer =
        readJson<Answer>(path.join(this.jobDir, 'replies', `${Buffer.from(input.id).toString('hex')}.json`)) ??
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
      record.save();
      try {
        state.replies[input.id] = await backend.reply(input, answer);
      } catch (e) {
        state.replies[input.id] = 'uncertain';
        state.error = `Input reply delivery is uncertain. It was not replayed: ${(e as Error).message}`;
      }
      record.save();
    }
  }
  async verify() {
    const { spec, state, record, guard } = this;
    await guard?.beginVerification();
    for (let index = 0; index < spec.verification.length; index++) {
      guard?.assertHealthy();
      invariant(!this.cancelledNow(), 'CANCELLED', 'Verification cancelled or timed out.');
      const evidence = await runVerification(
        this.context,
        index,
        spec.verification[index]!,
        () =>
          this.cancelledNow() || state.scope_guard?.status === 'violated' || state.scope_guard?.status === 'unknown',
      );
      await guard?.flush();
      guard?.assertHealthy();
      state.verification.push(evidence);
      record.save();
      if (evidence.status === 'unknown' || evidence.status === 'cancelled') break;
    }
    await guard?.flush();
    guard?.assertHealthy();
    moveWorker(state, this.cancelledNow() ? 'cancelled' : 'completed');
    record.save();
  }
  fail(error: unknown) {
    const { state, record } = this;
    const e = this.guard?.fault() ?? error;
    record.writeTranscript(true);
    moveWorker(state, this.cancelledNow() ? 'cancelled' : 'failed');
    state.error = e instanceof Fault ? `${e.code}: ${e.message}` : (e as Error).message;
    if (e instanceof Fault) {
      state.error_code = e.code;
      state.error_details = e.details;
    }
    record.save();
  }
  private async confirmStopped() {
    return this.backend ? await this.backend.confirmStopped() : await stopOwned(this.context);
  }
  async stop() {
    const { state, record, guard } = this;
    while (this.controlBusy) await sleep(50);
    if (this.backend) await this.backend.cancel().catch(() => undefined);
    state.stopped = await this.confirmStopped();
    if (!state.stopped) {
      moveWorker(state, 'stop_uncertain');
      state.error ??= 'Owned process termination could not be confirmed.';
    }
    if (!state.stopped) {
      record.save();
      await awaitGuardedTermination(guard, async () => {
        state.stopped = await this.confirmStopped();
        record.save();
        return state.stopped;
      });
    }
    await guard?.flush();
    await guard?.stop();
    record.save();
  }
}

export async function worker(jobDir: string) {
  const spec = readSpec(jobDir);
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
  const record = new WorkerRecord(jobDir, state);
  record.save();
  const run = new WorkerRun(jobDir, spec, state, record);
  const timer = setInterval(() => {
    void run.control();
  }, 250);
  try {
    invariant(!run.cancelledNow(), 'CANCELLED', 'Cancelled before start.');
    await run.guard?.start();
    if (await run.implement()) await run.verify();
  } catch (e) {
    run.fail(e);
  } finally {
    clearInterval(timer);
    await run.stop();
  }
}
