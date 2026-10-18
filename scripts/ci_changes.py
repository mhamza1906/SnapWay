"""Classify changed inputs for CI without running application builds for docs only."""

import os
import subprocess
from pathlib import Path, PurePosixPath

DOCUMENT_EXTENSIONS = {
    ".md",
    ".mdx",
    ".rst",
    ".adoc",
    ".asciidoc",
    ".pdf",
    ".doc",
    ".docx",
    ".odt",
    ".rtf",
}
DOCUMENT_NAMES = {
    "readme",
    "license",
    "licence",
    "notice",
    "copying",
    "authors",
    "changelog",
    "changes",
    "history",
    "contributing",
}


def is_documentation(path):
    file = PurePosixPath(path)
    return (
        any(part.lower() in {"docs", "doc", "documentation"} for part in file.parts[:-1])
        or file.suffix.lower() in DOCUMENT_EXTENSIONS
        or file.name.lower() in DOCUMENT_NAMES
        or (file.suffix.lower() == ".txt" and file.stem.lower() in DOCUMENT_NAMES)
    )


def classify_changes(paths):
    paths = [p for p in paths if not is_documentation(p) and not p.startswith("local/")]
    shared = any(p.startswith(("scripts/", ".github/", "contracts/", "infra/")) for p in paths)
    backend = shared or any(
        p.startswith(("apps/api/", "apps/mcp/", "packages/"))
        or p in {"pyproject.toml", "uv.lock", ".python-version", ".env.example"}
        for p in paths
    )
    web = shared or any(
        p.startswith("apps/web/") or p in {".node-version", ".editorconfig"} for p in paths
    )
    pipeline = shared or any(
        p.startswith("apps/pipeline/") or p in {".node-version", ".env.example"} for p in paths
    )
    return backend, web, pipeline


def main():
    base = os.environ.get("BASE_SHA", "")
    head = os.environ.get("HEAD_SHA", "HEAD")
    if not base or set(base) == {"0"}:
        paths = subprocess.check_output(["git", "ls-files"], text=True).splitlines()
    else:
        paths = subprocess.check_output(
            ["git", "diff", "--no-renames", "--name-only", base, head], text=True
        ).splitlines()
    backend, web, pipeline = classify_changes(paths)
    result = (
        f"backend={str(backend).lower()}\nweb={str(web).lower()}\n"
        f"pipeline={str(pipeline).lower()}\n"
    )
    print(result, end="")
    if output := os.environ.get("GITHUB_OUTPUT"):
        with Path(output).open("a", encoding="utf-8") as stream:
            stream.write(result)


if __name__ == "__main__":
    main()
