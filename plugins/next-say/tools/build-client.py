"""Build lib/client.js from client/client.template.js.

The browser loads ONE script per plugin, so the client half cannot use ES module
imports. Rather than keep a second copy of logic that the tests cover, this script
inlines three blocks into the template:

  lib/match.js        the pure history-completion functions
  lib/ghost.js        the in-composer ghost layer (measure + paint + clear)
  generated locales   ASCII-escaped zh/en dictionaries

Inlined sources are stripped of `export` markers and keep their own
implementation, so `node --test` exercises the exact bytes that run in the
browser.

Run:  python tools/build-client.py
      python tools/build-client.py --check     verify lib/client.js is up to date

Why `--check` exists: the build is a manual step, and forgetting it fails
silently. Editing lib/match.js or lib/ghost.js without re-running this script
leaves the OLD implementation in lib/client.js, which is the file the browser
actually loads -- so the tests pass (they import the source modules) while the
shipped bundle is stale. `--check` renders in memory and compares, writing
nothing.
"""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "client" / "client.template.js"
MATCH = ROOT / "lib" / "match.js"
GHOST = ROOT / "lib" / "ghost.js"
OUTPUT = ROOT / "lib" / "client.js"
LOCALES = ROOT / "lib" / "locales.js"

#: marker -> source file, applied in this order.
BLOCKS = (
    ("/*__LOCALES__*/", LOCALES),
    ("/*__MATCH__*/", MATCH),
    ("/*__GHOST__*/", GHOST),
)


class BuildError(Exception):
    """A build precondition failed; the message is already user-facing."""


def strip_exports(source: str) -> str:
    """Turn an ES module of plain declarations into a block of statements."""
    # Drop the file's top docblock: the generated file explains its own origin.
    source = re.sub(r"\A/\*\*.*?\*/\s*", "", source, flags=re.S)
    source = re.sub(r"^export\s+(async\s+)?(function|const|class|let|var)\s", r"\1\2 ", source, flags=re.M)
    source = re.sub(r"^export\s+\{[^}]*\};?\s*$", "", source, flags=re.M)
    source = re.sub(r"^import\s+.*?;\s*$", "", source, flags=re.M)
    # Guard: if a source module grows an `export default` or a multi-line export,
    # the patterns above leave it in the factory body -> a browser syntax error
    # while every unit test (which imports the source directly) stays green.
    # Fail the build instead of shipping a bundle that cannot load.
    leftover = re.search(r"^\s*export\b", source, flags=re.M)
    if leftover is not None:
        raise BuildError(
            "a source module still has an `export` after inlining (export default or "
            "multi-line export?); keep exports to single-line `export function|const|class` "
            "or `export { ... }`"
        )
    return source.strip()


def indent(source: str, prefix: str) -> str:
    lines = source.splitlines()
    return "\n".join(prefix + line if line.strip() else line for line in lines)


def render() -> str:
    """Render the bundle in memory.

    Returns the exact text that belongs in lib/client.js, including the single
    trailing newline. Raises BuildError with a model-facing message instead of
    calling sys.exit, so `--check` and the write path share one code path and can
    never drift apart.
    """
    if not TEMPLATE.is_file():
        raise BuildError(f"missing {TEMPLATE}")

    template = TEMPLATE.read_text(encoding="utf-8")

    for marker, source in BLOCKS:
        if not source.is_file():
            raise BuildError(f"missing {source}")
        if marker not in template:
            raise BuildError(f"template is missing {marker}")
        # The template indents its body by four spaces inside the factory.
        template = template.replace(marker, indent(strip_exports(source.read_text(encoding="utf-8")), "    "))

    built = template

    # The generated file must be pure LF: the workspace mirrors plugins into a git
    # repository with `* -text`, so a stray CRLF becomes a real byte difference.
    # (`lib/locales.js` is generated separately, and PowerShell redirection there
    # once produced CRLF, which is exactly how this went unnoticed.)
    if "\r" in built:
        raise BuildError("generated file contains CR; refusing to write CRLF")

    # Non-ASCII must not survive: the workspace keeps executable sources ASCII.
    offenders = [
        (number, line)
        for number, line in enumerate(built.splitlines(), start=1)
        if any(ord(char) > 0x7F for char in line)
    ]
    if offenders:
        details = "\n".join(f"non-ASCII at line {number}: {line[:120]!r}" for number, line in offenders[:10])
        raise BuildError(details)

    return built.rstrip() + "\n"


def count_functions(text: str) -> int:
    return len(re.findall(r"^\s{4}function\s", text, flags=re.M))


def describe_difference(expected: str, actual: str) -> list[str]:
    """Report where the checked-in bundle differs, in a form a human can act on."""
    expected_lines = expected.splitlines()
    actual_lines = actual.splitlines()
    messages: list[str] = []
    if len(expected_lines) != len(actual_lines):
        messages.append(f"line count: expected {len(expected_lines)}, found {len(actual_lines)}")

    # First divergence is the actionable one: everything after it is usually noise.
    limit = min(len(expected_lines), len(actual_lines))
    for index in range(limit):
        if expected_lines[index] != actual_lines[index]:
            messages.append(f"first difference at line {index + 1}:")
            messages.append(f"  expected: {expected_lines[index][:160]!r}")
            messages.append(f"  found   : {actual_lines[index][:160]!r}")
            break
    else:
        if len(expected_lines) != len(actual_lines):
            longer = expected_lines if len(expected_lines) > limit else actual_lines
            if limit < len(longer):
                messages.append(f"  extra line {limit + 1}: {longer[limit][:160]!r}")

    if not messages:
        # Same lines, different bytes: a trailing-newline or CR difference.
        messages.append(
            f"same lines but different bytes: expected {len(expected.encode('utf-8'))} bytes, "
            f"found {len(actual.encode('utf-8'))}"
        )
    return messages


def check() -> int:
    """Verify lib/client.js matches its sources. Writes nothing."""
    try:
        expected = render()
    except BuildError as error:
        print(str(error), file=sys.stderr)
        return 1

    if not OUTPUT.is_file():
        print(f"{OUTPUT.relative_to(ROOT)} is missing; run tools/build-client.py", file=sys.stderr)
        return 1

    actual = OUTPUT.read_bytes().decode("utf-8")
    if actual == expected:
        print(
            f"{OUTPUT.relative_to(ROOT)} is up to date "
            f"({len(expected.encode('utf-8'))} bytes, {count_functions(expected)} functions)"
        )
        return 0

    print(f"{OUTPUT.relative_to(ROOT)} is STALE: it does not match the template and sources.", file=sys.stderr)
    for message in describe_difference(expected, actual):
        print(message, file=sys.stderr)
    print("Run: python tools/build-client.py", file=sys.stderr)
    return 1


def main(argv: list[str]) -> int:
    if "--check" in argv:
        return check()

    try:
        built = render()
    except BuildError as error:
        print(str(error), file=sys.stderr)
        return 1

    OUTPUT.write_text(built, encoding="utf-8", newline="\n")
    final = OUTPUT.read_text(encoding="utf-8")
    print(
        f"built {OUTPUT.relative_to(ROOT)} from template + match.js + ghost.js + locales "
        f"({len(final.encode('utf-8'))} bytes, {count_functions(final)} functions)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
