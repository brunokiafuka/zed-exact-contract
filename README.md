# Exact Contract for Zed

Editor support for [Exact](https://github.com/expo/exact)'s `.contract` files in Zed:
syntax highlighting and an outline from a tree-sitter grammar, and a language
server that answers from the Contract compiler itself.

Unofficial. Exact is pre-1.0 and changes daily; this extension is built to follow it
rather than to restate it.

## What you get

| | From |
|---|---|
| Highlighting, outline, bracket matching, comment toggling | `grammar/` and `languages/contract/` |
| Diagnostics with the compiler's ids, on open and on save | `contract build --json` |
| Go to definition and find references, across files and `members` files | `contract symbols` |
| Hover: what a name is, what an action writes; docs for tags, attributes, functions | `contract symbols`, `contract vocab --json` |
| Format document | `contract fmt --stdout` |
| Completion: tags, attributes, functions, and the surrounding component's names | `contract vocab --json`, `contract symbols` |
| Quick fix: write the missing `use` lines | `contract fmt --uses` |

## Install

1. Build the Contract compiler once, in your Exact checkout or app:
   `bun exact.mjs contract build app.contract`.
2. Clone this repository.
3. In Zed, run **zed: install dev extension** from the command palette and choose the
   cloned folder. Zed compiles the grammar and the extension; Rust must be installed with rustup.

The server finds the compiler from the file you open: inside an Exact checkout it is
`target/debug/contract`; in an app made by `exact new` it follows `exact.mjs` to the
checkout (`EXACT2`, default `../exact`). To name it yourself, in Zed's settings:

```json
{
  "lsp": {
    "contract-lsp": {
      "initialization_options": { "contractPath": "/path/to/exact/target/debug/contract" }
    }
  }
}
```

## How it is built

- **The grammar is tolerant and line-oriented.** It models the lexical shape of a line
  (strings, templates, calls, attributes, bracketed groups) and knows no keywords.
  Keywords, tags and declarations are recognised in `highlights.scm`. A new keyword or
  tag in the language never breaks a parse; at worst it is uncoloured until the lists
  are refreshed. It parses all 765 `.contract` files in the Exact repository without an error.
- **The server holds no knowledge of the language.** It runs the compiler and
  translates. It reads files from disk, so diagnostics and navigation follow each save,
  not each keystroke. Formatting does use the unsaved buffer.
- **Names resolve while there is an error.** From Exact `d42b9c1a`, `contract symbols` prints
  what it can still resolve when the program has an error, and the server uses it. A file that
  cannot be parsed drops out of that output, so its names are carried from its last version that
  parsed, and hover says so. With an older compiler the last table is kept instead. Either way an
  entry answers only if its name is still the text at its position: no answer, never a wrong one.
- **No dependencies.** The server is one script, embedded in the extension and run on
  the Node that Zed manages.

## Keeping up with the language

```sh
scripts/gen-highlights.py ../exact/target/debug/contract   # refresh the tag and command lists
cd grammar && tree-sitter generate                         # after editing grammar.js
node test/lsp.test.mjs ../weatherlight                     # drive the server against a real app
node test/partial.test.mjs ../exact/target/debug/contract  # navigation while the program has errors
test/highlight-dump.py some.contract 1 20                  # see how each token is coloured
```

After changing `grammar/`, commit and push it, and set `rev` in `extension.toml` to that
commit: Zed builds the grammar from the commit it fetches, not from the working tree. To
try a grammar change before pushing, point `repository` at a `file://` URL of your clone.

## Limits

- No nested outline: the grammar does not track indentation, so the outline is flat.
- Diagnostics describe the saved files. An unsaved edit is not checked until saved: the compiler
  reads from disk, and whether it will take unsaved text is undecided upstream (expo/exact#21).
- Hover for a style attribute shows the compiler's row and a link to CSS's reference; the
  vocabulary carries no descriptions.
- Rename is not offered.
