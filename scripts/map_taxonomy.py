"""Add the modern taxonomy layer to the extracted species accounts.

The BirdWeb accounts were written against roughly 2005 AOU taxonomy and are preserved
verbatim -- they are a record of what BCS's volunteers knew and published. This script does
not touch that prose. It only *adds* a `taxonomy:` block recording what each bird is called
today, so the site can lead with the current name while keeping the historic one visible
and searchable.

Matching is deliberately conservative, because a wrong match attaches the wrong modern
name to a volunteer-authored account. It is COMMON NAME FIRST, and it auto-applies a
result only when the two sources agree:

  1. The legacy common name is still a current species name -> accept. The binomial may
     have moved genus since 2005; that is recorded, not questioned.
  2. Both names resolve to the same record -> accept.
  3. The legacy *scientific* name matches but the common name does not -> DO NOT ACCEPT.
     This is the signature of a post-2005 split in which the old binomial stayed with the
     Old World daughter species. BirdWeb's "Barn Owl" (Tyto alba) is not today's Western
     Barn Owl -- Washington's bird became American Barn Owl, Tyto furcata. Matching on the
     binomial alone would silently relabel a Washington account with a Eurasian species.
     These go to a human.
  4. The legacy binomial is now a subspecies -> the bird was lumped. Suggest the absorbing
     species, but still route it to a human.
  5. No match at all -> a human.

Everything in 3-5 lands in src/config/taxonomy-overrides.yaml with the evidence attached.
Until a person resolves it, the site keeps showing the name the account itself uses, which
is the safe failure mode.

The reference data is eBird's own taxonomy export, which is a public endpoint needing no
API key (Cornell's Clements download page blocks automated requests; this returns the same
taxonomy plus the eBird species codes we actually want):

    https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=csv

It is vendored to data/vendor/ebird-taxonomy.csv and committed, so a build is reproducible
and does not depend on a network call. The FULL export is used rather than `cat=species`
because the subspecies and form rows are how a retired name resolves: BirdWeb's "Thayer's
Gull" (Larus thayeri) is today the issf Larus glaucoides thayeri, whose REPORT_AS points at
the species that absorbed it.

Usage:
    pixi run taxonomy
    pixi run taxonomy -- --report     # show what would change, write nothing
"""

from __future__ import annotations

import csv
import re
import sys
import unicodedata
from pathlib import Path

import typer
import yaml
from rich.console import Console
from rich.table import Table

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_birdweb import FlowList, SPECIES_KEY_ORDER, ordered, write_yaml  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
SPECIES_DIR = REPO_ROOT / "src" / "content" / "species"
VENDOR = REPO_ROOT / "data" / "vendor"
TAXONOMY_CSV = VENDOR / "ebird-taxonomy.csv"
OVERRIDES = REPO_ROOT / "src" / "config" / "taxonomy-overrides.yaml"

console = Console()
app = typer.Typer(add_completion=False, help=__doc__)


