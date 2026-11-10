// What someone sees with the extension installed and no Contract compiler on the machine:
// one message, then quiet, and every request answered without an error.
// Usage: node test/nocompiler.test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'contract-nocompiler-'));
const files = {
  'one/app.contract': 'component One\n  state count = 0\n  action bump\n    count = count + 1\n  view\n    button press=bump\n      text "{count}"\n',
  'two/app.contract': 'component Two\n  view\n    text "two"\n',
  'loose.contract': 'component Loose\n  view\n      text   "loose"\n',
};
for (const [rel, text] of Object.entries(files)) { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); }

const env = { ...process.env };
delete env.EXACT_CONTRACT; delete env.EXACT2;
const server = spawn(process.execPath, [fileURLToPath(new URL('../server/contract-lsp.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], env });
let buffer = Buffer.alloc(0), nextId = 1, stderr = '', exited = null;
const pending = new Map(), shown = [];
server.stderr.on('data', (chunk) => { stderr += chunk; });
server.on('exit', (code) => { exited = code; });
server.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
    buffer = buffer.subarray(end + 4 + length);
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    else if (message.method === 'window/showMessage') shown.push(message.params.message);
  }
});
const write = (m) => { const b = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...m })); server.stdin.write(`Content-Length: ${b.length}\r\n\r\n`); server.stdin.write(b); };
const request = (method, params) => new Promise((done) => { const id = nextId++; pending.set(id, done); write({ id, method, params }); setTimeout(() => done({ error: { message: 'no answer in 5s' } }), 5000); });
const notify = (method, params) => write({ method, params });
const uri = (rel) => pathToFileURL(join(dir, rel)).href;
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); if (!ok) failed++; };

const init = await request('initialize', { processId: process.pid, rootUri: pathToFileURL(dir).href, capabilities: {} });
check('initialize', !!init.result?.capabilities);
notify('initialized', {});
for (const [rel, text] of Object.entries(files)) notify('textDocument/didOpen', { textDocument: { uri: uri(rel), languageId: 'contract', version: 1, text } });
notify('textDocument/didChange', { textDocument: { uri: uri('one/app.contract'), version: 2 }, contentChanges: [{ text: files['one/app.contract'] + '\n' }] });
notify('textDocument/didSave', { textDocument: { uri: uri('one/app.contract') } });

const at = { textDocument: { uri: uri('one/app.contract') }, position: { line: 5, character: 18 } };
const answers = {
  definition: await request('textDocument/definition', at),
  references: await request('textDocument/references', { ...at, context: { includeDeclaration: true } }),
  hover: await request('textDocument/hover', at),
  'hover on a tag': await request('textDocument/hover', { ...at, position: { line: 5, character: 6 } }),
  documentSymbol: await request('textDocument/documentSymbol', { textDocument: at.textDocument }),
  formatting: await request('textDocument/formatting', { textDocument: { uri: uri('loose.contract') }, options: { tabSize: 2, insertSpaces: true } }),
  completion: await request('textDocument/completion', { ...at, position: { line: 5, character: 4 } }),
  codeAction: await request('textDocument/codeAction', { textDocument: at.textDocument, range: { start: at.position, end: at.position }, context: { diagnostics: [] } }),
};
for (const [name, answer] of Object.entries(answers)) check(`${name}: answered without an error`, !answer.error, answer.error ? answer.error.message : JSON.stringify(answer.result ?? null).slice(0, 70));

await new Promise((done) => setTimeout(done, 500));
check('one message for the whole session', shown.length === 1, `${shown.length}: ${shown[0] ?? ''}`);
check('the server is still running', exited === null, exited === null ? '' : `exit ${exited}`);
check('nothing on stderr', stderr.trim() === '', stderr.trim().slice(0, 200));

server.kill();
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
