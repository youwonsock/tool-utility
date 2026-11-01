import readline from 'node:readline';
// Exercises the adapter against the fake CLI's native stream, including real owned processes.
export function query({ prompt, options }) {
  const child = options.spawnClaudeCodeProcess({
    command: options.pathToClaudeCodeExecutable,
    args: ['--session-id', options.sessionId],
    cwd: options.cwd,
    env: options.env,
  });
  const controls = new Map(),
    messages = [],
    waiting = [];
  let counter = 0,
    closed = false;
  const write = (frame) => child.stdin.write(JSON.stringify(frame) + '\n');
  const control = (subtype, params = {}) =>
    new Promise((resolve, reject) => {
      const request_id = `control_${++counter}`;
      controls.set(request_id, { resolve, reject });
      write({ type: 'control_request', request_id, request: { subtype, ...params } });
    });
  const end = () => {
    if (closed) return;
    closed = true;
    for (const pending of controls.values()) pending.reject(new Error('Mock CLI disconnected'));
    controls.clear();
    for (const resolve of waiting.splice(0)) resolve({ done: true });
  };
  readline.createInterface({ input: child.stdout }).on('line', async (line) => {
    const frame = JSON.parse(line);
    if (frame.type === 'control_response') {
      const pending = controls.get(frame.response.request_id);
      if (pending) {
        controls.delete(frame.response.request_id);
        pending.resolve(frame.response.response);
      }
      return;
    }
    if (frame.type === 'control_request') {
      const request = frame.request;
      const response = await options.canUseTool(request.tool_name, request.input, {
        toolUseID: request.tool_use_id,
        signal: new AbortController().signal,
      });
      write({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } });
      return;
    }
    const resolve = waiting.shift();
    if (resolve) resolve({ value: frame, done: false });
    else messages.push(frame);
  });
  child.once('close', end);
  child.once('error', end);
  const initialized = control('initialize', { hooks: options.hooks });
  void (async () => {
    for await (const message of prompt) {
      if (closed) break;
      write(message);
    }
  })();
  return {
    initializationResult: () => initialized,
    getContextUsage: (params) => control('get_context_usage', params),
    setModel: (model) => control('set_model', { model }),
    interrupt: () => control('interrupt'),
    close: () => {
      child.stdin.end();
      end();
    },
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          messages.length
            ? Promise.resolve({ value: messages.shift(), done: false })
            : closed
              ? Promise.resolve({ done: true })
              : new Promise((resolve) => waiting.push(resolve)),
      };
    },
  };
}
