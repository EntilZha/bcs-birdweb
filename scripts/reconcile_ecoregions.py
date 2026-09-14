"""Close the gaps and overlaps between the traced ecoregion rings.

The rings come from the legacy site's clickable image map, where each region was drawn
independently as a hit target. Nobody was making them tile: neighbours miss each other by a
little in places and cross each other in others, which on a real basemap shows up as slivers
of basemap between regions and as double-tinted seams where two fills stack.

The fix is deliberately simple, and matches how the shapes were made -- these are schematic
boundaries, not survey lines, so the goal is that neighbours meet, not that either one is
"right":

  1. Weld near-coincident vertices. Any cluster of vertices from two or more regions within
     the tolerance collapses to its centroid, so the regions genuinely share those corners.
  2. Pull the remaining loose vertices halfway onto the neighbour's edge. A vertex of A that
     sits within the tolerance of B's boundary moves to the midpoint between where it is and
     its projection onto that boundary. That closes half a gap or backs half an overlap out
     in one pass -- the same move either way, which is why it converges.
  3. Absorb the holes that are left. A few gaps are wider than any tolerance that does not
     also destroy the small regions, so once the two passes have converged each remaining
     hole is given to the region bordering most of it. Only unclaimed space changes hands.

The label points are recomputed afterwards, since moving a boundary moves the interior
the region's number is drawn in.

Repeating the two passes converges on a shared boundary. It is not a topological merge and
does not claim to be; it just stops the map looking broken.

Tuned by measuring, not by eye. At the default (0.09 degrees, 6 passes) gaps fall from
1.95% of the footprint to 0.17% and overlap from 0.24% to 0.07%; absorbing the leftover
holes takes the gaps to effectively zero. No region's area moves more than about 3%. Tolerances past ~0.2 start eating small regions -- Blue Mountains
loses 29% of its area -- so the script refuses anything that distorts a region by over 25%.

Usage:
    pixi run reconcile-ecoregions
    pixi run reconcile-ecoregions -- --report   # measure, write nothing
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_ecoregion_shapes import label_point  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
SHAPES = REPO_ROOT / "src" / "data" / "ecoregion-shapes.json"

console = Console()
app = typer.Typer(add_completion=False, help=__doc__)


def measure(rings: dict[str, list[list[float]]]) -> tuple[float, float]:
    """(overlap, gap) as a share of the footprint, in percent."""
    polys = [Polygon(r).buffer(0) for r in rings.values() if len(r) >= 3]
    polys = [p for p in polys if not p.is_empty]
    total = sum(p.area for p in polys)
    union = unary_union(polys)
    if union.is_empty:
        return 0.0, 0.0
    overlap = total - union.area
    parts = [union] if union.geom_type == "Polygon" else list(union.geoms)
    filled = sum(Polygon(p.exterior).area for p in parts)
    gaps = filled - union.area
    return overlap / union.area * 100, gaps / filled * 100


def weld_vertices(rings: dict[str, list[list[float]]], tol: float) -> int:
    """Collapse clusters of near-coincident vertices from different regions."""
    points: list[tuple[str, int]] = [
        (slug, i) for slug, ring in rings.items() for i in range(len(ring))
    ]
    seen: set[tuple[str, int]] = set()
    welded = 0
    for key in points:
        if key in seen:
            continue
        slug, i = key
        x, y = rings[slug][i]
        cluster = [key]
        for other_slug, ring in rings.items():
            if other_slug == slug:
                continue
            for j, (px, py) in enumerate(ring):
                if (other_slug, j) in seen:
                    continue
                if math.hypot(px - x, py - y) <= tol:
                    cluster.append((other_slug, j))
        if len(cluster) < 2:
            continue
        cx = sum(rings[s][k][0] for s, k in cluster) / len(cluster)
        cy = sum(rings[s][k][1] for s, k in cluster) / len(cluster)
        for s, k in cluster:
            rings[s][k] = [cx, cy]
            seen.add((s, k))
        welded += len(cluster)
    return welded


def pull_to_neighbours(rings: dict[str, list[list[float]]], tol: float) -> int:
    """Move each loose vertex halfway onto the nearest neighbouring boundary."""
    boundaries = {
        slug: LineString(ring + [ring[0]]) for slug, ring in rings.items() if len(ring) >= 3
    }
    moved = 0
    for slug, ring in rings.items():
        for i, (x, y) in enumerate(ring):
            point = Point(x, y)
            best, best_d = None, tol
            for other, line in boundaries.items():
                if other == slug:
                    continue
                d = point.distance(line)
                if d < best_d:
                    best, best_d = line, d
            if best is None or best_d == 0:
                continue
            target = best.interpolate(best.project(point))
            # Halfway: the same move whether the vertex is short of the neighbour or past
            # it, so gaps close and overlaps back out at the same rate.
            ring[i] = [(x + target.x) / 2, (y + target.y) / 2]
            moved += 1
    return moved


def fill_holes(rings: dict[str, list[list[float]]]) -> tuple[int, float]:
    """Absorb each leftover hole into whichever region wraps most of it.

    Welding can only close a gap narrower than the tolerance. What survives is a handful of
    genuine holes -- the biggest sit in the Salish Sea and in the Cascade foothills -- where
    two regions were traced far enough apart that no vertex of one is near an edge of the
    other. Raising the tolerance until they close eats the small regions whole.

    So they are closed directly instead: each hole goes to the region that already borders
    the most of it, and is unioned into that region's outline. Nothing is pushed around and
    no region loses area, because a hole is by definition land no region had claimed.
    """
    polys = {k: Polygon(v).buffer(0) for k, v in rings.items() if len(v) >= 3}
    union = unary_union(list(polys.values()))
    parts = [union] if union.geom_type == "Polygon" else list(union.geoms)
    holes = [Polygon(r) for part in parts for r in part.interiors]

    filled, area = 0, 0.0
    for hole in holes:
        # Whoever wraps the most of the hole's rim takes it.
        owner = max(
            polys,
            key=lambda k: hole.exterior.intersection(polys[k].buffer(1e-7)).length,
        )
        merged = unary_union([polys[owner], hole])
        if merged.geom_type != "Polygon":
            continue  # would split the region in two; leave the hole rather than do that
        polys[owner] = merged
        filled += 1
        area += hole.area

    for slug, poly in polys.items():
        rings[slug] = [list(c) for c in poly.exterior.coords[:-1]]
    return filled, area


@app.command()
def run(
    tol: float = typer.Option(0.09, help="Snap tolerance in degrees (~7 km at this latitude)."),
    passes: int = typer.Option(6, help="How many weld/pull rounds to run."),
    report: bool = typer.Option(False, help="Measure without writing."),
) -> None:
    """Reconcile the ecoregion rings so neighbours meet."""
    data = json.loads(SHAPES.read_text())
    rings = {k: [list(p) for p in v] for k, v in data["regions"].items()}

    table = Table(title="Reconciling ecoregion boundaries", show_header=True)
    table.add_column("pass")
    table.add_column("welded", justify="right")
    table.add_column("pulled", justify="right")
    table.add_column("overlap", justify="right")
    table.add_column("gaps", justify="right")

    overlap, gaps = measure(rings)
    table.add_row("before", "—", "—", f"{overlap:.2f}%", f"{gaps:.2f}%")

    for n in range(1, passes + 1):
        welded = weld_vertices(rings, tol)
        pulled = pull_to_neighbours(rings, tol)
        overlap, gaps = measure(rings)
        table.add_row(str(n), str(welded), str(pulled), f"{overlap:.2f}%", f"{gaps:.2f}%")

    filled, hole_area = fill_holes(rings)
    overlap, gaps = measure(rings)
    table.add_row("holes", f"{filled} filled", "—", f"{overlap:.2f}%", f"{gaps:.2f}%")

    console.print(table)

    # Guard against the snapping eating a region: a collapsed ring would silently vanish
    # from the map rather than fail.
    before = {k: Polygon(v).buffer(0).area for k, v in data["regions"].items()}
    after = {k: Polygon(v).buffer(0).area for k, v in rings.items()}
    worst = sorted(
        ((abs(after[k] - before[k]) / before[k] * 100, k) for k in before), reverse=True
    )
    console.print("\n  area change per region (largest first):")
    for pct, slug in worst[:4]:
        tone = "[red]" if pct > 25 else ""
        console.print(f"    {tone}{pct:5.1f}%[/] {slug}" if tone else f"    {pct:5.1f}% {slug}")
    if worst[0][0] > 25:
        console.print(
            f"\n[red]{worst[0][1]} changed by {worst[0][0]:.0f}% — tolerance is too "
            "aggressive.[/red]"
        )
        raise typer.Exit(1)

    if report:
        console.print("\n[dim]--report: nothing written.[/dim]")
        return

    data["regions"] = {k: [[round(x, 4), round(y, 4)] for x, y in v] for k, v in rings.items()}
    # Moving the boundaries moves the interiors, so the number placements have to be
    # recomputed here rather than left as extract_ecoregion_shapes.py found them.
    data["label_points"] = {k: label_point(v) for k, v in data["regions"].items()}
    data["_reconciled"] = (
        f"Vertices welded and pulled onto neighbouring boundaries (tolerance {tol} deg, "
        f"{passes} passes) so the regions meet instead of leaving slivers and double-tinted "
        "seams. See scripts/reconcile_ecoregions.py."
    )
    SHAPES.write_text(json.dumps(data, separators=(",", ":")))
    console.print(f"\n[green]wrote {SHAPES.relative_to(REPO_ROOT)}[/green]")


if __name__ == "__main__":
    app()
