"""Diff extracted content against the live legacy site, field by field.

The extractor is verified two ways already: `verify_extract.py` checks the data's internal
shape, and the pytest suite checks the parsers against fixtures. Neither proves the result
matches what birdweb.org actually served -- both would pass happily if a selector quietly
grabbed the wrong element on every page.

So this re-fetches a handful of pages from the live site and compares them field by field
against the YAML. It is deliberately a *separate* implementation from the extractor: it
looks for the text in the raw HTML rather than re-running the same selectors, because a
check that shares the code it is checking proves nothing.

The species are chosen to span the edge cases rather than to be representative:

    mallard                  full data, seven photos, complete abundance
    eurasian_kestrel         rarity: no status line, no abundance table
    marbled_murrelet         Species of Concern badge
    rosss_goose              apostrophe in the slug
    fulvous_whistling-duck   hyphen in the slug
    northwestern_crow        lumped; page leads with its historic name
    thayers_gull             lumped into a species that has its own account
    gray_jay                 renamed since publication
    barn_owl                 split; the 2005 binomial belongs to another bird now
    varied_thrush            ordinary account, as a control

Usage:
    pixi run audit-live
    pixi run audit-live -- --only mallard,gray_jay
"""

from __future__ import annotations

import html as html_module
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
from birdweb_text import collapse  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
SPECIES_DIR = REPO_ROOT / "src" / "content" / "species"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

SAMPLE = [
    "mallard",
    "eurasian_kestrel",
    "marbled_murrelet",
    "rosss_goose",
    "fulvous_whistling-duck",
    "northwestern_crow",
    "thayers_gull",
    "gray_jay",
    "barn_owl",
    "varied_thrush",
]

console = Console()
app = typer.Typer(add_completion=False, help=__doc__)

TAG_RE = re.compile(r"<[^>]+>")


def visible_text(html: str) -> str:
    """Everything a reader would see, whitespace-collapsed, for substring checks."""
    without_scripts = re.sub(r"<(script|style)\b.*?</\1>", " ", html, flags=re.S | re.I)
    text = html_module.unescape(TAG_RE.sub(" ", without_scripts))
    # The pages are cp1252 mislabelled as latin-1; fold the C1 range the same way the
    # extractor does so a curly apostrophe matches a straight one.
    for bad, good in {"\x92": "’", "\x93": "“", "\x94": "”", "\x97": "—"}.items():
        text = text.replace(bad, good)
    return re.sub(r"\s+", " ", text)


def normalize(value: str) -> str:
    """Fold the differences that are formatting rather than content."""
    value = value.replace("’", "'").replace("“", '"').replace("”", '"')
    value = value.replace("—", "--").replace("–", "-")
    # Markdown the extractor added, and the doubled quotes it normalized.
    value = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", value)
    value = value.replace("*", "").replace("''", '"')
    return re.sub(r"\s+", " ", value).strip().lower()


def check(label: str, expected: str, haystack: str, problems: list[str]) -> bool:
    """Assert that extracted text really appears in what the server served."""
    if not expected:
        return True
    needle = normalize(expected)
    # Compare a generous prefix: enough to be unmistakable, short enough that one stray
    # entity in the middle of a long account does not produce a useless failure.
    probe = needle[:180]
    if probe in normalize(haystack):
        return True
    problems.append(f"{label}: extracted text not found on the live page")
    return False


