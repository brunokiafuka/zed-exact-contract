// Navigation while the program has errors. Usage: node test/partial.test.mjs <contract binary>
// With a compiler that prints partial symbols (exact d42b9c1a or later) names keep resolving
// through an error; with an older one the last good table is kept. Both must pass.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const compiler = resolve(process.argv[2] ?? '../exact/target/debug/contract');
const app = mkdtempSync(join(tmpdir(), 'contract-partial-'));
mkdirSync(join(app, 'parts'));
const ROW = 'shape Item\n  id: string\n  title: string\n\ncomponent Row\n  props\n    item: Item\n    pick: action\n  view\n    button press=pick(item.id)\n      text item.title\n';
const APP = (extra, added = '') => `use Row, Item from "./parts/row.contract"\n\ncomponent App\n  state chosen = ""\n  state items = [Item(id="a", title="A")]\n${added}  action pick(id: string)\n    chosen = id${extra}\n  view\n    column\n      for item in items key=item.id\n        Row(item=item, pick=pick)\n      text chosen\n`;
const files = { 'app.contract': APP(''), 'parts/row.contract': ROW };
let version = 1, started = false;
// As an editor does: the buffer changes, then the file is saved.
const save = (rel, text) => {
  files[rel] = text; writeFileSync(join(app, rel), text);
  if (started && rel === 'app.contract') notify('textDocument/didChange', { textDocument: { uri: uri(rel), version: ++version }, contentChanges: [{ text }] });
};
for (const [rel, text] of Object.entries(files)) save(rel, text);

const server = spawn(process.execPath, [fileURLToPath(new URL('../server/contract-lsp.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = Buffer.alloc(0), nextId = 1, published = 0;
const pending = new Map();
server.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
    buffer = buffer.subarray(end + 4 + length);
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message.result); pending.delete(message.id); }
    else if (message.method === 'textDocument/publishDiagnostics') published++;
  }
});
const write = (m) => { const b = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...m })); server.stdin.write(`Content-Length: ${b.length}\r\n\r\n`); server.stdin.write(b); };
const request = (method, params) => new Promise((done) => { const id = nextId++; pending.set(id, done); write({ id, method, params }); });
const notify = (method, params) => write({ method, params });
const uri = (rel) => pathToFileURL(join(app, rel)).href;
const settle = () => new Promise((done) => setTimeout(done, 900));
const at = (rel, needle) => { const lines = files[rel].split('\n'); for (let i = 0; i < lines.length; i++) { const c = lines[i].indexOf(needle); if (c >= 0) return { line: i, character: c + 1 }; } throw new Error(`no ${needle}`); };
const definition = async (rel, needle) => (await request('textDocument/definition', { textDocument: { uri: uri(rel) }, position: at(rel, needle) }))?.[0];
const where = (loc) => (loc ? `${loc.uri.split('/').slice(-1)[0]}:${loc.range.start.line + 1}` : 'nothing');
// With partial symbols a name must resolve to the right place. Without them the table is stale
// while an error stands, and the only acceptable alternative to the right place is no answer.
let partial = true;
const sound = (d, file, line) => (d ? d.uri.endsWith(file) && d.range.start.line === line : !partial);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); if (!ok) failed++; };

await request('initialize', { processId: process.pid, capabilities: {}, initializationOptions: { contractPath: compiler } });
notify('initialized', {});
notify('textDocument/didOpen', { textDocument: { uri: uri('app.contract'), languageId: 'contract', version: 1, text: files['app.contract'] } });
started = true;
await settle();
let d = await definition('app.contract', 'Row(item');
check('clean program: Row resolves', d?.uri.endsWith('row.contract'), where(d));

// A type error in the root: the rest of the program still resolves.
save('app.contract', APP(' + missing', '  state fresh = 0\n'));
notify('textDocument/didSave', { textDocument: { uri: uri('app.contract') } });
await settle();
d = await definition('app.contract', 'fresh = 0');
partial = !!d;
console.log(`     this compiler ${partial ? 'prints partial symbols: names resolve through an error' : 'prints no symbols on an error (before exact d42b9c1a): the last table is kept, and checked against the text'}`);
check('type error in the root: a name added in the same save', sound(d, 'app.contract', 5), where(d));
d = await definition('app.contract', 'Row(item');
check('type error in the root: Row', sound(d, 'row.contract', 4), where(d));
d = await definition('app.contract', 'chosen = id');
check('type error in the root: state on the erroring line', sound(d, 'app.contract', 3), where(d));

// A used file stops parsing: its names are carried from its last good version.
save('parts/row.contract', ROW.replace('text item.title', 'text "unclosed'));
notify('textDocument/didSave', { textDocument: { uri: uri('parts/row.contract') } });
await settle();
d = await definition('app.contract', 'Row(item');
check('used file unparseable: Row', sound(d, 'row.contract', 4), where(d));
const hover = await request('textDocument/hover', { textDocument: { uri: uri('app.contract') }, position: at('app.contract', 'Row(item') });
console.log(`     hover: ${(hover?.contents?.value ?? '').replace(/\n+/g, ' | ')}`);
d = await definition('app.contract', 'pick(id');
check('used file unparseable: the root\'s own action', sound(d, 'app.contract', 6), where(d));

// The root stops parsing: nothing to learn, the table is kept.
save('app.contract', files['app.contract'].replace('text chosen', 'text "unclosed'));
notify('textDocument/didSave', { textDocument: { uri: uri('app.contract') } });
await settle();
d = await definition('app.contract', 'Row(item');
check('root unparseable: the last table is kept', sound(d, 'row.contract', 4), where(d));

// Everything fixed: back to the compiler's own table, nothing stale.
save('parts/row.contract', ROW); save('app.contract', APP(''));
notify('textDocument/didSave', { textDocument: { uri: uri('app.contract') } });
await settle();
const fixed = await request('textDocument/hover', { textDocument: { uri: uri('app.contract') }, position: at('app.contract', 'Row(item') });
check('fixed: no stale marker', !/last version/.test(fixed?.contents?.value ?? '') && /component/.test(fixed?.contents?.value ?? ''));
check('diagnostics were published throughout', published >= 4, `${published} publishes`);

await request('shutdown', null); notify('exit', null);
rmSync(app, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
