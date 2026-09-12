"""Propose coordinates for the 69 birding sites.

The legacy site pages carry no coordinates at all, so this is net-new data. It writes
*candidates, not answers*: `geocode_source` is set to "nominatim-unconfirmed", and
scripts/verify_extract.py fails the build if that value ever reaches the deployed site.

That is not caution for its own sake. Names like "Samish Flats", "Rock Creek Road",
"Pelagic Trips" and "Seattle - Union Bay Natural Area (Montlake Fill)" do not geocode
reliably, and a wrong pin does not merely look wrong -- it sends someone driving to the
wrong place to look for a bird. Every pin needs a human to confirm it against a map, which
is what the location fields in tools/birdweb-editor are for.

Nominatim's usage policy requires an identifying User-Agent and at most one request per
second. Both are respected below.

Usage:
    pixi run geocode                 # fill in only sites that have no coordinates
    pixi run geocode -- --report     # show what would be proposed, write nothing
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import httpx
import typer
import yaml
from rich.console import Console
from rich.table import Table

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_birdweb import SITE_KEY_ORDER, ordered, write_yaml  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
SITES_DIR = REPO_ROOT / "src" / "content" / "sites"

NOMINATIM = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "bcs-birdweb-geocoder/0.1 (Birds Connect Seattle; https://birdweb.org)"

# Washington's bounding box, so a query for "Rock Creek Road" cannot land in Montana.
VIEWBOX = "-124.85,49.05,-116.90,45.50"

console = Console()
app = typer.Typer(add_completion=False, help=__doc__)


def candidates(client: httpx.Client, name: str) -> list[dict]:
    """Ask Nominatim for this site, most specific query first."""
    # The legacy names carry disambiguation the geocoder cannot use: "Seattle - Green Lake"
    # and slash-joined pairs like "Blaine/Semiahmoo/Drayton Harbor". Try progressively
    # looser forms rather than giving up on the first miss.
    cleaned = name.replace(" - ", ", ")
    queries = [f"{cleaned}, Washington, USA"]
    if "/" in cleaned:
        queries.append(f"{cleaned.split('/')[0].strip()}, Washington, USA")
    if "(" in cleaned:
        queries.append(f"{cleaned.split('(')[0].strip()}, Washington, USA")

    for query in queries:
        try:
            response = client.get(
                NOMINATIM,
                params={
                    "q": query,
                    "format": "jsonv2",
                    "limit": 3,
                    "countrycodes": "us",
                    "viewbox": VIEWBOX,
                    "bounded": 1,
                    "addressdetails": 1,
                },
            )
            time.sleep(1.1)  # Nominatim policy: at most one request per second.
            if response.status_code == 200 and response.json():
                return response.json()
        except httpx.HTTPError:
            time.sleep(2)
    return []


@app.command()
def run(
    report: bool = typer.Option(False, help="Show proposals without writing."),
    overwrite: bool = typer.Option(
        False, help="Re-propose even for sites that already have coordinates."
    ),
) -> None:
    """Propose coordinates for sites that do not have them."""
    files = sorted(SITES_DIR.glob("*.yaml"))
    if not files:
        console.print("[red]No sites found. Run `pixi run extract` first.[/red]")
        raise typer.Exit(1)

    proposed = skipped = missed = confirmed = 0
    rows: list[tuple[str, str, str]] = []

    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=30.0) as client:
        for path in files:
            record = yaml.safe_load(path.read_text(encoding="utf-8"))
            name = record["name"]

            if record.get("lat") is not None and not overwrite:
                if record.get("geocode_source") != "nominatim-unconfirmed":
                    confirmed += 1
                else:
                    skipped += 1
                continue

            console.print(f"  looking up [bold]{name}[/bold]…")
            results = candidates(client, name)
            if not results:
                missed += 1
                rows.append((name, "—", "[red]no match[/red]"))
                continue

            best = results[0]
            lat, lon = float(best["lat"]), float(best["lon"])
            county = (best.get("address") or {}).get("county")
            rows.append(
                (
                    name,
                    f"{lat:.4f}, {lon:.4f}",
                    f"{best.get('type', '?')} · {(county or 'unknown county')}",
                )
            )
            proposed += 1

            if not report:
                record["lat"] = round(lat, 5)
                record["lon"] = round(lon, 5)
                record["county"] = county.replace(" County", "") if county else None
                record["geocode_source"] = "nominatim-unconfirmed"
                write_yaml(path, ordered(record, SITE_KEY_ORDER))

    table = Table(title="Geocoding", show_header=True)
    table.add_column("site")
    table.add_column("proposed")
    table.add_column("match")
    for row in rows:
        table.add_row(*row)
    console.print(table)

    summary = Table(show_header=False)
    summary.add_row("proposed (unconfirmed)", str(proposed))
    summary.add_row("already confirmed by a human", str(confirmed))
    summary.add_row("left alone (already proposed)", str(skipped))
    summary.add_row("no match", str(missed))
    console.print(summary)

    if proposed and not report:
        console.print(
            f"\n[yellow]{proposed} proposals written, all marked "
            "`nominatim-unconfirmed`.[/yellow]\n"
            "They will NOT ship: `pixi run verify` fails while that marker is present.\n"
            "Open each site in [bold]pixi run editor[/bold], check the pin against a map, "
            "and change `geocode_source` to `confirmed` once you have."
        )


if __name__ == "__main__":
    app()
