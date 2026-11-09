#!/usr/bin/env python3
"""Print how each token of a .contract file is highlighted (the last matching pattern wins, as in Zed).
Usage: test/highlight-dump.py <file.contract> [first-line last-line]   (run from the repo root)"""
import re, subprocess, sys
from pathlib import Path
root = Path(__file__).resolve().parent.parent
src = Path(sys.argv[1]).resolve()
lo, hi = (int(sys.argv[2]), int(sys.argv[3])) if len(sys.argv) > 3 else (1, 10**9)
out = subprocess.run(["tree-sitter", "query", str(root / "languages/contract/highlights.scm"), str(src)], cwd=root / "grammar", capture_output=True, text=True).stdout
best, pattern = {}, -1
for line in out.splitlines():
    m = re.match(r"\s*pattern: (\d+)", line)
    if m: pattern = int(m.group(1)); continue
    m = re.match(r"\s*capture: \d+ - ([\w.]+), start: \((\d+), (\d+)\), end: \((\d+), (\d+)\)", line)
    if m and not m.group(1).startswith("_"):
        key = (int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5)))
        if key not in best or pattern >= best[key][0]: best[key] = (pattern, m.group(1))
lines = src.read_text().split("\n")
for (r, c, r2, c2), (_, name) in sorted(best.items()):
    if lo <= r + 1 <= hi and r == r2 and name not in ("string", "embedded") or (lo <= r + 1 <= hi and name == "string" and c2 - c < 30 and r == r2):
        print(f"{r + 1:>4}  {name:<22} {lines[r][c:c2]}")
