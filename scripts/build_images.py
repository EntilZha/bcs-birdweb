"""Convert archived photos, maps and audio into the site's asset tree.

Reads the extracted YAML in src/content/ to learn which assets are actually referenced,
then pulls those out of archive/ and writes WebP derivatives under src/assets/.

Why WebP at ingest rather than committing the originals: the legacy photographs are
500x500 JPEGs of around 200KB -- inefficiently encoded for their size -- so the set is
roughly 450MB as JPEG but well under a quarter of that as WebP. Nothing is lost by
re-encoding because archive/ holds the untouched originals and is packed to the BCS Google
Drive; the repo only needs what the site serves.

Filenames keep their original stem (mall_fl_gl_l.jpg -> mall_fl_gl_l.webp) so the YAML
never has to be rewritten; src/lib/images.ts resolves a reference by stem. That keeps
`extract` and `images` independent and re-runnable in either order.

Usage:
    pixi run images
    pixi run images -- --force      # re-encode even if the output already exists
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import typer
import yaml
from PIL import Image
from rich.console import Console
from rich.progress import track
from rich.table import Table

REPO_ROOT = Path(__file__).resolve().parent.parent
ARCHIVE_IMAGES = REPO_ROOT / "archive" / "assets" / "images"
# Site chrome and the ecoregion locator maps were served from a second directory.
ARCHIVE_WEB_IMAGES = REPO_ROOT / "archive" / "assets" / "web_images"
ARCHIVE_SOUNDS = REPO_ROOT / "archive" / "assets" / "sounds"
CONTENT = REPO_ROOT / "src" / "content"
ASSETS = REPO_ROOT / "src" / "assets"
PUBLIC_SOUNDS = REPO_ROOT / "public" / "sounds"

# Quality 82 is where these particular images stop improving visibly. They are already
# JPEG, so we are re-encoding lossy-to-lossy; going higher mostly preserves JPEG artifacts.
WEBP_QUALITY = 82

console = Console()
app = typer.Typer(add_completion=False, help=__doc__)


def load_collection(name: str) -> dict[str, dict]:
    directory = CONTENT / name
    if not directory.exists():
        return {}
    return {
        path.stem: yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for path in sorted(directory.glob("*.yaml"))
    }


def source_404s() -> set[str]:
    """Filenames the legacy server returned a non-200 for, read from the crawl manifest."""
    manifest = REPO_ROOT / "archive" / "manifest.jsonl"
    if not manifest.exists():
        return set()
    import json

    names: set[str] = set()
    with manifest.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("http_status") != 200:
                names.add(record["url"].rsplit("/", 1)[-1])
    return names


_INDEX: dict[str, Path] | None = None


def archive_index() -> dict[str, Path]:
    """Case-folded index of every archived image.

    IIS serves paths case-insensitively, and BirdWeb's own markup is inconsistent about it:
    the filmstrip thumbnail links `greglavaty032_t.jpg` while `data-large_file` on the same
    element says `GregLavaty032.jpg`. Both are the same file on the server, so matching by
    exact filename loses images that were archived under the other spelling.
    """
    global _INDEX
    if _INDEX is None:
        _INDEX = {}
        for directory in (ARCHIVE_IMAGES, ARCHIVE_WEB_IMAGES):
            if directory.exists():
                for path in directory.glob("*"):
                    _INDEX.setdefault(path.name.lower(), path)
    return _INDEX


def best_source(file: str) -> Path | None:
    """Highest-resolution archived rendition of an image.

    The YAML references the `_l` name because that is what the page markup linked, but `_l`
    is only 180x180. The unsuffixed sibling is the 500x500 original -- roughly eight times
    the pixel area -- so prefer it whenever the mirror captured it.
    """
    candidates = [file]
    stem, _, ext = file.rpartition(".")
    if stem.endswith(("_l", "_t", "_s")):
        candidates.insert(0, f"{stem[:-2]}.{ext}")
    index = archive_index()
    for name in candidates:
        path = index.get(name.lower())
        if path is not None:
            return path
    return None


def convert(source: Path, target: Path, force: bool) -> tuple[bool, int]:
    """Encode one image to WebP. Returns (converted, bytes_written)."""
    if target.exists() and not force:
        return False, target.stat().st_size
    target.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as image:
        # Range maps are palettized GIFs; RGB conversion keeps WebP from guessing.
        if image.mode in ("P", "LA"):
            image = image.convert("RGBA" if "transparency" in image.info else "RGB")
        elif image.mode == "CMYK":
            image = image.convert("RGB")
        image.save(target, "WEBP", quality=WEBP_QUALITY, method=6)
    return True, target.stat().st_size


@app.command()
def run(force: bool = typer.Option(False, help="Re-encode even if the output exists.")) -> None:
    """Build src/assets/ and public/sounds/ from the archive."""
    if not ARCHIVE_IMAGES.exists():
        console.print("[red]No archived images. Run `pixi run mirror` first.[/red]")
        raise typer.Exit(1)

    species = load_collection("species")
    sites = load_collection("sites")
    ecoregions = load_collection("ecoregions")

    # (archive filename, destination path) pairs, deduplicated.
    jobs: dict[str, Path] = {}
    audio_jobs: set[str] = set()

    for slug, record in species.items():
        for photo in record.get("photos") or []:
            if file := photo.get("file"):
                jobs[file] = ASSETS / "birds" / slug / f"{Path(file).stem}.webp"
        for value in (record.get("maps") or {}).values():
            if value:
                # Maps live in one flat directory: a few are shared between species, and
                # duplicating them per-species would bloat the repo for no benefit.
                jobs[value] = ASSETS / "maps" / f"{Path(value).stem}.webp"
        audio = record.get("audio")
        if audio and audio.get("file"):
            audio_jobs.add(audio["file"])

    for slug, record in sites.items():
        for photo in record.get("photos") or []:
            if file := photo.get("file"):
                jobs[file] = ASSETS / "sites" / slug / f"{Path(file).stem}.webp"

    for slug, record in ecoregions.items():
        if value := record.get("map"):
            jobs[value] = ASSETS / "ecoregions" / f"{Path(value).stem}.webp"

    converted = skipped = missing = failed = 0
    total_bytes = 0
    missing_names: list[str] = []

    for file, target in track(sorted(jobs.items()), description="images", console=console):
        source = best_source(file)
        if source is None:
            missing += 1
            missing_names.append(file)
            continue
        try:
            did, size = convert(source, target, force)
        except Exception as exc:  # noqa: BLE001 - report and continue; one bad file is not fatal
            failed += 1
            console.print(f"  [red]failed[/red] {file}: {exc}")
            continue
        total_bytes += size
        converted += did
        skipped += not did

    # Audio is copied rather than transcoded: these are already small mono MP3s, and
    # re-encoding lossy audio to save a few megabytes is a bad trade for a birdsong clip.
    audio_copied = audio_missing = 0
    audio_bytes = 0
    PUBLIC_SOUNDS.mkdir(parents=True, exist_ok=True)
    for file in sorted(audio_jobs):
        source = ARCHIVE_SOUNDS / file
        target = PUBLIC_SOUNDS / file
        if not source.exists():
            audio_missing += 1
            continue
        if not target.exists() or force:
            shutil.copy2(source, target)
            audio_copied += 1
        audio_bytes += target.stat().st_size

    table = Table(title="Assets built", show_header=True)
    table.add_column("kind")
    table.add_column("count", justify="right")
    table.add_column("size", justify="right")
    table.add_row("images converted", str(converted), "")
    table.add_row("images already present", str(skipped), "")
    table.add_row("images total", str(converted + skipped), f"{total_bytes / 1e6:.1f} MB")
    table.add_row("audio files", str(len(audio_jobs) - audio_missing), f"{audio_bytes / 1e6:.1f} MB")
    if missing:
        table.add_row("[yellow]images missing from archive[/yellow]", str(missing), "")
    if audio_missing:
        table.add_row("[yellow]audio missing from archive[/yellow]", str(audio_missing), "")
    if failed:
        table.add_row("[red]failed[/red]", str(failed), "")
    console.print(table)

    if missing_names:
        # Distinguish "not crawled yet" from "the legacy server 404s on this too". Seven
        # species pages link a range map that was never uploaded; the live site has shown a
        # broken image for them for twenty years, and there is nothing to recover.
        absent = source_404s()
        broken = [n for n in missing_names if n in absent]
        uncrawled = [n for n in missing_names if n not in absent]
        if broken:
            console.print(
                f"\n[dim]{len(broken)} referenced image(s) are broken links on the legacy "
                "site itself (404 at source) — nothing to recover:[/dim]"
            )
            for name in broken:
                console.print(f"  [dim]{name}[/dim]")
        if uncrawled:
            console.print(
                f"\n[yellow]{len(uncrawled)} image(s) not in the archive — is the crawl "
                "still running?[/yellow]"
            )
            for name in uncrawled[:10]:
                console.print(f"  {name}")
            if len(uncrawled) > 10:
                console.print(f"  … {len(uncrawled) - 10} more")


if __name__ == "__main__":
    app()
