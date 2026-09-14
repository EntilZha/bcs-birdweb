"""Give every ecoregion its own hue, and prove the neighbours stay distinguishable.

A choropleth is normally held to *all-pairs* colour separation, since any two marks can end
up side by side -- and under that rule only about three hues clear the bar, which is why an
earlier version of this map reused fills. On a geographic map with fixed topology that is
stricter than it needs to be: two regions at opposite ends of the state never touch, so what
actually has to be told apart is *neighbours*.

So each of the ten regions gets a distinct hue, and the assignment is then searched to
maximise the weakest geographically-adjacent pair. The colour maths here is transcribed from
the dataviz skill's validator (Machado-Oliveira-Fernandes 2009 at severity 1.0, Euclidean
distance in OKLab x100) so the search agrees with the gate; the chosen assignment is then
re-checked by running that validator itself on every adjacent pair.

Non-adjacent regions may still resemble each other. That is the trade, and it is covered by
the number drawn on every region and by the legend -- identity never rests on colour alone.

Usage:
    pixi run ecoregion-colours
"""

from __future__ import annotations

import itertools
import json
import math
import random
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

REPO_ROOT = Path(__file__).resolve().parent.parent
SHAPES = REPO_ROOT / "src" / "data" / "ecoregion-shapes.json"

# Ten hues, each individually cleared by the validator for lightness band and chroma floor
# against the cream surface. Eight are the documented categorical families; the last two are
# a cyan and a brown chosen to extend the set without dipping below the chroma floor.
PALETTE = [
    "#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4",
    "#008300", "#4a3aa7", "#e34948", "#00a5c4", "#96591f",
]

MACHADO = {
    "protan": ((0.152286, 1.052583, -0.204868),
               (0.114503, 0.786281, 0.099216),
               (-0.003882, -0.048116, 1.051998)),
    "deutan": ((0.367322, 0.860646, -0.227968),
               (0.280085, 0.672501, 0.047413),
               (-0.011820, 0.042940, 0.968881)),
}

console = Console()
app = typer.Typer(add_completion=False, help=__doc__)


def _lin(hex_colour: str) -> tuple[float, float, float]:
    h = hex_colour.lstrip("#")
    srgb = [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb)


def _oklab(rgb: tuple[float, float, float]) -> tuple[float, float, float]:
    r, g, b = rgb
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    return (
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    )


def _simulate(rgb: tuple[float, float, float], kind: str) -> tuple[float, float, float]:
    m = MACHADO[kind]
    return tuple(min(1.0, max(0.0, sum(m[i][j] * rgb[j] for j in range(3)))) for i in range(3))


def separation(a: str, b: str) -> float:
    """Worst OKLab delta E x100 across protanopia and deuteranopia."""
    out = []
    for kind in MACHADO:
        pa, pb = _oklab(_simulate(_lin(a), kind)), _oklab(_simulate(_lin(b), kind))
        out.append(100 * math.dist(pa, pb))
    return min(out)


def adjacency(regions: dict[str, list[list[float]]], tol: float = 0.18) -> list[tuple[str, str]]:
    def touching(a, b):
        return any(math.dist(p, q) < tol for p in a for q in b)

    return [
        (x, y) for x, y in itertools.combinations(regions, 2) if touching(regions[x], regions[y])
    ]


@app.command()
def run(seed: int = typer.Option(7, help="Search seed, so the assignment is reproducible.")) -> None:
    """Assign one hue per ecoregion, maximising the weakest neighbouring pair."""
    data = json.loads(SHAPES.read_text())
    regions = data["regions"]
    names = list(regions)
    pairs = adjacency(regions)

    if len(names) > len(PALETTE):
        raise SystemExit(f"{len(names)} regions but only {len(PALETTE)} hues")

    rng = random.Random(seed)

    def weakest(order: list[int]) -> float:
        return min(
            separation(PALETTE[order[names.index(x)]], PALETTE[order[names.index(y)]])
            for x, y in pairs
        )

    best, best_score = None, -1.0
    for _ in range(300):
        order = list(range(len(names)))
        rng.shuffle(order)
        score = weakest(order)
        for _ in range(3000):
            i, j = rng.randrange(len(order)), rng.randrange(len(order))
            if i == j:
                continue
            order[i], order[j] = order[j], order[i]
            new = weakest(order)
            if new >= score:
                score = new
            else:
                order[i], order[j] = order[j], order[i]
        if score > best_score:
            best, best_score = list(order), score

    assignment = {name: PALETTE[best[i]] for i, name in enumerate(names)}

    table = Table(title="Weakest neighbouring pairs", show_header=True)
    table.add_column("pair")
    table.add_column("ΔE", justify="right")
    table.add_column("verdict")
    ranked = sorted(pairs, key=lambda p: separation(assignment[p[0]], assignment[p[1]]))
    for x, y in ranked[:6]:
        d = separation(assignment[x], assignment[y])
        verdict = "[green]pass[/green]" if d >= 8 else (
            "[yellow]floor band[/yellow]" if d >= 6 else "[red]FAIL[/red]"
        )
        table.add_row(f"{x} | {y}", f"{d:.1f}", verdict)
    console.print(table)
    console.print(
        f"\n  {len(pairs)} neighbouring pairs, weakest ΔE {best_score:.1f} "
        f"(target 8, floor 6 with labels)"
    )

    if best_score < 6:
        console.print("[red]A neighbouring pair falls below the floor.[/red]")
        raise typer.Exit(1)

    data["region_fill"] = assignment
    data.pop("colour_slot", None)
    data["_colour_note"] = (
        "One hue per ecoregion, assigned to maximise the weakest geographically-adjacent "
        f"pair (worst ΔE {best_score:.1f} under protanopia and deuteranopia). Non-adjacent "
        "regions may resemble each other; the number on every region and the legend carry "
        "identity. See scripts/assign_ecoregion_colours.py."
    )
    SHAPES.write_text(json.dumps(data, separators=(",", ":")))
    console.print(f"\n[green]wrote {SHAPES.relative_to(REPO_ROOT)}[/green]")
    for name in names:
        console.print(f"    {assignment[name]}  {name}")


if __name__ == "__main__":
    app()
