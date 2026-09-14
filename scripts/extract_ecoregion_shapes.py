"""Recover the ecoregion boundaries from the legacy site's clickable map.

The old /sites/ page had a coloured map of Washington's ten ecoregions that you could click
-- the single best navigation aid on the site, and the thing a birder actually orients by.
It was a JPEG plus an HTML `<map>` of `<area shape="POLY">` elements.

The JPEG is archived and could simply be re-displayed, but a raster image map is a poor
thing to rebuild on: it cannot be restyled, does not scale, cannot be themed for dark or
print, and cannot share a coordinate system with the site pins. The `<area>` coordinates,
though, *are* the boundaries. This turns them into geography.

Geo-referencing: the image carries no projection metadata, so the transform is fitted by
matching the bounding box of the nine land ecoregions to Washington's own bounding box.
Oceanic is excluded from the fit because it is open water extending past the coast and
would drag the western edge out. The fit is checked against the state outline and the
error reported -- the boundaries are schematic to begin with, and this only has to be good
enough to say which part of the state you are looking at.

Attribution: the original map was credited "Map courtesy of Cindy Lippincott". These shapes
derive from it and the credit travels with them.

Usage:
    pixi run ecoregion-shapes
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

sys.path.insert(0, str(Path(__file__).resolve().parent))
from birdweb_text import decode  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
SITES_PAGE = REPO_ROOT / "archive" / "pages" / "sites.html"
OUT = REPO_ROOT / "src" / "data" / "ecoregion-shapes.json"

# The legacy map numbered the regions 0-9; these are our slugs, in that order.
BY_NUMBER = {
    "0": "oceanic",
    "1": "pacific_northwest_coast",
    "2": "puget_trough",
    "3": "north_cascades",
    "4": "west_cascades",
    "5": "east_cascades",
    "6": "okanogan",
    "7": "canadian_rockies",
    "8": "blue_mountains",
    "9": "columbia_plateau",
}

# Washington's land extent, used to fit the transform.
WA = {"west": -124.73, "east": -116.92, "south": 45.54, "north": 49.00}

console = Console()
app = typer.Typer(add_completion=False, help=__doc__)


def read_areas() -> dict[str, list[tuple[int, int]]]:
    html = decode(SITES_PAGE.read_bytes())
    block = re.search(
        r'<map[^>]*name=["\']master_map_simple["\'].*?</map>', html, re.S | re.I
    )
    if not block:
        raise SystemExit("no <map name='master_map_simple'> in the archived /sites/ page")

    shapes: dict[str, list[tuple[int, int]]] = {}
    for area in re.findall(r"<area[^>]*?>", block.group(0), re.S | re.I):
        title = re.search(r'title="\s*(\d+)\s+([^"]*)"', area)
        coords = re.search(r'coords="([^"]*)"', area, re.S)
        if not title or not coords:
            continue
        slug = BY_NUMBER.get(title.group(1))
        if not slug:
            continue
        nums = [int(n) for n in re.findall(r"-?\d+", coords.group(1))]
        points = list(zip(nums[0::2], nums[1::2]))
        if len(points) >= 3:
            shapes[slug] = points
    return shapes


def point_in_ring(x: float, y: float, ring: list[list[float]]) -> bool:
    """Standard ray-casting test."""
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1:
            inside = not inside
    return inside


def label_point(ring: list[list[float]]) -> list[float]:
    """Where to draw a region's number.

    The obvious choice -- the centre of the bounding box -- fails on any concave shape.
    Oceanic is a crescent hugging the outer coast, so its box-centre lands over the
    Olympic Peninsula, printing "0" on top of Pacific Northwest Coast's "1".

    So: an approximate pole of inaccessibility. Sample a grid inside the ring and keep the
    interior point furthest from any edge, which for these shapes is comfortably inside
    and away from the neighbours.
    """
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    best, best_d = None, -1.0
    STEPS = 24
    for i in range(1, STEPS):
        for j in range(1, STEPS):
            x = min(xs) + (max(xs) - min(xs)) * i / STEPS
            y = min(ys) + (max(ys) - min(ys)) * j / STEPS
            if not point_in_ring(x, y, ring):
                continue
            d = min(
                math.dist((x, y), (px, py)) for px, py in ring
            )
            if d > best_d:
                best, best_d = [round(x, 4), round(y, 4)], d
    # A ring too thin for any sample to land inside falls back to the vertex average.
    if best is None:
        best = [round(sum(xs) / len(xs), 4), round(sum(ys) / len(ys), 4)]
    return best


def assign_colours(regions: dict[str, list[list[float]]]) -> dict[str, int]:
    """Give touching regions different fills, using as few as possible.

    A choropleth needs *all-pairs* colour separation -- any two regions can end up side by
    side -- and under simulated colour blindness only about three hues clear that bar. Ten
    distinguishable fills does not exist, so the map is coloured the way maps have always
    been coloured: neighbours differ, and the number printed on each region carries the
    identity. Three is enough here, which is verified rather than assumed.
    """
    import itertools

    def touching(a: list[list[float]], b: list[list[float]], tol: float = 0.18) -> bool:
        return any(
            math.dist((x1, y1), (x2, y2)) < tol for x1, y1 in a for x2, y2 in b
        )

    names = list(regions)
    adjacent = {n: set() for n in names}
    for a, b in itertools.combinations(names, 2):
        if touching(regions[a], regions[b]):
            adjacent[a].add(b)
            adjacent[b].add(a)

    colours: dict[str, int] = {}
    for name in sorted(names, key=lambda n: -len(adjacent[n])):
        taken = {colours[m] for m in adjacent[name] if m in colours}
        colours[name] = next(i for i in range(10) if i not in taken)

    for name, neighbours in adjacent.items():
        for other in neighbours:
            assert colours[name] != colours[other], f"{name} and {other} share a colour"
    return colours


@app.command()
def run() -> None:
    """Convert the legacy image map's polygons into lat/lon rings."""
    shapes = read_areas()
    missing = [s for s in BY_NUMBER.values() if s not in shapes]
    if missing:
        console.print(f"[yellow]no polygon for: {missing}[/yellow]")

    # Fit on land only: Oceanic runs out into the Pacific and would drag the western edge.
    land = [p for slug, pts in shapes.items() if slug != "oceanic" for p in pts]
    xs = [p[0] for p in land]
    ys = [p[1] for p in land]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)

    def to_lonlat(x: int, y: int) -> tuple[float, float]:
        lon = WA["west"] + (x - x0) / (x1 - x0) * (WA["east"] - WA["west"])
        # Pixel y grows downward, latitude upward.
        lat = WA["north"] - (y - y0) / (y1 - y0) * (WA["north"] - WA["south"])
        return round(lon, 4), round(lat, 4)

    out = {
        "_source": (
            "Traced from the clickable ecoregion map on birdweb.org/birdweb/sites "
            "(HTML image-map polygons). Original map courtesy of Cindy Lippincott."
        ),
        "_note": (
            "Schematic boundaries geo-referenced by fitting the nine land ecoregions to "
            "Washington's bounding box. Good enough to show which part of the state a "
            "region covers; not suitable for measurement or for deciding what is inside a "
            "region."
        ),
        "regions": {
            slug: [list(to_lonlat(x, y)) for x, y in points]
            for slug, points in shapes.items()
        },
    }
    out["label_points"] = {
        slug: label_point(ring) for slug, ring in out["regions"].items()
    }
    out["colour_slot"] = assign_colours(out["regions"])
    out["_colour_note"] = (
        "Fill slots assigned by graph colouring so no two touching ecoregions share one. "
        "Identity is carried by the number drawn on each region, not by colour."
    )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))

    table = Table(title="Ecoregion shapes", show_header=True)
    table.add_column("ecoregion")
    table.add_column("points", justify="right")
    table.add_column("lon range")
    table.add_column("lat range")
    for slug in BY_NUMBER.values():
        ring = out["regions"].get(slug)
        if not ring:
            table.add_row(slug, "—", "[red]missing[/red]", "")
            continue
        lons = [p[0] for p in ring]
        lats = [p[1] for p in ring]
        table.add_row(
            slug,
            str(len(ring)),
            f"{min(lons):.2f}..{max(lons):.2f}",
            f"{min(lats):.2f}..{max(lats):.2f}",
        )
    console.print(table)
    console.print(f"\n  wrote {OUT.relative_to(REPO_ROOT)} ({OUT.stat().st_size / 1024:.1f} KB)")
    console.print(
        "  [dim]Original map courtesy of Cindy Lippincott; the credit travels with these "
        "shapes.[/dim]"
    )


if __name__ == "__main__":
    app()
