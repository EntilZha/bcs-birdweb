"""Propose coordinates for the 69 birding sites.

The legacy site pages carry no coordinates at all, so this is net-new data. It writes
*candidates, not answers*: `geocode_source` is set to "nominatim-unconfirmed", and
scripts/verify_extract.py fails the build if that value ever reaches the deployed site.

That is not caution for its own sake. A first version of this script took Nominatim's
top hit and proposed an apartment building for Samish Flats, a fire station for Green Lake
and a notice board for Naches Peak Loop -- all superficially plausible rows in a table
that a reviewer could easily wave through. So candidates are now *scored*, mostly on what
kind of thing OpenStreetMap says they are: a nature reserve, bay or headland is a credible
birding site, a building or a fire station is not. Anything that does not clear the bar is
reported as no match rather than proposed, because a blank asks a human to do the work
while a wrong pin invites them to accept it.

A wrong pin does not merely look wrong -- it sends someone driving to the wrong place to
look for a bird. Every proposal still needs confirming against a map; that is what the
location fields in tools/birdweb-editor are for.

Nominatim's usage policy requires an identifying User-Agent and at most one request per
second. Both are respected below.

Usage:
    pixi run geocode                 # fill in only sites that have no coordinates
    pixi run geocode -- --report     # show what would be proposed, write nothing
    pixi run geocode -- --explain    # show every candidate and how it scored
"""

from __future__ import annotations

import re
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
USER_AGENT = "bcs-birdweb-geocoder/0.2 (Birds Connect Seattle; https://birdweb.org)"

# Washington's bounding box, so a query for "Rock Creek Road" cannot land in Montana.
VIEWBOX = "-124.85,49.05,-116.90,45.50"

# How credible each OSM class/type is as a *birding site*. This is the main defence
# against confident nonsense: the geocoder will happily return the nearest building with a
# matching name, and only the feature type reveals that it is an apartment block.
STRONG = {
    ("leisure", "nature_reserve"), ("leisure", "park"),
    ("boundary", "protected_area"), ("boundary", "national_park"),
    ("natural", "bay"), ("natural", "water"), ("natural", "wetland"),
    ("natural", "beach"), ("natural", "cape"), ("natural", "peak"),
    ("natural", "wood"), ("natural", "scrub"), ("natural", "strait"),
    ("place", "island"), ("place", "archipelago"), ("place", "islet"),
    ("landuse", "forest"), ("landuse", "meadow"),
}
WEAK_CLASSES = {"place", "waterway", "natural", "landuse", "tourism"}
# Types that are essentially never the birding site itself, whatever the name says.
REJECT_TYPES = {
    "apartments", "house", "residential", "commercial", "retail", "industrial",
    "fire_station", "police", "school", "hospital", "restaurant", "cafe", "hotel",
    "parking", "fuel", "board", "information", "bench", "picnic_site", "toilets",
    "bus_stop", "traffic_signals", "crossing", "yes", "address", "post_office",
}
REJECT_CLASSES = {"building", "shop", "office", "craft", "healthcare", "barrier"}

console = Console()
app = typer.Typer(add_completion=False, help=__doc__)

STOPWORDS = {
    "the", "and", "of", "state", "park", "national", "wildlife", "refuge", "area",
    "natural", "lake", "creek", "river", "road", "county", "washington", "wa", "usa",
}


def tokens(text: str) -> set[str]:
    return {w for w in re.split(r"[^a-z0-9]+", text.lower()) if w and w not in STOPWORDS}


def score(site_name: str, result: dict) -> tuple[float, str]:
    """Score a Nominatim result as a plausible birding site. Returns (score, why)."""
    # jsonv2 calls it `category`; the older `json` format calls it `class`. Reading only
    # one of them silently disables the type rules below -- which is exactly how an
    # apartment block scored well enough to be proposed for Samish Flats.
    cls = (result.get("category") or result.get("class") or "").lower()
    typ = (result.get("type") or "").lower()
    display = result.get("display_name") or ""

    if cls in REJECT_CLASSES or typ in REJECT_TYPES:
        return 0.0, f"rejected: {cls}/{typ} is not a place you go birding"

    points, why = 0.0, []
    if (cls, typ) in STRONG:
        points += 3.0
        why.append(f"{cls}/{typ}")
    elif cls in WEAK_CLASSES:
        points += 1.0
        why.append(f"{cls}/{typ} (weak)")
    else:
        points += 0.25
        why.append(f"{cls}/{typ} (unlikely)")

    # Does the matched place actually carry the site's distinctive words?
    want, got = tokens(site_name), tokens(display)
    if want:
        overlap = len(want & got) / len(want)
        points += 2.0 * overlap
        why.append(f"name {overlap:.0%}")

    # Nominatim's own confidence, where it gives one.
    try:
        points += min(float(result.get("importance") or 0), 0.5) * 2
    except (TypeError, ValueError):
        pass

    return points, ", ".join(why)


# Below this, a proposal is more likely to mislead a reviewer than help them.
THRESHOLD = 2.5


