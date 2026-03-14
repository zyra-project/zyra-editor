#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Build the editor poster HTML from section fragments.

Produces:
  poster/index.html — assembled from poster/sections/ fragments

Sections whose names appear in UPSTREAM_SECTIONS are fetched from the
zyra-project/zyra repository (mirror/main branch) at build time, so
content stays in sync with the upstream poster.  Use --local to skip
fetching and use only local section files.

When fetching upstream sections, the build script also pulls the
upstream _styles.css and scopes it inside a wrapper div using CSS
nesting, so upstream styles don't conflict with the editor poster.

Run from the repository root:
    python poster/scripts/build_poster.py          # fetch upstream sections
    python poster/scripts/build_poster.py --local   # local-only build

Output works with file:// protocol — no server required.
"""

from __future__ import annotations

import argparse
import sys
import urllib.request
import urllib.error
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SECTIONS_DIR = REPO_ROOT / "poster" / "sections"
OUTPUT = REPO_ROOT / "poster" / "index.html"

# GitHub raw content base for the upstream zyra poster sections
UPSTREAM_RAW_BASE = (
    "https://raw.githubusercontent.com/zyra-project/zyra"
    "/mirror/main/poster/sections"
)

# Map local section stem -> upstream section filename.
# Add entries here to pull more sections from the upstream poster.
UPSTREAM_SECTIONS: dict[str, str] = {
    "sec-03-pipeline": "sec-03-pipeline.html",
}

# Upstream styles URL (fetched once, scoped per upstream section)
UPSTREAM_STYLES_URL = f"{UPSTREAM_RAW_BASE}/_styles.css"


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="strict")
    except FileNotFoundError:
        print(f"ERROR: Missing file: {path}", file=sys.stderr)
        sys.exit(1)
    except OSError as exc:
        print(f"ERROR: Cannot read {path}: {exc}", file=sys.stderr)
        sys.exit(1)


def _fetch(url: str) -> str:
    """Fetch a URL and return its text content."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "zyra-editor-build"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        print(f"ERROR: HTTP {exc.code} fetching {url}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as exc:
        print(f"ERROR: Cannot fetch {url}: {exc.reason}", file=sys.stderr)
        sys.exit(1)


def _scope_css(css: str, scope_class: str) -> str:
    """Scope upstream CSS using CSS nesting under a wrapper class.

    Wraps the entire upstream stylesheet inside a `.<scope_class> { ... }`
    block.  With CSS nesting (baseline 2023, supported in all modern
    browsers), nested selectors like `.stage-bubble { ... }` resolve to
    `.<scope_class> .stage-bubble { ... }`.

    Rules targeting html/body/:root are intentionally scoped away so
    they don't leak into the editor poster.
    """
    return f".{scope_class} {{\n{css}\n}}\n"


def _wrap_upstream_section(
    html: str, css: str, stem: str, scope_class: str
) -> str:
    """Wrap upstream HTML with scoped styles in a container div."""
    scoped_css = _scope_css(css, scope_class)
    return (
        f"  <!-- ════════════════════════════════════════════════════\n"
        f"       UPSTREAM: {stem}\n"
        f"       (Auto-fetched from zyra-project/zyra poster)\n"
        f"       ════════════════════════════════════════════════════ -->\n"
        f"  <div class=\"{scope_class}\">\n"
        f"    <style>\n{scoped_css}    </style>\n"
        f"{html}\n"
        f"  </div>\n"
        f"\n  <div class=\"section-transition\"></div>\n"
    )


def build(*, local_only: bool = False) -> None:
    # ── Discover section files ──
    section_files = sorted(SECTIONS_DIR.glob("sec-*.html"))
    if not section_files:
        print("ERROR: No sec-*.html files found in", SECTIONS_DIR, file=sys.stderr)
        sys.exit(1)

    # ── Scaffold pieces ──
    head = _read(SECTIONS_DIR / "_head.html")
    styles = _read(SECTIONS_DIR / "_styles.css")
    body_open = _read(SECTIONS_DIR / "_body-open.html")
    footer = _read(SECTIONS_DIR / "_footer.html")

    # ── Fetch upstream styles once (if needed) ──
    upstream_css: str | None = None
    if not local_only and UPSTREAM_SECTIONS:
        print(f"  Fetching upstream styles: {UPSTREAM_STYLES_URL}")
        upstream_css = _fetch(UPSTREAM_STYLES_URL)

    # ── Assemble sections ──
    parts: list[str] = [head, styles, body_open]

    for sf in section_files:
        stem = sf.stem

        if not local_only and stem in UPSTREAM_SECTIONS:
            upstream_file = UPSTREAM_SECTIONS[stem]
            url = f"{UPSTREAM_RAW_BASE}/{upstream_file}"
            print(f"  Fetching upstream: {stem} <- {url}")
            html = _fetch(url)
            scope_class = f"upstream-{stem.replace('sec-', '').replace('-', '_')}"
            parts.append(
                _wrap_upstream_section(html, upstream_css or "", stem, scope_class)
            )
        else:
            parts.append(_read(sf))

    parts.append(footer)

    # ── Write output ──
    content = "".join(parts)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(content.encode("utf-8"))

    size_kb = OUTPUT.stat().st_size / 1024
    line_count = content.count("\n")
    section_names = [sf.stem for sf in section_files]
    upstream_used = [] if local_only else [
        s for s in section_names if s in UPSTREAM_SECTIONS
    ]

    print(f"\nBuilt {OUTPUT.relative_to(REPO_ROOT)}")
    print(f"  Sections:  {len(section_names)} ({', '.join(section_names)})")
    if upstream_used:
        print(f"  Upstream:  {', '.join(upstream_used)}")
    print(f"  Size:      {size_kb:.1f} KB")
    print(f"  Lines:     {line_count}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build the Zyra Editor poster from section fragments."
    )
    parser.add_argument(
        "--local",
        action="store_true",
        help="Skip fetching upstream sections; use only local files.",
    )
    args = parser.parse_args()
    build(local_only=args.local)


if __name__ == "__main__":
    main()
