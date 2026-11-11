// Checking text that is not saved. Usage: node test/unsaved.test.mjs <contract binary>
// With a compiler that takes `--stdin` (exact 85c59b40 or later) the root file is checked as it
// is typed; with an older one nothing changes until the save. Both must pass. Either way a file
// that is not the root is checked as saved: `--stdin` replaces only the file that is named.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const compiler = resolve(process.argv[2] ?? '../exact/target/debug/contract');
const usage = spawnSync(compiler, ['symbols'], { encoding: 'utf8' });
const live = /--stdin/.test(`${usage.stdout}${usage.stderr}`);
console.log(`compiler ${live ? 'takes' : 'does not take'} --stdin`);

const app = mkdtempSync(join(tmpdir(), 'contract-unsaved-'));
mkdirSync(join(app, 'parts'));
const ROW = 'shape Item\n  id: string\n  title: string\n\ncomponent Row\n  props\n    item: Item\n    pick: action\n  view\n    button press=pick(item.id)\n      text item.title\n';
const APP = 'use Row, Item from "./parts/row.contract"\n\ncomponent App\n  state chosen = ""\n  state items = [Item(id="a", title="A")]\n  action pick(id: string)\n    chosen = id\n  view\n    column\n      for item in items key=item.id\n        Row(item=item, pick=pick)\n      text chosen\n';
const saved = { 'app.contract': APP, 'parts/row.contract': ROW };
for (const [rel, text] of Object.entries(saved)) writeFileSync(join(app, rel), text);

const server = spawn(process.execPath, [fileURLToPath(new URL('../server/contract-lsp.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, EXACT_CONTRACT: compiler } });
let buffer = Buffer.alloc(0), nextId = 1;
const pending = new Map(), diagnostics = new Map();
server.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
    buffer = buffer.subarray(end + 4 + length);
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message.result); pending.delete(message.id); }
    else if (message.method === 'textDocument/publishDiagnostics') diagnostics.set(message.params.uri, message.params.diagnostics);
  }
});
const write = (m) => { const b = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...m })); server.stdin.write(`Content-Length: ${b.length}\r\n\r\n`); server.stdin.write(b); };
const request = (method, params) => new Promise((done) => { const id = nextId++; pending.set(id, done); write({ id, method, params }); });
const notify = (method, params) => write({ method, params });
const uri = (rel) => pathToFileURL(join(app, rel)).href;
const settle = () => new Promise((done) => setTimeout(done, 1200));
let version = 1;
const type = (rel, text) => notify('textDocument/didChange', { textDocument: { uri: uri(rel), version: ++version }, contentChanges: [{ text }] });
const errors = (rel) => (diagnostics.get(uri(rel)) ?? []).filter((d) => d.severity === 1);
const where = (d) => `${d.code} at ${d.range.start.line + 1}:${d.range.start.character + 1}`;
const position = (text, needle) => { const lines = text.split('\n'); for (let i = 0; i < lines.length; i++) { const c = lines[i].indexOf(needle); if (c >= 0) return { line: i, character: c + 1 }; } throw new Error(`no ${needle}`); };
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); if (!ok) failed++; };

await request('initialize', { processId: process.pid, rootUri: pathToFileURL(app).href, capabilities: {} });
notify('initialized', {});
for (const [rel, text] of Object.entries(saved)) notify('textDocument/didOpen', { textDocument: { uri: uri(rel), languageId: 'contract', version: 1, text } });
await settle();
check('the saved program is clean', errors('app.contract').length === 0 && errors('parts/row.contract').length === 0);

// An error typed into the root, two lines lower than anything on disk, and not saved.
const typed = `// a line that is not saved\n// and another\n${APP.replace('chosen = id\n', 'chosen = nowhere\n')}`;
type('app.contract', typed);
await settle();
const found = errors('app.contract');
if (live) {
  const want = position(typed, 'nowhere');
  check('root: the unsaved error is reported', found.length === 1, found.map(where).join(', '));
  check('root: at its place in the unsaved text', found[0]?.range.start.line === want.line, `line ${found[0]?.range.start.line + 1}, typed on line ${want.line + 1}`);
} else {
  check('root: nothing is reported before the save', found.length === 0, found.map(where).join(', '));
}
check('the file on disk is untouched', readFileSync(join(app, 'app.contract'), 'utf8') === APP);

// A name in the unsaved root still resolves, from where it now is.
const shifted = `// a line that is not saved\n${APP}`;
type('app.contract', shifted);
await settle();
const definition = (await request('textDocument/definition', { textDocument: { uri: uri('app.contract') }, position: position(shifted, 'Row(item') }))?.[0];
if (live) {
  check('root: the error goes when the text is put right', errors('app.contract').length === 0);
  check('root: definition from a shifted line', !!definition?.uri.endsWith('parts/row.contract'), definition ? `${definition.uri.split('/').slice(-2).join('/')}:${definition.range.start.line + 1}` : 'no answer');
} else {
  check('root: a shifted line gives no wrong answer', !definition || definition.uri.endsWith('parts/row.contract'), definition ? 'resolved' : 'no answer');
}

// The limit: a file that is not the root is checked as saved.
const broken = ROW.replace('text item.title', 'text nowhere');
type('parts/row.contract', broken);
await settle();
check('other file: unsaved text is not checked', errors('parts/row.contract').length === 0 && errors('app.contract').length === 0);
writeFileSync(join(app, 'parts/row.contract'), broken);
notify('textDocument/didSave', { textDocument: { uri: uri('parts/row.contract') } });
await settle();
const afterSave = [...errors('parts/row.contract'), ...errors('app.contract')];
check('other file: checked once it is saved', afterSave.length >= 1, afterSave.map(where).join(', '));
writeFileSync(join(app, 'parts/row.contract'), ROW);
type('parts/row.contract', ROW);
notify('textDocument/didSave', { textDocument: { uri: uri('parts/row.contract') } });
await settle();

// A root closed without saving goes back to what is on disk.
type('app.contract', typed);
await settle();
notify('textDocument/didClose', { textDocument: { uri: uri('app.contract') } });
await settle();
check('root: closed without saving, the saved file is what counts', errors('app.contract').length === 0, errors('app.contract').map(where).join(', '));

server.kill();
rmSync(app, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