def queries_for(name: str) -> list[str]:
    """Progressively looser queries. The legacy names carry disambiguation a geocoder
    cannot use: "Seattle - Green Lake", "Blaine/Semiahmoo/Drayton Harbor"."""
    cleaned = name.replace(" - ", ", ")
    out = [f"{cleaned}, Washington, USA"]
    if "/" in cleaned:
        out.append(f"{cleaned.split('/')[0].strip()}, Washington, USA")
    if "(" in cleaned:
        out.append(f"{cleaned.split('(')[0].strip()}, Washington, USA")
    # "Seattle - Discovery Park" -> "Discovery Park": the city prefix defeats the search.
    if " - " in name:
        out.append(f"{name.split(' - ', 1)[1].strip()}, Washington, USA")
    return out


def best_candidate(
    client: httpx.Client, name: str, explain: bool
) -> tuple[dict | None, float, list[tuple[dict, float, str]]]:
    """Query Nominatim and return the highest-scoring plausible result."""
    seen: list[tuple[dict, float, str]] = []
    for query in queries_for(name):
        try:
            response = client.get(
                NOMINATIM,
                params={
                    "q": query,
                    "format": "jsonv2",
                    "limit": 5,
                    "countrycodes": "us",
                    "viewbox": VIEWBOX,
                    "bounded": 1,
                    "addressdetails": 1,
                },
            )
            time.sleep(1.1)  # Nominatim policy: at most one request per second.
            if response.status_code != 200:
                continue
            for result in response.json():
                points, why = score(name, result)
                seen.append((result, points, why))
        except httpx.HTTPError:
            time.sleep(2)
    if not seen:
        return None, 0.0, []
    seen.sort(key=lambda item: item[1], reverse=True)
    best, points, _ = seen[0]
    return (best if points >= THRESHOLD else None), points, seen


@app.command()
def run(
    report: bool = typer.Option(False, help="Show proposals without writing."),
    explain: bool = typer.Option(False, help="Show every candidate and its score."),
    overwrite: bool = typer.Option(
        False, help="Re-propose even for sites that already have coordinates."
    ),
) -> None:
    """Propose coordinates for sites that do not have them."""
    files = sorted(SITES_DIR.glob("*.yaml"))
    if not files:
        console.print("[red]No sites found. Run `pixi run extract` first.[/red]")
        raise typer.Exit(1)

    proposed = skipped = rejected = confirmed = 0
    rows: list[tuple[str, str, str]] = []

    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=30.0) as client:
        for path in files:
            record = yaml.safe_load(path.read_text(encoding="utf-8"))
            name = record["name"]

            if record.get("lat") is not None and not overwrite:
                if record.get("geocode_source") == "confirmed":
                    confirmed += 1
                else:
                    skipped += 1
                continue

            best, points, seen = best_candidate(client, name, explain)
            if explain:
                console.print(f"\n[bold]{name}[/bold]")
                for result, pts, why in seen[:5]:
                    mark = "[green]+[/green]" if pts >= THRESHOLD else "[red]-[/red]"
                    console.print(
                        f"  {mark} {pts:4.1f}  {result.get('display_name','')[:70]}  [dim]{why}[/dim]"
                    )

            if best is None:
                rejected += 1
                reason = (
                    f"[red]no credible match[/red] (best {points:.1f})"
                    if seen
                    else "[red]nothing found[/red]"
                )
                rows.append((name, "—", reason))
                # Clear any earlier low-quality proposal rather than leaving it behind.
                if overwrite and record.get("geocode_source") == "nominatim-unconfirmed":
                    record.update(lat=None, lon=None, county=None, geocode_source=None)
                    if not report:
                        write_yaml(path, ordered(record, SITE_KEY_ORDER))
                continue

            lat, lon = float(best["lat"]), float(best["lon"])
            county = (best.get("address") or {}).get("county")
            rows.append(
                (
                    name,
                    f"{lat:.4f}, {lon:.4f}",
                    f"{points:.1f} · {best.get('category') or best.get('class')}"
                    f"/{best.get('type')} · "
                    f"{(county or 'unknown county')}",
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
    table.add_column("score · type · county")
    for row in rows:
        table.add_row(*row)
    console.print(table)

    summary = Table(show_header=False)
    summary.add_row("proposed (needs confirming)", str(proposed))
    summary.add_row("confirmed by a human", str(confirmed))
    summary.add_row("left alone (already proposed)", str(skipped))
    summary.add_row("no credible candidate", str(rejected))
    console.print(summary)

    if proposed and not report:
        console.print(
            f"\n[yellow]{proposed} proposals written, all marked "
            "`nominatim-unconfirmed`.[/yellow]\n"
            "They will NOT ship: `pixi run verify` fails while that marker is present.\n"
            "Open each site in [bold]pixi run editor[/bold], check the pin on the map, and "
            "press Confirm."
        )
    if rejected:
        console.print(
            f"[dim]{rejected} sites had no candidate worth proposing. Those need a "
            "coordinate typed in by hand -- the editor's map accepts a dropped pin.[/dim]"
        )


if __name__ == "__main__":
    app()