@app.command()
def run(
    only: str = typer.Option("", help="Comma-separated slugs instead of the default sample."),
    delay: float = typer.Option(1.0, help="Seconds between requests."),
) -> None:
    """Compare extracted species records against the live site."""
    slugs = [s.strip() for s in only.split(",") if s.strip()] or SAMPLE

    table = Table(title="Extracted vs live", show_header=True)
    table.add_column("species")
    table.add_column("fields", justify="right")
    table.add_column("result")

    total_problems: dict[str, list[str]] = {}
    headers = {"User-Agent": USER_AGENT}

    with httpx.Client(headers=headers, follow_redirects=True, timeout=45.0) as client:
        for slug in slugs:
            path = SPECIES_DIR / f"{slug}.yaml"
            if not path.exists():
                total_problems[slug] = ["no extracted record"]
                table.add_row(slug, "-", "[red]missing locally[/red]")
                continue
            record = yaml.safe_load(path.read_text(encoding="utf-8"))

            try:
                response = client.get(f"https://birdweb.org/birdweb/bird/{slug}")
                time.sleep(delay)
            except httpx.HTTPError as exc:
                total_problems[slug] = [f"fetch failed: {exc}"]
                table.add_row(slug, "-", "[yellow]unreachable[/yellow]")
                continue
            if response.status_code != 200:
                total_problems[slug] = [f"HTTP {response.status_code}"]
                table.add_row(slug, "-", f"[red]HTTP {response.status_code}[/red]")
                continue

            html = response.content.decode("iso-8859-1", errors="replace")
            text = visible_text(html)
            problems: list[str] = []
            fields = 0

            # Names: the *published* ones, not the modern layer -- that is ours, not theirs.
            for label, value in (
                ("common_name", record["common_name"]),
                ("scientific_name", record["scientific_name"]),
                ("status", record.get("status", "")),
                ("order", record["order"]["name"]),
                ("family", record["family"]["name"]),
            ):
                if value:
                    fields += 1
                    check(label, value, text, problems)

            for key, value in (record.get("sections") or {}).items():
                fields += 1
                check(f"sections.{key}", value, text, problems)

            # Species of Concern: the badge is an <img title>, so look for it in the markup.
            fields += 1
            live_concern = "species of concern" in html.lower()
            if bool(record.get("species_of_concern")) != live_concern:
                problems.append(
                    f"species_of_concern: extracted {record.get('species_of_concern')}, "
                    f"live page says {live_concern}"
                )

            # Abundance, read straight out of the table rows without the extractor's help.
            live_rows = dict(
                (m.group(1).lower(), m.group(2))
                for m in re.finditer(
                    r"/ecoregion/([a-z_]+)'>[^<]*</a></th>((?:<td>[^<]*</td>)+)", html, re.I
                )
            )
            for region, cells_html in live_rows.items():
                cells = [collapse(c).upper() for c in re.findall(r"<td>(.*?)</td>", cells_html)]
                got = record.get("abundance", {}).get(region)
                fields += 1
                if got is None:
                    problems.append(f"abundance.{region}: missing from the extract")
                elif [c or "" for c in cells] != [c or "" for c in got]:
                    problems.append(f"abundance.{region}: {got} != live {cells}")

            # Photo count and credits.
            live_photos = set(re.findall(r"data-large_file='[^']*/images/([^']+)'", html))
            ours = {p["file"] for p in record.get("photos") or []}
            fields += 1
            if live_photos and not live_photos <= ours:
                problems.append(f"photos: live has {sorted(live_photos - ours)} that we lack")

            fields += 1
            live_audio = re.search(r"/sounds/([a-z0-9_.\-]+\.mp3)", html, re.I)
            our_audio = (record.get("audio") or {}).get("file")
            if bool(live_audio) != bool(our_audio):
                problems.append(f"audio: extracted {our_audio}, live {live_audio and live_audio.group(1)}")

            if problems:
                total_problems[slug] = problems
                table.add_row(slug, str(fields), f"[red]{len(problems)} mismatch(es)[/red]")
            else:
                table.add_row(slug, str(fields), "[green]matches[/green]")

    console.print(table)
    if total_problems:
        console.print(f"\n[red]{sum(len(v) for v in total_problems.values())} mismatch(es):[/red]")
        for slug, problems in total_problems.items():
            for problem in problems:
                console.print(f"  [red]{slug}[/red]: {problem}")
        raise typer.Exit(1)
    console.print("\n[green]Every checked field matches what the live site serves.[/green]")


if __name__ == "__main__":
    app()
