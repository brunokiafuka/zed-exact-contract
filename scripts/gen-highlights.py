#!/usr/bin/env python3
"""Rewrite the tag and command lists in languages/contract/highlights.scm from the
compiler's own vocabulary. Usage: scripts/gen-highlights.py <path to the contract binary>"""
import json, re, subprocess, sys, textwrap
from pathlib import Path

EXTRA_CALLS = ["some", "pending", "failure", "empty", "after", "every"]

def words(items):
    line = " ".join(f'"{w}"' for w in items)
    return "\n".join(textwrap.wrap(line, 96, initial_indent="    ", subsequent_indent="    ", break_on_hyphens=False))

def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    vocab = json.loads(subprocess.run([sys.argv[1], "vocab", "--json", "--all"], capture_output=True, text=True, check=True).stdout)
    lists = {
        "tags": sorted({t["name"] for t in vocab["tags"]} | {t["name"] for t in vocab["html"]} | set(vocab["head"])),
        "commands": list(vocab["commands"]) + EXTRA_CALLS,
    }
    path = Path(__file__).resolve().parent.parent / "languages/contract/highlights.scm"
    text = path.read_text()
    for name, items in lists.items():
        pattern = re.compile(rf"(    ; generated: {name}\n).*?(    ; end generated\n)", re.S)
        if not pattern.search(text):
            sys.exit(f"no `generated: {name}` block in {path}")
        text = pattern.sub(lambda m: m.group(1) + words(items) + "\n" + m.group(2), text)
    path.write_text(text)
    print(f"{path.name}: {len(lists['tags'])} tags, {len(lists['commands'])} commands")

if __name__ == "__main__":
    main()
