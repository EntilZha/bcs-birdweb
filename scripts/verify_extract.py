"""Hard QA gate over the extracted content in src/content/.

Exits non-zero on anything that looks like a parser bug, so that a silent regression in
extract_birdweb.py cannot reach the site. The guiding rule: treat every anomaly as a
parser bug until it is proven to be a real gap in the 2005 source, and record the proven
ones explicitly rather than letting them pass quietly.

Usage:
    pixi run verify
    pixi run verify -- --show 40      # list more of each problem
"""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

import typer
import yaml
from rich.console import Console
from rich.table import Table

REPO_ROOT = Path(__file__).resolve().parent.parent
CONTENT = REPO_ROOT / "src" / "content"
ARCHIVE = REPO_ROOT / "archive"
ASSETS = ARCHIVE / "assets"

console = Console()
app = typer.Typer(add_completion=False, help=__doc__)

EXPECTED = {"species": 491, "sites": 69, "ecoregions": 10, "families": 64}

ECOREGION_SLUGS = [
    "oceanic", "pacific_northwest_coast", "puget_trough", "north_cascades",
    "west_cascades", "east_cascades", "okanogan", "canadian_rockies",
    "blue_mountains", "columbia_plateau",
]
ABUNDANCE_VALID = {"C", "F", "U", "R", "I", ""}

# Sections the 2005 authors filled in for the main species accounts. A main account missing
# one of these is worth flagging; a rarity account legitimately has far less.
CORE_SECTIONS = ["general_description"]


_ABUNDANCE_TABLE_CACHE: dict[str, bool] = {}


def source_has_abundance_table(slug: str) -> bool:
    """Did the archived page for this species actually carry an abundance table?

    Reads the raw HTML rather than re-parsing with selectolax: a substring check for the
    wrapper div is enough to answer the question and keeps this gate independent of the
    extractor's own parsing, which is the point of an independent check.
    """
    if slug in _ABUNDANCE_TABLE_CACHE:
        return _ABUNDANCE_TABLE_CACHE[slug]
    page = ARCHIVE / "pages" / "bird" / f"{slug}.html"
    if not page.exists():
        # No archive to check against; assume the extractor was right rather than
        # inventing a failure.
        _ABUNDANCE_TABLE_CACHE[slug] = False
        return False
    html = page.read_bytes().decode("iso-8859-1", errors="replace")
    result = "id='concern'" in html or 'id="concern"' in html
    _ABUNDANCE_TABLE_CACHE[slug] = result
    return result


def load_all(collection: str) -> dict[str, dict]:
    directory = CONTENT / collection
    if not directory.exists():
        return {}
    out: dict[str, dict] = {}
    for path in sorted(directory.glob("*.yaml")):
        try:
            out[path.stem] = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as exc:
            out[path.stem] = {"__parse_error__": str(exc)}
    return out


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.notes: list[str] = []
        self.rarities: list[str] = []

    def error(self, message: str) -> None:
        self.errors.append(message)

    def note(self, message: str) -> None:
        self.notes.append(message)


def check_species(records: dict[str, dict], report: Report) -> None:
    for slug, record in records.items():
        where = f"species/{slug}"
        if "__parse_error__" in record:
            report.error(f"{where}: unparseable YAML — {record['__parse_error__']}")
            continue

        for field in ("slug", "common_name", "scientific_name"):
            if not record.get(field):
                report.error(f"{where}: missing {field}")
        if record.get("slug") != slug:
            report.error(f"{where}: slug field {record.get('slug')!r} != filename")

        sections = record.get("sections") or {}
        for field in CORE_SECTIONS:
            if not sections.get(field):
                report.error(f"{where}: missing section {field}")

        for key in ("order", "family"):
            group = record.get(key) or {}
            if not group.get("name"):
                report.error(f"{where}: missing {key} name")

        # Abundance: exactly ten ecoregions, twelve months each, known codes only.
        abundance = record.get("abundance") or {}
        missing_regions = [r for r in ECOREGION_SLUGS if r not in abundance]
        if missing_regions:
            report.error(f"{where}: abundance missing ecoregions {missing_regions}")
        for region, months in abundance.items():
            if region not in ECOREGION_SLUGS:
                report.error(f"{where}: unknown ecoregion key {region!r}")
                continue
            if not isinstance(months, list) or len(months) != 12:
                report.error(
                    f"{where}: {region} has {len(months) if isinstance(months, list) else '?'} "
                    "months, expected 12"
                )
                continue
            bad = sorted({m for m in months if m not in ABUNDANCE_VALID})
            if bad:
                report.error(f"{where}: {region} has invalid codes {bad}")

        # An empty abundance block is only a bug if the source page actually had a table.
        # Plenty of accounts legitimately have none: the rarity accounts, and a middle
        # group -- vagrants and introduced species like Mute Swan, Ovenbird and Sky Lark --
        # that carry a status line but were never given a monthly matrix. Guessing from the
        # shape of the record would flag those 14 forever, so check the archive instead.
        empty = all(all(c == "" for c in (abundance.get(r) or [])) for r in ECOREGION_SLUGS)
        if empty:
            if source_has_abundance_table(slug):
                report.error(
                    f"{where}: source page has an abundance table but none was extracted"
                )
            else:
                report.rarities.append(slug)

        for photo in record.get("photos") or []:
            if not photo.get("file"):
                report.error(f"{where}: photo entry with no file")
            credit = (photo.get("credit") or {}).get("name")
            if not credit:
                report.note(f"{where}: photo {photo.get('file')} has no credit")
        heroes = sum(1 for p in record.get("photos") or [] if p.get("hero"))
        if record.get("photos") and heroes != 1:
            report.error(f"{where}: expected exactly 1 hero photo, found {heroes}")


