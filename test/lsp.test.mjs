// Drives the server over stdio against a real app. Usage: node test/lsp.test.mjs <app-dir>
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const app = resolve(process.argv[2] ?? '../weatherlight');
const server = spawn(process.execPath, [fileURLToPath(new URL('../server/contract-lsp.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = Buffer.alloc(0), nextId = 1;
const pending = new Map(), diagnostics = new Map(), waiters = [];
server.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
    buffer = buffer.subarray(end + 4 + length);
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    else if (message.method === 'textDocument/publishDiagnostics') { diagnostics.set(message.params.uri, message.params.diagnostics); waiters.splice(0).forEach((w) => w()); }
    else if (message.method?.startsWith('window/')) console.log('  [server]', message.params.message);
  }
});
const write = (m) => { const b = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...m })); server.stdin.write(`Content-Length: ${b.length}\r\n\r\n`); server.stdin.write(b); };
const request = (method, params) => new Promise((done) => { const id = nextId++; pending.set(id, (m) => done(m.error ? { error: m.error } : m.result)); write({ id, method, params }); });
const notify = (method, params) => write({ method, params });
const uri = (rel) => pathToFileURL(join(app, rel)).href;
const text = (rel) => readFileSync(join(app, rel), 'utf8');
const open = (rel) => notify('textDocument/didOpen', { textDocument: { uri: uri(rel), languageId: 'contract', version: 1, text: text(rel) } });
const find = (rel, needle, nth = 0) => { const lines = text(rel).split('\n'); let seen = 0; for (let i = 0; i < lines.length; i++) { let at = -1; while ((at = lines[i].indexOf(needle, at + 1)) >= 0) if (seen++ === nth) return { line: i, character: at + 1 }; } throw new Error(`no ${needle} in ${rel}`); };
const short = (u) => u.replace(pathToFileURL(app).href + '/', '');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); if (!ok) failed++; };

const init = await request('initialize', { processId: process.pid, rootUri: pathToFileURL(app).href, capabilities: {} });
check('initialize', !!init.capabilities?.definitionProvider);
notify('initialized', {});
open('app.contract'); open('contract/views/location.contract');
await new Promise((done) => { waiters.push(done); setTimeout(done, 8000); });
await new Promise((done) => setTimeout(done, 400));

const all = [...diagnostics.entries()].flatMap(([u, list]) => list.map((d) => `${short(u)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${d.code}`));
check('diagnostics published', all.length >= 2, all.join(' | '));

const def = await request('textDocument/definition', { textDocument: { uri: uri('app.contract') }, position: find('app.contract', 'choose=choose') });
check('definition: Header prop `choose` in app.contract', def?.[0]?.uri.endsWith('header.contract'), def?.[0] && `${short(def[0].uri)}:${def[0].range.start.line + 1}`);
const def2 = await request('textDocument/definition', { textDocument: { uri: uri('app.contract') }, position: find('app.contract', 'SearchPanel(') });
check('definition: component SearchPanel', def2?.[0]?.uri.endsWith('search-panel.contract'), def2?.[0] && `${short(def2[0].uri)}:${def2[0].range.start.line + 1}`);
const def3 = await request('textDocument/definition', { textDocument: { uri: uri('contract/views/location.contract') }, position: find('contract/views/location.contract', 'GeolocationStatus', 1) });
check('definition: module shape', !!def3?.[0], def3?.[0] && def3[0].uri.split('/').slice(-3).join('/'));

const refs = await request('textDocument/references', { textDocument: { uri: uri('contract/views/location.contract') }, position: find('contract/views/location.contract', 'city = "San Francisco"'), context: { includeDeclaration: true } });
check('references: state `city`', refs.length >= 3, `${refs.length} in ${[...new Set(refs.map((r) => short(r.uri)))].join(', ')}`);

const hover = await request('textDocument/hover', { textDocument: { uri: uri('contract/views/location.contract') }, position: find('contract/views/location.contract', 'action choose'.slice(7)) });
check('hover: action', /action/.test(hover?.contents?.value ?? ''), (hover?.contents?.value ?? '').replace(/\n+/g, ' ').slice(0, 110));
open('contract/components/header.contract');
const hover2 = await request('textDocument/hover', { textDocument: { uri: uri('contract/components/header.contract') }, position: find('contract/components/header.contract', 'border-radius') });
check('hover: attribute from vocab', /attribute/.test(hover2?.contents?.value ?? ''), (hover2?.contents?.value ?? '').replace(/\n+/g, ' ').slice(0, 110));
const hover3 = await request('textDocument/hover', { textDocument: { uri: uri('contract/components/header.contract') }, position: find('contract/components/header.contract', 'button press') });
check('hover: tag from vocab', /tag/.test(hover3?.contents?.value ?? ''), (hover3?.contents?.value ?? '').replace(/\n+/g, ' ').slice(0, 110));

const outline = await request('textDocument/documentSymbol', { textDocument: { uri: uri('contract/components/header.contract') } });
check('documentSymbol: Header with props', outline?.[0]?.name === 'Header' && outline[0].children.length >= 10, `${outline?.[0]?.name} + ${outline?.[0]?.children.length} children`);
const outline2 = await request('textDocument/documentSymbol', { textDocument: { uri: uri('contract/views/location.contract') } });
check('documentSymbol: members file', outline2.length >= 10, outline2.slice(0, 6).map((s) => `${s.detail} ${s.name}`).join(', '));

const fmt = await request('textDocument/formatting', { textDocument: { uri: uri('contract/views/location.contract') }, options: { tabSize: 2, insertSpaces: true } });
check('formatting: already formatted file gives no edits', Array.isArray(fmt) && fmt.length === 0);
const messy = 'component A\n  view\n      text   "hi"\n';
notify('textDocument/didOpen', { textDocument: { uri: uri('contract/components/zz-scratch.contract'), languageId: 'contract', version: 1, text: messy } });
const fmt2 = await request('textDocument/formatting', { textDocument: { uri: uri('contract/components/zz-scratch.contract') }, options: { tabSize: 2, insertSpaces: true } });
check('formatting: unsaved buffer is reformatted', fmt2?.[0]?.newText === 'component A\n  view\n    text "hi"\n', JSON.stringify(fmt2?.[0]?.newText));

const head = await request('textDocument/completion', { textDocument: { uri: uri('contract/components/header.contract') }, position: { line: 20, character: 4 } });
const labels = new Set(head.items.map((i) => i.label));
check('completion at line head: tags, keywords, components', labels.has('button') && labels.has('if') && labels.has('Header'), `${head.items.length} items`);
const where = find('contract/components/header.contract', 'padding=11');
const mid = await request('textDocument/completion', { textDocument: { uri: uri('contract/components/header.contract') }, position: where });
const midLabels = new Set(mid.items.map((i) => i.label));
check('completion mid-line: attributes, functions, own props', midLabels.has('border-radius') && midLabels.has('pending') && midLabels.has('useLocation'), `${mid.items.length} items`);

await request('shutdown', null); notify('exit', null);
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