def normalize(name: str) -> str:
    """Fold a name for comparison: lowercase, unaccented, no punctuation.

    Handles the apostrophe and hyphen drift between the two sources -- BirdWeb writes
    "Ross's Goose" and "Whistling-Duck", Clements may differ in punctuation alone.
    """
    text = unicodedata.normalize("NFKD", name)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.lower().replace("'", "").replace("’", "")
    text = re.sub(r"[-_]", " ", text)
    text = re.sub(r"[^a-z ]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def load_taxonomy() -> tuple[dict[str, dict], dict[str, dict], dict[str, dict]]:
    """Index the eBird taxonomy by normalized scientific and common name.

    Returns (species_by_sci, species_by_common, subspecies_by_sci). The third index holds
    the non-species rows -- issf, form, intergrade -- which is where a lumped historic name
    lives now; matching there tells us the name was absorbed rather than simply unknown.
    """
    by_sci: dict[str, dict] = {}
    by_common: dict[str, dict] = {}
    sub_by_sci: dict[str, dict] = {}
    code_to_species: dict[str, dict] = {}

    rows = list(csv.DictReader(TAXONOMY_CSV.open(encoding="utf-8-sig", newline="")))
    for row in rows:
        record = {
            "scientific": (row.get("SCIENTIFIC_NAME") or "").strip(),
            "common": (row.get("COMMON_NAME") or "").strip(),
            "code": (row.get("SPECIES_CODE") or "").strip() or None,
            # Stored as an int: every eBird TAXON_ORDER is whole, and a Python float
            # writes as "545.0" while the editor's JS round-trip writes "545". Keeping
            # the two writers byte-identical is what stops every saved record from
            # carrying a spurious one-line diff.
            "sort": int(float(row["TAXON_ORDER"])) if row.get("TAXON_ORDER") else None,
            "category": (row.get("CATEGORY") or "").strip(),
            "report_as": (row.get("REPORT_AS") or "").strip() or None,
            "family": (row.get("FAMILY_COM_NAME") or "").strip(),
        }
        if not record["scientific"] or not record["common"]:
            continue
        if record["category"] == "species":
            by_sci.setdefault(normalize(record["scientific"]), record)
            by_common.setdefault(normalize(record["common"]), record)
            if record["code"]:
                code_to_species[record["code"]] = record
        elif record["category"] in ("issf", "form", "intergrade"):
            sub_by_sci.setdefault(normalize(record["scientific"]), record)

    # Resolve each subspecies row to the species that now reports it.
    for record in sub_by_sci.values():
        record["parent"] = code_to_species.get(record["report_as"] or "")
    return by_sci, by_common, sub_by_sci


def load_overrides() -> dict[str, dict]:
    if not OVERRIDES.exists():
        return {}
    data = yaml.safe_load(OVERRIDES.read_text(encoding="utf-8")) or {}
    return data.get("species") or {}


@app.command()
def run(
    report: bool = typer.Option(False, help="Show what would change without writing."),
) -> None:
    """Attach the eBird/Clements taxonomy layer to every species record."""
    if not TAXONOMY_CSV.exists():
        console.print(f"[red]Missing {TAXONOMY_CSV.relative_to(REPO_ROOT)}[/red]")
        console.print(
            "Fetch it with (no API key needed):\n"
            "  curl -sS 'https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=csv' "
            f"-o {TAXONOMY_CSV.relative_to(REPO_ROOT)}"
        )
        raise typer.Exit(1)

    by_sci, by_common, sub_by_sci = load_taxonomy()
    overrides = load_overrides()
    console.print(
        f"eBird taxonomy: [bold]{len(by_sci)}[/bold] species, "
        f"[bold]{len(sub_by_sci)}[/bold] subspecies and forms"
    )

    matched_sci = matched_common = from_override = unmatched = renamed = lumped = 0
    needs_review = 0
    unmatched_slugs: list[tuple[str, str, str]] = []
    renames: list[tuple[str, str, str]] = []
    review_slugs: list[tuple[str, str, str, str]] = []
    pending: list[dict] = []

    for path in sorted(SPECIES_DIR.glob("*.yaml")):
        record = yaml.safe_load(path.read_text(encoding="utf-8"))
        slug = record["slug"]
        legacy_common = record["common_name"]
        legacy_sci = record["scientific_name"]

        override = overrides.get(slug)
        match = None
        source = ""
        review_reason = None
        suggestion = None

        if override and override.get("ebird_code"):
            match = {
                "code": override["ebird_code"],
                "common": override.get("current_common_name") or legacy_common,
                "scientific": override.get("current_scientific_name") or legacy_sci,
                "sort": override.get("clements_sort"),
            }
            source = "override"
            from_override += 1
        else:
            by_common_hit = by_common.get(normalize(legacy_common))
            by_sci_hit = by_sci.get(normalize(legacy_sci))

            if by_common_hit:
                # The common name still names a species. Accept it: this is the case where
                # only the binomial moved (Sage Thrasher, Pacific Wren and friends).
                match = by_common_hit
                source = "common"
                matched_common += 1
                if by_sci_hit and by_sci_hit is by_common_hit:
                    matched_common -= 1
                    matched_sci += 1
                    source = "both"
            elif by_sci_hit:
                # Binomial matches, common name does not: almost certainly a split.
                review_reason = (
                    f"{legacy_sci} is now {by_sci_hit['common']}. BirdWeb called this bird "
                    f"{legacy_common}, so this is probably a post-2005 split and the "
                    f"Washington bird is likely a different daughter species."
                )
                suggestion = by_sci_hit
                needs_review += 1
                review_slugs.append((slug, legacy_common, legacy_sci, review_reason))
            else:
                sub = sub_by_sci.get(normalize(legacy_sci))
                parent = (sub or {}).get("parent")
                if parent:
                    review_reason = (
                        f"{legacy_sci} is no longer a species; it is now a form of "
                        f"{parent['common']} ({parent['scientific']}). Confirm whether the "
                        f"account should be presented under that name."
                    )
                    suggestion = parent
                    lumped += 1
                    review_slugs.append((slug, legacy_common, legacy_sci, review_reason))
                else:
                    unmatched += 1
                    unmatched_slugs.append((slug, legacy_common, legacy_sci))

        if match:
            changed = normalize(match["common"]) != normalize(legacy_common)
            if changed:
                renamed += 1
                renames.append((slug, legacy_common, match["common"]))
            note = (override or {}).get("note")
            if note is None and changed:
                note = (
                    f"Published on BirdWeb as {legacy_common}; the accepted name is now "
                    f"{match['common']}."
                )
            taxonomy = {
                "ebird_code": match.get("code"),
                "current_common_name": match["common"],
                "current_scientific_name": match["scientific"],
                "clements_sort": match.get("sort"),
                "historic_common_name": legacy_common if changed else None,
                "display_historic": bool((override or {}).get("display_historic")),
                "note": note,
            }
        else:
            # Unresolved: fall back to the account's own name. The site shows the legacy
            # name, which is never wrong -- only out of date.
            taxonomy = {
                "ebird_code": None,
                "current_common_name": None,
                "current_scientific_name": None,
                "clements_sort": None,
                "historic_common_name": None,
                "display_historic": False,
                "note": (override or {}).get("note"),
            }
            pending.append(
                {
                    "slug": slug,
                    "legacy_common": legacy_common,
                    "legacy_sci": legacy_sci,
                    "reason": review_reason,
                    "suggestion": suggestion,
                }
            )

        if not report:
            record["taxonomy"] = taxonomy
            # safe_load returned the abundance rows as plain lists, which would write back
            # as 120 lines of block sequence and silently reformat every species file.
            # Re-wrap them so this pass is byte-neutral on everything it does not change.
            abundance = record.get("abundance") or {}
            record["abundance"] = {k: FlowList(v) for k, v in abundance.items()}
            write_yaml(path, ordered(record, SPECIES_KEY_ORDER))

    table = Table(title="Taxonomy mapping", show_header=True)
    table.add_column("outcome")
    table.add_column("count", justify="right")
    table.add_row("both names agree", str(matched_sci))
    table.add_row("common name current, binomial moved", str(matched_common))
    table.add_row("resolved by override", str(from_override))
    table.add_row("renamed since publication", str(renamed))
    table.add_row(
        "[yellow]probable split — needs review[/yellow]" if needs_review else "probable split",
        str(needs_review),
    )
    table.add_row(
        "[yellow]lumped — needs review[/yellow]" if lumped else "lumped",
        str(lumped),
    )
    table.add_row("[yellow]no match[/yellow]" if unmatched else "no match", str(unmatched))
    console.print(table)

    if renames:
        console.print("\n[bold]Names that changed since BirdWeb published them:[/bold]")
        for slug, old, new in renames[:30]:
            console.print(f"  {old}  [dim]->[/dim]  [green]{new}[/green]")
        if len(renames) > 30:
            console.print(f"  … {len(renames) - 30} more")

    if review_slugs:
        console.print("\n[bold yellow]Need a human decision (probable split or lump):[/bold yellow]")
        for slug, common, sci, reason in review_slugs:
            console.print(f"  [bold]{common}[/bold] ({sci})")
            console.print(f"    [dim]{reason}[/dim]")

    if unmatched_slugs:
        console.print("\n[bold yellow]No match in the current taxonomy:[/bold yellow]")
        for slug, common, sci in unmatched_slugs:
            console.print(f"  {common} ({sci})")

    if pending and not report:
        write_override_stub(pending, overrides)

    if report:
        console.print("\n[dim]--report: nothing written.[/dim]")


def write_override_stub(pending: list[dict], existing: dict[str, dict]) -> None:
    """Write every unresolved species to the overrides file, with its evidence.

    These are editorial calls about how to present a twenty-year-old account, so they
    belong in version control next to the data rather than inside a heuristic. Entries
    already resolved by a human are preserved untouched.
    """
    stub: dict[str, dict] = {}
    for item in pending:
        slug = item["slug"]
        if slug in existing and existing[slug].get("ebird_code"):
            stub[slug] = existing[slug]
            continue
        suggestion = item.get("suggestion") or {}
        stub[slug] = {
            "birdweb_common_name": item["legacy_common"],
            "birdweb_scientific_name": item["legacy_sci"],
            "why": item["reason"] or "Not found in the current eBird taxonomy.",
            "suggested_ebird_code": suggestion.get("code"),
            "suggested_common_name": suggestion.get("common"),
            "ebird_code": existing.get(slug, {}).get("ebird_code"),
            "current_common_name": existing.get(slug, {}).get("current_common_name"),
            "current_scientific_name": existing.get(slug, {}).get("current_scientific_name"),
            "clements_sort": existing.get(slug, {}).get("clements_sort"),
            "note": existing.get(slug, {}).get("note"),
        }
    for slug, value in existing.items():
        stub.setdefault(slug, value)

    header = (
        "# Taxonomy decisions that cannot be made mechanically.\n"
        "#\n"
        "# Each species here either (a) matched the current taxonomy on its 2005 binomial\n"
        "# but not on its name, which is the signature of a split where the old binomial\n"
        "# stayed with the Old World daughter species, or (b) was lumped into another\n"
        "# species, or (c) is not in the current taxonomy at all.\n"
        "#\n"
        "# `why` and `suggested_*` are evidence, written by scripts/map_taxonomy.py. They\n"
        "# are never applied on their own. To resolve an entry, fill in `ebird_code`,\n"
        "# `current_common_name` and `current_scientific_name`, and write `note` for the\n"
        "# reader: say what the bird was called on BirdWeb and what happened to the name.\n"
        "#\n"
        "# Leaving an entry unresolved is safe and is the default: the site then shows the\n"
        "# name the account itself uses.\n\n"
    )
    OVERRIDES.parent.mkdir(parents=True, exist_ok=True)
    OVERRIDES.write_text(
        header
        + yaml.safe_dump({"species": stub}, sort_keys=True, allow_unicode=True, width=100),
        encoding="utf-8",
    )
    console.print(
        f"\n[green]Wrote {len(stub)} entries to {OVERRIDES.relative_to(REPO_ROOT)}[/green]"
    )


if __name__ == "__main__":
    app()