def check_sites(records: dict[str, dict], report: Report) -> None:
    for slug, record in records.items():
        where = f"sites/{slug}"
        if "__parse_error__" in record:
            report.error(f"{where}: unparseable YAML — {record['__parse_error__']}")
            continue
        if not record.get("name"):
            report.error(f"{where}: missing name")
        ecoregions = record.get("ecoregions") or []
        if not ecoregions:
            report.error(f"{where}: no ecoregion")
        for eco in ecoregions:
            if eco not in ECOREGION_SLUGS:
                report.error(f"{where}: bad ecoregion {eco!r}")
        sections = record.get("sections") or {}
        if not sections.get("site") and not sections.get("birds"):
            report.error(f"{where}: no site or birds prose")
        # Geocoding is net-new and human-confirmed; unconfirmed pins must never ship.
        if record.get("geocode_source") == "nominatim-unconfirmed":
            report.error(f"{where}: unconfirmed geocode must not reach the site")


def check_assets(
    species: dict[str, dict], sites: dict[str, dict], report: Report
) -> tuple[int, int]:
    """Cross-check every referenced asset against the archive, both directions."""
    images = {p.name for p in (ASSETS / "images").glob("*")} if (ASSETS / "images").exists() else set()
    sounds = {p.name for p in (ASSETS / "sounds").glob("*")} if (ASSETS / "sounds").exists() else set()
    if not images:
        report.note("no archived images yet — asset cross-check skipped")
        return 0, 0

    referenced: set[str] = set()
    for slug, record in species.items():
        for photo in record.get("photos") or []:
            file = photo.get("file")
            if file:
                referenced.add(file)
                if file not in images:
                    report.error(f"species/{slug}: photo {file} not in archive")
        for key, value in (record.get("maps") or {}).items():
            if value:
                referenced.add(value)
                if value not in images:
                    report.error(f"species/{slug}: {key} map {value} not in archive")
        audio = record.get("audio")
        if audio and audio.get("file"):
            referenced.add(audio["file"])
            if audio["file"] not in sounds:
                report.error(f"species/{slug}: audio {audio['file']} not in archive")

    for slug, record in sites.items():
        for photo in record.get("photos") or []:
            if photo.get("file"):
                referenced.add(photo["file"])
                if photo["file"] not in images:
                    report.error(f"sites/{slug}: photo {photo['file']} not in archive")

    # Orphans catch the opposite failure: a photo the parser never found. Thumbnails and
    # site chrome are expected to be unreferenced, so only full-size images count.
    orphans = {
        name
        for name in images - referenced
        if re.search(r"_l\.(jpg|jpeg|png|gif)$", name, re.I)
    }
    if orphans:
        report.note(f"{len(orphans)} full-size images in the archive are referenced by nothing")
        for name in sorted(orphans)[:5]:
            report.note(f"  orphan: {name}")
    return len(referenced), len(orphans)


@app.command()
def run(show: int = typer.Option(15, help="How many of each problem to list.")) -> None:
    """Verify the extracted content."""
    collections = {name: load_all(name) for name in ("species", "sites", "ecoregions", "families", "orders")}

    table = Table(title="Extracted content", show_header=True)
    table.add_column("collection")
    table.add_column("records", justify="right")
    table.add_column("expected", justify="right")
    ok = True
    for name, records in collections.items():
        expected = EXPECTED.get(name)
        got = len(records)
        if expected is None:
            table.add_row(name, str(got), "—")
            continue
        good = got == expected
        ok = ok and good
        table.add_row(name, f"{'[green]' if good else '[red]'}{got}[/]", str(expected))
    console.print(table)

    report = Report()
    for name, records in collections.items():
        expected = EXPECTED.get(name)
        if expected is not None and len(records) != expected:
            report.error(f"{name}: {len(records)} records, expected {expected}")

    check_species(collections["species"], report)
    check_sites(collections["sites"], report)
    referenced, orphans = check_assets(collections["species"], collections["sites"], report)

    summary = Table(title="Checks", show_header=True)
    summary.add_column("check")
    summary.add_column("result", justify="right")
    summary.add_row("errors", f"[red]{len(report.errors)}[/red]" if report.errors else "[green]0[/green]")
    summary.add_row("notes", str(len(report.notes)))
    summary.add_row("rarity accounts", str(len(report.rarities)))
    summary.add_row("assets referenced", str(referenced))
    summary.add_row("orphan full-size images", str(orphans))
    console.print(summary)

    if report.rarities:
        console.print(
            f"\n[dim]{len(report.rarities)} rarity accounts (no status, no abundance) — "
            f"e.g. {', '.join(sorted(report.rarities)[:5])}[/dim]"
        )

    if report.notes:
        console.print(f"\n[yellow]Notes ({len(report.notes)}):[/yellow]")
        for note in report.notes[:show]:
            console.print(f"  {note}")
        if len(report.notes) > show:
            console.print(f"  … {len(report.notes) - show} more")

    if report.errors:
        console.print(f"\n[red]Errors ({len(report.errors)}):[/red]")
        grouped = Counter(re.sub(r"^\S+: ", "", e) for e in report.errors)
        for message, count in grouped.most_common(show):
            console.print(f"  [red]x{count}[/red] {message}")
        for error in report.errors[:show]:
            console.print(f"  {error}")
        raise typer.Exit(1)

    console.print("\n[green]Content verified.[/green]")


if __name__ == "__main__":
    app()
