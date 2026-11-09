#!/usr/bin/env node
// A language server for Exact Contract (.contract).
//
// It holds no knowledge of the language. Every answer comes from the Contract
// compiler's own machine output:
//   contract build <root> --json      diagnostics
//   contract symbols <root>           definitions and references
//   contract fmt --stdout <file>      formatting
//   contract fmt --uses <root>        the `use` lines a file lacks
//   contract vocab --json --all       tags, attributes, functions, concepts
// So it stays right as the language changes, and is only as fresh as the files
// on disk: diagnostics and navigation follow each save.
//
// No dependencies. Runs on Node 18+ (or Bun).

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join, basename, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- transport

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const length = Number(/Content-Length: *(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))?.[1]);
    if (!Number.isFinite(length)) { buffer = buffer.subarray(headerEnd + 4); continue; }
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
    buffer = buffer.subarray(headerEnd + 4 + length);
    let message;
    try { message = JSON.parse(body); } catch { continue; }
    dispatch(message);
  }
});
process.stdin.on('end', () => process.exit(0));

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
const notify = (method, params) => send({ method, params });
const log = (text) => notify('window/logMessage', { type: 3, message: `contract-lsp: ${text}` });

// -------------------------------------------------------------------- state

/** Open buffers: uri -> text. What is on screen, which may be ahead of the disk. */
const documents = new Map();
/** Per app root (an `app.contract`, or a lone file): its compiler, symbols and published files. */
const roots = new Map();
let options = {};
let vocab = null, vocabFrom = null;
let shuttingDown = false;
const warned = new Set();

const pathOf = (uri) => fileURLToPath(uri);
const uriOf = (path) => pathToFileURL(path).href;

/** The text of a file: the open buffer when there is one, else the disk. */
function textOf(path) {
  const open = documents.get(uriOf(path));
  if (open !== undefined) return open;
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}
/** Disk text only: what the compiler's positions refer to. */
function diskLines(path, cache) {
  if (!cache.has(path)) {
    let text = '';
    try { text = readFileSync(path, 'utf8'); } catch {}
    cache.set(path, text.split('\n'));
  }
  return cache.get(path);
}

// ------------------------------------------------------------ positions
// The compiler counts lines from 1 and columns from 1 in UTF-8 bytes. LSP counts
// both from 0, columns in UTF-16 code units.

function byteColToChar(line, col) {
  if (!line || col <= 1) return 0;
  return Buffer.from(line, 'utf8').subarray(0, col - 1).toString('utf8').length;
}
function charToByteCol(line, character) {
  return Buffer.byteLength((line ?? '').slice(0, character), 'utf8') + 1;
}
function rangeOf(entry, lines) {
  const line = Math.max(0, (entry.line || 1) - 1);
  const text = lines[line] ?? '';
  const start = byteColToChar(text, entry.col || 1);
  let end = byteColToChar(text, entry.end_col || entry.col || 1);
  if (end <= start) end = entry.col ? Math.max(start + 1, start) : text.length;
  return { start: { line, character: start }, end: { line, character: Math.max(end, start) } };
}

// ------------------------------------------------------------- the compiler

/** The app a file belongs to: the nearest `app.contract` above it, else the file itself. */
function rootFor(path) {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const candidate = join(dir, 'app.contract');
    if (existsSync(candidate)) return candidate;
    if (dir === dirname(dir)) return path;
  }
}

/** The compiler binary: a setting, an environment variable, or the exact checkout found from the app. */
function compilerFor(rootPath) {
  const name = process.platform === 'win32' ? 'contract.exe' : 'contract';
  const named = options.contractPath || process.env.EXACT_CONTRACT;
  if (named && existsSync(named)) return named;
  const checkouts = [];
  if (options.exactPath) checkouts.push(options.exactPath);
  for (let dir = dirname(rootPath); ; dir = dirname(dir)) {
    checkouts.push(dir);                                               // a file inside the exact checkout
    if (existsSync(join(dir, 'exact.mjs'))) {                          // an app made by `exact new`
      checkouts.push(resolve(dir, process.env.EXACT2 ?? '../exact'));
      const text = (() => { try { return readFileSync(join(dir, 'exact.mjs'), 'utf8'); } catch { return ''; } })();
      const fallback = /process\.env\.EXACT2\s*\?\?\s*["']([^"']+)["']/.exec(text)?.[1];
      if (fallback) checkouts.push(resolve(dir, fallback));
    }
    if (dir === dirname(dir)) break;
  }
  if (process.env.EXACT2) checkouts.push(process.env.EXACT2);
  for (const checkout of checkouts) {
    for (const profile of ['debug', 'release']) {
      const binary = join(checkout, 'target', profile, name);
      if (existsSync(binary) && existsSync(join(checkout, 'contract'))) return binary;
    }
  }
  return null;
}

