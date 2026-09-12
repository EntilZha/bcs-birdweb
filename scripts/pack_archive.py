"""Pack archive/ into a dated, checksummed tarball for long-term storage.

The archive is the only surviving complete copy of the original BirdWeb, so this produces
something a person can hand to someone else in twenty years and still read: a single
compressed file, a sibling SHA256SUMS, and a README inside the tarball explaining what it
is, where it came from, and how it is laid out. Nothing about it requires this repository
or any of its tooling to open.

Output goes to dist-archive/ (gitignored). Upload it to the Birds Connect Seattle Google
Drive; that is where the durable copy lives.

Usage:
    pixi run archive-pack
"""

from __future__ import annotations

import hashlib
import json
import tarfile
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

REPO_ROOT = Path(__file__).resolve().parent.parent
ARCHIVE = REPO_ROOT / "archive"
OUT_DIR = REPO_ROOT / "dist-archive"
MANIFEST = ARCHIVE / "manifest.jsonl"

console = Console()
app = typer.Typer(add_completion=False, help=__doc__)

README = """BirdWeb archive — birdweb.org/birdweb/
=====================================

What this is
------------
A complete byte-for-byte mirror of BirdWeb, Birds Connect Seattle's guide to the birds of
Washington, as served by the original site on {crawl_date}.

BirdWeb was built by BCS volunteers starting in 1999 and ran on the same server until this
crawl. Its source code and database were lost, and the host could no longer be
administered, so this mirror was taken to make sure the content survived. It is the reason
the rebuilt site exists, and it is the fallback if anything about that rebuild is ever
questioned.

Contents
--------
  pages/      Every HTML page, at its original URL path, with `.html` appended.
              e.g. pages/bird/mallard.html  <-  https://birdweb.org/birdweb/bird/mallard
  assets/     images/, sounds/, web_images/ and css/, at their original paths.
  browsable/  The same pages with links rewritten to relative paths, so the site can be
              opened from disk with no web server. Start at browsable/index.html.
  manifest.jsonl
              One JSON record per URL fetched: the URL, the local path, a SHA-256 of the
              bytes, the Content-Type, the HTTP status, and when it was fetched.

Inventory
---------
{inventory}

Notes for whoever reads this next
---------------------------------
* The pages are encoded iso-8859-1 (they declare it, and they mean it), authored in
  Windows-1252. Smart quotes and em dashes appear as C1 control bytes when decoded
  strictly as latin-1.
* Photographs come in four renditions sharing a stem: `_s`, `_t`, `_l` (all small) and an
  unsuffixed file that is the 500x500 original. The pages only ever link the small ones;
  the originals were reachable through a `bigger_image.aspx` wrapper. All four are here.
* Page text is copyright Birds Connect Seattle. Photographs belong to the individual
  photographers credited on each page. The audio recordings were licensed for BirdWeb with
  funds provided by the BirdNote radio program. This archive is a preservation copy; it
  does not grant any new rights over that material.

Verifying
---------
    shasum -a 256 -c SHA256SUMS          # checks this tarball
Every file's own hash is in manifest.jsonl if you need to check them individually.

Created {created} by scripts/mirror_birdweb.py and scripts/pack_archive.py
from the bcs-birdweb repository.
"""


def crawl_date() -> str:
    if not MANIFEST.exists():
        return "an unknown date"
    with MANIFEST.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                return json.loads(line)["fetched_at"][:10]
            except (json.JSONDecodeError, KeyError, TypeError):
                continue
    return "an unknown date"


def inventory() -> tuple[str, dict[str, int]]:
    counts = {
        "species accounts": len(list((ARCHIVE / "pages" / "bird").glob("*.html"))),
        "birding sites": len({p.parent.name for p in (ARCHIVE / "pages" / "site").glob("*/*.html")}),
        "ecoregions": len(list((ARCHIVE / "pages" / "ecoregion").glob("*.html"))),
        "families": len(list((ARCHIVE / "pages" / "family").glob("*.html"))),
        "pages total": len(list((ARCHIVE / "pages").rglob("*.html"))),
        "images": len(list((ARCHIVE / "assets" / "images").glob("*"))),
        "audio recordings": len(list((ARCHIVE / "assets" / "sounds").glob("*"))),
    }
    lines = [f"  {label:<20} {value:>6,}" for label, value in counts.items()]
    total = sum(f.stat().st_size for f in ARCHIVE.rglob("*") if f.is_file())
    lines.append(f"  {'uncompressed':<20} {total / 1e9:>6.2f} GB")
    return "\n".join(lines), counts


@app.command()
def run(
    label: str = typer.Option("", help="Extra label for the filename, e.g. 'final'."),
) -> None:
    """Pack archive/ into dist-archive/birdweb-archive-<date>.tar.gz."""
    if not ARCHIVE.exists() or not MANIFEST.exists():
        console.print("[red]Nothing to pack. Run `pixi run mirror` first.[/red]")
        raise typer.Exit(1)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = date.today().isoformat()
    name = f"birdweb-archive-{stamp}{'-' + label if label else ''}"
    tarball = OUT_DIR / f"{name}.tar.gz"

    inv_text, counts = inventory()
    readme = README.format(
        crawl_date=crawl_date(),
        inventory=inv_text,
        created=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    )
    readme_path = ARCHIVE / "ARCHIVE-README.txt"
    readme_path.write_text(readme, encoding="utf-8")

    # gzip rather than zstd: the point of this file is that someone can open it in twenty
    # years with whatever they have to hand, and `tar xzf` is everywhere.
    console.print(f"Packing [bold]{tarball.name}[/bold] …")
    files = sorted(p for p in ARCHIVE.rglob("*") if p.is_file())
    with tarfile.open(tarball, "w:gz", compresslevel=6) as tar:
        for path in files:
            tar.add(path, arcname=f"{name}/{path.relative_to(ARCHIVE)}")

    digest = hashlib.sha256()
    with tarball.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    sums = OUT_DIR / f"{name}.SHA256SUMS"
    sums.write_text(f"{digest.hexdigest()}  {tarball.name}\n", encoding="utf-8")

    table = Table(title="Archive packed", show_header=True)
    table.add_column("item")
    table.add_column("value", justify="right")
    for key, value in counts.items():
        table.add_row(key, f"{value:,}")
    table.add_row("files in tarball", f"{len(files):,}")
    table.add_row("compressed size", f"{tarball.stat().st_size / 1e9:.2f} GB")
    console.print(table)
    console.print(f"\n  [bold]{tarball}[/bold]")
    console.print(f"  [bold]{sums}[/bold]")
    console.print(
        "\n[green]Upload both to the Birds Connect Seattle Google Drive.[/green] "
        "That is the durable copy — this directory is gitignored."
    )


if __name__ == "__main__":
    app()
