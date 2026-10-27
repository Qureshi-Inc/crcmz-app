"""Every local module the server imports is copied into the image. The Dockerfile lists
files by name, and a missing one only shows in production: the app crash-loops on start
(live.py, 2026-10-27). Tests run on the repo folder, so nothing else catches it."""
import ast, re, sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
local = {p.stem for p in root.glob("*.py")}
copied = set()
for line in (root / "Dockerfile").read_text().splitlines():
    if line.startswith("COPY "):
        copied |= {Path(w).stem for w in line.split()[1:-1] if w.endswith(".py")}

def imports(path: Path) -> set[str]:
    out = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            out |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            out.add(node.module.split(".")[0])
    return out & local

# Everything reachable from server.py through local imports.
need, todo = set(), ["server"]
while todo:
    m = todo.pop()
    if m in need:
        continue
    need.add(m)
    todo += sorted(imports(root / f"{m}.py") - need)
missing = sorted(need - copied)
assert not missing, f"not copied into the image by the Dockerfile: {missing}"
print(f"test_dockerfile: ok ({len(need)} modules)")