function run(binary, args, cwd) {
  return new Promise((done) => {
    execFile(binary, args, { cwd, maxBuffer: 256 * 1024 * 1024, timeout: 30000 }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

function rootState(rootPath) {
  let state = roots.get(rootPath);
  if (!state) {
    state = { path: rootPath, dir: dirname(rootPath), compiler: undefined, symbols: null, published: new Set(), timer: null, running: false, again: false, diagnostics: [] };
    roots.set(rootPath, state);
  }
  if (state.compiler === undefined || (state.compiler && !existsSync(state.compiler))) state.compiler = compilerFor(rootPath);
  if (!state.compiler && !warned.has(rootPath)) {
    warned.add(rootPath);
    notify('window/showMessage', { type: 2, message: 'Contract: no compiler found. Build it once in your exact checkout (`bun exact.mjs contract build app.contract`), or set lsp.contract-lsp.initialization_options.contractPath.' });
  }
  return state;
}

const absolute = (state, file) => (file == null ? state.path : isAbsolute(file) ? file : resolve(state.dir, file));

function schedule(rootPath, delay = 120) {
  const state = rootState(rootPath);
  if (!state.compiler) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => refresh(state), delay);
}

/** Compile the app from disk: publish its diagnostics, and keep its symbols when it compiles. */
async function refresh(state) {
  if (state.running) { state.again = true; return; }
  state.running = true;
  try {
    const [build, symbols] = await Promise.all([
      run(state.compiler, ['build', state.path, '--json'], state.dir),
      run(state.compiler, ['symbols', state.path], state.dir),
    ]);
    let diagnostics = [];
    try { diagnostics = JSON.parse(build.stdout || '[]'); } catch { log(`build printed no JSON: ${build.stderr.slice(0, 300)}`); }
    state.diagnostics = diagnostics;
    const lineCache = new Map(), byFile = new Map();
    for (const d of diagnostics) {
      const file = absolute(state, d.file);
      if (!byFile.has(file)) byFile.set(file, []);
      const lines = diskLines(file, lineCache);
      byFile.get(file).push({
        range: rangeOf(d, lines),
        severity: d.severity === 'error' ? 1 : d.severity === 'warning' ? 2 : 3,
        code: d.id, source: 'contract', message: d.message,
        relatedInformation: (d.related ?? []).filter((r) => r && r.line).map((r) => {
          const relatedFile = absolute(state, r.file ?? d.file);
          return { location: { uri: uriOf(relatedFile), range: rangeOf(r, diskLines(relatedFile, lineCache)) }, message: r.message ?? '' };
        }),
      });
    }
    for (const file of state.published) if (!byFile.has(file)) notify('textDocument/publishDiagnostics', { uri: uriOf(file), diagnostics: [] });
    for (const [file, list] of byFile) notify('textDocument/publishDiagnostics', { uri: uriOf(file), diagnostics: list });
    state.published = new Set(byFile.keys());

    if (symbols.code === 0) {
      try {
        const parsed = JSON.parse(symbols.stdout);
        for (const list of [parsed.definitions, parsed.references]) for (const entry of list) entry.file = absolute(state, entry.file);
        parsed.lines = lineCache;
        state.symbols = parsed;
      } catch { /* keep the last good symbols */ }
    }
  } finally {
    state.running = false;
    if (state.again) { state.again = false; schedule(state.path, 50); }
  }
}

async function loadVocab(compiler) {
  if (vocab && vocabFrom === compiler) return vocab;
  const out = await run(compiler, ['vocab', '--json', '--all'], dirname(compiler));
  try {
    const raw = JSON.parse(out.stdout);
    const index = new Map();
    const add = (name, markdown) => { if (name && !index.has(name)) index.set(name, markdown); };
    for (const f of raw.functions ?? []) {
      add(f.name, [`**${f.name}** · ${f.kind}`, ...(f.rules ?? []).map((r) => [r.call, r.rule, r.example && `Example: ${r.example}`].filter(Boolean).join('\n\n'))].join('\n\n'));
    }
    for (const t of raw.tags ?? []) {
      add(t.name, [`**${t.name}** · tag (${t.family}${t.node ? `, a ${t.node}` : ''})`, t.positional && `Positional: ${typeof t.positional === 'string' ? t.positional : JSON.stringify(t.positional)}`, t.note].filter(Boolean).join('\n\n'));
    }
    for (const h of raw.html ?? []) add(h.name, `**${h.name}** · HTML name${h.hint ? `\n\n${h.hint}` : ''}`);
    for (const a of raw.attributes ?? []) {
      const rows = (a.rows ?? []).map((r) => `- \`${r.row}\`: ${r.codec}${r.default != null ? `, default \`${r.default}\`` : ''}${r.values?.length ? ` · ${r.values.map((v) => `\`${v}\``).join(' ')}` : ''}`);
      add(a.name, [`**${a.name}** · ${a.kind} attribute`, rows.join('\n')].filter(Boolean).join('\n\n'));
    }
    for (const c of raw.contextual ?? []) add(c.name, `**${c.name}** · attribute, only on ${c.only}`);
    for (const r of raw.renamed ?? []) add(r.name, `**${r.name}** was renamed: use \`${r.use}\``);
    for (const c of raw.commands ?? []) add(c, `**${c}** · host command`);
    for (const c of raw.concepts ?? []) add(c.name ?? c.id, c.answer);
    vocab = { raw, index };
    vocabFrom = compiler;
  } catch { vocab = { raw: {}, index: new Map() }; }
  return vocab;
}

// ------------------------------------------------------------------ queries

const WORD = /-{0,2}[A-Za-z_](?:[A-Za-z0-9_]|-[A-Za-z])*/g;
function wordAt(text, position) {
  const line = text.split('\n')[position.line] ?? '';
  for (const match of line.matchAll(WORD)) {
    if (match.index <= position.character && position.character <= match.index + match[0].length) return { word: match[0], start: match.index, end: match.index + match[0].length, line };
  }
  return null;
}

/** The symbol under a position: a reference (with its definition) or a definition itself. */
function symbolAt(state, path, position) {
  const symbols = state.symbols;
  if (!symbols) return null;
  const lines = diskLines(path, symbols.lines);
  const line = position.line + 1, col = charToByteCol(lines[position.line], position.character);
  const hit = (entry) => entry.file === path && entry.line === line && entry.col <= col && col <= entry.end_col && entry.end_col > entry.col;
  const reference = symbols.references.find(hit);
  if (reference) return { index: reference.to, definition: symbols.definitions[reference.to], at: reference };
  const index = symbols.definitions.findIndex(hit);
  if (index >= 0) return { index, definition: symbols.definitions[index], at: symbols.definitions[index] };
  return null;
}
function locationOf(state, entry) {
  return { uri: uriOf(entry.file), range: rangeOf(entry, diskLines(entry.file, state.symbols.lines)) };
}
const stateFor = (uri) => rootState(rootFor(pathOf(uri)));

const SYMBOL_KIND = { component: 5, shape: 23, field: 8, prop: 7, state: 13, derive: 13, resource: 13, mutation: 24, action: 12, task: 24, source: 12, route: 2, parameter: 13, local: 13, fn: 12, function: 12, style: 5, keyframes: 5 };
const COMPLETION_KIND = { component: 7, shape: 22, field: 5, prop: 10, state: 6, derive: 6, resource: 6, mutation: 23, action: 3, task: 23, source: 3, fn: 3, function: 3, parameter: 6, local: 6, route: 9 };
const OUTLINE = new Set(['component', 'shape', 'fn', 'function', 'style', 'keyframes', 'state', 'derive', 'resource', 'mutation', 'action', 'task', 'prop', 'field', 'route']);
const HEAD_KEYWORDS = ['component', 'shape', 'fn', 'style', 'keyframes', 'routes', 'use', 'members', 'props', 'view', 'state', 'derive', 'resource', 'mutation', 'action', 'task', 'if', 'else', 'for', 'match', 'case', 'let', 'send', 'refresh', 'inject', 'provide', 'slot', 'test'];

function describe(definition) {
  if (!definition) return null;
  const owner = definition.component ?? definition.owner;
  const parts = [`**${definition.name}** · ${definition.kind}${owner ? ` of \`${owner}\`` : ''}`];
  if (definition.type) parts.push(`Type: \`${definition.type}\``);
  if (definition.writes?.length) parts.push(`Writes: ${definition.writes.map((w) => `\`${w}\``).join(', ')}`);
  if (definition.reads?.length) parts.push(`Reads: ${definition.reads.map((w) => `\`${w}\``).join(', ')}`);
  if (definition.file && !definition.file.endsWith('.contract')) parts.push(`From \`${basename(dirname(definition.file))}\``);
  return parts.join('\n\n');
}

