import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec as shell } from 'node:child_process';
const argv = process.argv.slice(2);
const overlay = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
if (argv.includes('--version')) { console.log('1.18.30'); process.exit(0); }
if (argv.includes('debug')) {
  if (argv.includes('paths')) console.log(`state      ${process.cwd()}`);
  else console.log(JSON.stringify({ model: 'fake/test', mcp: { inherited: { enabled: true, type: 'remote', url: 'http://never-connect.invalid' }, ...overlay.mcp }, ...overlay }));
  process.exit(0);
}
const session = { id: 'ses_test', title: 'test' };
let messages = [], busy = false, timer, pending, action, current;
const audit = event => { if (process.env.FAKE_AUDIT) fs.appendFileSync(process.env.FAKE_AUDIT, `${JSON.stringify({ ...event, cwd: process.cwd(), time: Date.now(), pid: process.pid })}\n`); };
const finish = () => {
  for (const [file, value] of Object.entries(action?.files || {})) { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file, value); }
  if (action?.require_context) {
    for (const [file, expected] of Object.entries(action.require_context)) if (fs.readFileSync(file,'utf8') !== expected) throw new Error(`Missing context ${file}`);
  }
  const info = { id: 'msg_reply', role: 'assistant', parentID: current.messageID, sessionID: session.id, time: { created: Date.now(), completed: Date.now() }, finish: 'stop', tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, providerID: 'fake', modelID: 'test' };
  messages.push({ info, parts: [{ type: 'text', text: action?.summary || 'Model claims checks passed.' }] }); busy = false; audit({ event: 'finished' });
};
const server = http.createServer(async (req,res) => {
  if (req.headers.authorization !== `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`) { res.writeHead(401); res.end(); return; }
  const url = new URL(req.url, 'http://localhost');
  let body = ''; for await (const chunk of req) body += chunk;
  const input = body ? JSON.parse(body) : {};
  const send = (data, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (url.pathname === '/global/health') return send({ healthy: true, version: '1.18.30' });
  if (url.pathname === '/provider') return send({ all: [{ id: 'fake', models: { test: { id: 'test' } } }], connected: ['fake'], default: { fake: 'test' } });
  if (url.pathname === '/config') return send(overlay);
  if (url.pathname === '/session' && req.method === 'POST') { audit({ event: 'session' }); return send(session); }
  if (url.pathname === '/session/ses_test') return send(session);
  if (url.pathname === '/session/status') return send({ [session.id]: { type: busy ? 'busy' : 'idle' } });
  if (url.pathname === '/session/ses_test/message') return send(messages);
  if (url.pathname === '/session/ses_test/prompt_async') {
    audit({ event: 'prompt', id: input.messageID }); current = input;
    const text = input.parts.map(p => p.text).join('\n');
    const matches = [...text.matchAll(/FAKE_ACTION:(.+)/g)]; action = JSON.parse(matches.at(-1)?.[1] || '{}');
    messages.push({ info: { id: input.messageID, role: 'user', sessionID: session.id }, parts: input.parts }); busy = true;
    if (action.input) pending = { id: 'req_test', sessionID: session.id, kind: action.input, questions: [{ question: 'Proceed?', header: 'Test', options: [] }], permission: 'bash', patterns: ['test'] };
    else timer = setTimeout(finish, action.delay ?? 20);
    if (action.drop_response) { req.socket.destroy(); return; }
    return send(null,204);
  }
  if (url.pathname === '/permission') return send(pending?.kind === 'permission' ? [pending] : []);
  if (url.pathname === '/question') return send(pending?.kind === 'question' ? [pending] : []);
  if (/\/(permission|question)\/req_test\/(reply|reject)/.test(url.pathname)) { pending = undefined; timer = setTimeout(finish,10); return send(true); }
  if (url.pathname === '/session/ses_test/abort') { clearTimeout(timer); busy = false; return send(true); }
  if (url.pathname === '/session/ses_test/shell') {
    audit({ event: 'shell', command: input.command });
    shell(input.command, { cwd: process.cwd(), timeout: 5000 }, (error, stdout, stderr) => {
      const exit = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      const result = { info: { id: input.messageID, role: 'assistant', parentID: input.messageID, sessionID: session.id, time: { completed: Date.now() } }, parts: [{ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: input.command }, metadata: { exit }, output: stdout + stderr } }] };
      messages.push(result); return send(result);
    }); return;
  }
  send({ error: `Unimplemented ${req.method} ${url.pathname}` },404);
});
server.listen(0,'127.0.0.1',() => console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`));