/** The component whose body holds a line: the nearest `component X` or `members X` above it. */
function componentAt(text, line) {
  const lines = text.split('\n');
  for (let i = Math.min(line, lines.length - 1); i >= 0; i--) {
    const match = /^(?:component|members)\s+([A-Za-z_][\w-]*)/.exec(lines[i]);
    if (match) return match[1];
  }
  return null;
}

// ----------------------------------------------------------------- handlers

const handlers = {
  initialize(params) {
    options = params.initializationOptions ?? {};
    return {
      capabilities: {
        positionEncoding: 'utf-16',
        textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
        definitionProvider: true,
        referencesProvider: true,
        hoverProvider: true,
        documentSymbolProvider: true,
        documentFormattingProvider: true,
        completionProvider: { triggerCharacters: [] },
        codeActionProvider: { codeActionKinds: ['quickfix', 'source.organizeImports'] },
        executeCommandProvider: { commands: ['contract.addUses'] },
      },
      serverInfo: { name: 'contract-lsp', version: '0.1.0' },
    };
  },
  initialized() {},
  shutdown() { shuttingDown = true; return null; },
  exit() { process.exit(shuttingDown ? 0 : 1); },

  'textDocument/didOpen'({ textDocument }) {
    documents.set(textDocument.uri, textDocument.text);
    schedule(rootFor(pathOf(textDocument.uri)), 20);
  },
  'textDocument/didChange'({ textDocument, contentChanges }) {
    const last = contentChanges[contentChanges.length - 1];
    if (last && typeof last.text === 'string') documents.set(textDocument.uri, last.text);
  },
  'textDocument/didSave'({ textDocument }) { schedule(rootFor(pathOf(textDocument.uri))); },
  'textDocument/didClose'({ textDocument }) { documents.delete(textDocument.uri); },
  'workspace/didChangeWatchedFiles'({ changes }) {
    for (const change of changes ?? []) if (change.uri.endsWith('.contract')) schedule(rootFor(pathOf(change.uri)));
  },
  'workspace/didChangeConfiguration'() {},

  'textDocument/definition'({ textDocument, position }) {
    const state = stateFor(textDocument.uri);
    const found = symbolAt(state, pathOf(textDocument.uri), position);
    return found?.definition ? [locationOf(state, found.definition)] : null;
  },

  'textDocument/references'({ textDocument, position, context }) {
    const state = stateFor(textDocument.uri);
    const found = symbolAt(state, pathOf(textDocument.uri), position);
    if (!found) return [];
    const out = state.symbols.references.filter((r) => r.to === found.index).map((r) => locationOf(state, r));
    if (context?.includeDeclaration && found.definition) out.unshift(locationOf(state, found.definition));
    return out;
  },

  async 'textDocument/hover'({ textDocument, position }) {
    const state = stateFor(textDocument.uri);
    const path = pathOf(textDocument.uri);
    const parts = [];
    const found = symbolAt(state, path, position);
    if (found?.definition) parts.push(describe(found.definition));
    const word = wordAt(textOf(path), position);
    if (word && state.compiler) {
      const doc = (await loadVocab(state.compiler)).index.get(word.word);
      // A name the app declares shadows the vocabulary's entry of the same spelling.
      if (doc && !found?.definition) parts.push(doc);
    }
    if (!parts.length) return null;
    return { contents: { kind: 'markdown', value: parts.join('\n\n---\n\n') } };
  },

  'textDocument/documentSymbol'({ textDocument }) {
    const state = stateFor(textDocument.uri);
    const path = pathOf(textDocument.uri);
    if (!state.symbols) return [];
    const lines = diskLines(path, state.symbols.lines);
    const mine = state.symbols.definitions.filter((d) => d.file === path && OUTLINE.has(d.kind) && d.line > 0);
    const node = (d) => {
      const selection = rangeOf(d, lines);
      const whole = { start: { line: selection.start.line, character: 0 }, end: { line: selection.start.line, character: (lines[selection.start.line] ?? '').length } };
      return { name: d.name, detail: d.kind, kind: SYMBOL_KIND[d.kind] ?? 13, range: whole, selectionRange: selection, children: [] };
    };
    const top = [], parents = new Map();
    for (const d of mine) if (d.kind === 'component' || d.kind === 'shape') { const n = node(d); parents.set(d.name, n); top.push(n); }
    for (const d of mine) {
      if (d.kind === 'component' || d.kind === 'shape') continue;
      const parent = parents.get(d.component ?? d.owner);
      if (parent) {
        const child = node(d);
        parent.children.push(child);
        if (child.range.end.line > parent.range.end.line) parent.range.end = child.range.end;
      } else top.push(node(d));
    }
    return top.sort((a, b) => a.range.start.line - b.range.start.line);
  },

  async 'textDocument/formatting'({ textDocument }) {
    const state = stateFor(textDocument.uri);
    if (!state.compiler) return null;
    const path = pathOf(textDocument.uri);
    const text = textOf(path);
    const dir = mkdtempSync(join(tmpdir(), 'contract-fmt-'));
    try {
      const file = join(dir, basename(path));
      writeFileSync(file, text);
      const out = await run(state.compiler, ['fmt', '--stdout', file], dir);
      if (out.code !== 0 || !out.stdout || out.stdout === text) return out.code === 0 ? [] : null;
      const lines = text.split('\n');
      return [{ range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines[lines.length - 1].length } }, newText: out.stdout }];
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },

  async 'textDocument/completion'({ textDocument, position }) {
    const state = stateFor(textDocument.uri);
    const path = pathOf(textDocument.uri);
    const text = textOf(path);
    const line = (text.split('\n')[position.line] ?? '').slice(0, position.character);
    const atHead = /^\s*[A-Za-z_-]*$/.test(line);
    const afterDot = /\.[A-Za-z_]*$/.test(line);
    const items = [], seen = new Set();
    const add = (label, kind, detail, extra = {}) => { const key = `${label}:${kind}`; if (!seen.has(key)) { seen.add(key); items.push({ label, kind, detail, ...extra }); } };
    const symbols = state.symbols?.definitions ?? [];
    const component = componentAt(text, position.line);
    const vocabulary = state.compiler ? (await loadVocab(state.compiler)).raw : {};

    if (afterDot) {
      for (const d of symbols) if (d.kind === 'field') add(d.name, 5, `field of ${d.owner ?? ''}`);
      return { isIncomplete: false, items };
    }
    if (atHead) {
      for (const k of HEAD_KEYWORDS) add(k, 14, 'keyword');
      for (const t of vocabulary.tags ?? []) add(t.name, 25, `tag (${t.family})`);
      for (const d of symbols) if (d.kind === 'component') add(d.name, 7, 'component');
    } else {
      for (const a of vocabulary.attributes ?? []) add(a.name, 10, `${a.kind} attribute`, { insertText: `${a.name}=` });
      for (const c of vocabulary.contextual ?? []) add(c.name, 10, `attribute, only on ${c.only}`, { insertText: `${c.name}=` });
      for (const f of vocabulary.functions ?? []) add(f.name, 3, f.kind);
      for (const c of vocabulary.commands ?? []) add(c, 3, 'host command');
      for (const d of symbols) if (d.kind === 'shape' || d.kind === 'component') add(d.name, COMPLETION_KIND[d.kind], d.kind);
    }
    // The names the surrounding component declares: its state, derives, resources, actions, props.
    for (const d of symbols) {
      if (!COMPLETION_KIND[d.kind] || d.kind === 'field' || d.kind === 'shape' || d.kind === 'component') continue;
      if (d.component && d.component === component) add(d.name, COMPLETION_KIND[d.kind], d.kind);
    }
    return { isIncomplete: false, items };
  },

  'textDocument/codeAction'({ textDocument }) {
    const state = stateFor(textDocument.uri);
    if (!state.diagnostics.some((d) => d.id === 'contract-use-missing')) return [];
    return [{ title: 'Contract: write the missing `use` lines', kind: 'quickfix', command: { title: 'Write missing use lines', command: 'contract.addUses', arguments: [state.path] } }];
  },

  async 'workspace/executeCommand'({ command, arguments: args }) {
    if (command !== 'contract.addUses') return null;
    const state = rootState(args?.[0]);
    if (!state.compiler) return null;
    const out = await run(state.compiler, ['fmt', '--uses', state.path], state.dir);
    if (out.code !== 0) notify('window/showMessage', { type: 2, message: `contract fmt --uses: ${(out.stderr || out.stdout).slice(0, 400)}` });
    schedule(state.path, 20);
    return null;
  },
};

async function dispatch(message) {
  const handler = handlers[message.method];
  const isRequest = message.id !== undefined && message.method;
  if (!handler) {
    if (isRequest) send({ id: message.id, error: { code: -32601, message: `unsupported: ${message.method}` } });
    return;
  }
  try {
    const result = await handler(message.params ?? {});
    if (isRequest) send({ id: message.id, result: result ?? null });
  } catch (error) {
    log(`${message.method} failed: ${error?.stack ?? error}`);
    if (isRequest) send({ id: message.id, error: { code: -32603, message: String(error?.message ?? error) } });
  }
}
