"""Parse the archived legacy site in archive/ into src/content/ YAML.

Runs entirely offline against the Phase 1 mirror. That is deliberate: the source server is
a fragile unattended box that we touch once, and it means iterating on these parsers costs
nothing and can be re-run as often as the edge cases demand.

The output shape is defined by src/content.config.ts. YAML is written with a fixed key
order and no line wrapping so that diffs stay reviewable and the local editor's writes
touch only the lines a human actually changed.

Usage:
    pixi run extract
    pixi run extract -- --only mallard,marbled_murrelet   # iterate on specific records
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable

import typer
import yaml
from rich.console import Console
from rich.progress import track
from rich.table import Table
from selectolax.parser import HTMLParser, Node

sys.path.insert(0, str(Path(__file__).resolve().parent))
from birdweb_text import clean_text, collapse, node_text, parse  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
ARCHIVE = REPO_ROOT / "archive"
PAGES = ARCHIVE / "pages"
CONTENT = REPO_ROOT / "src" / "content"
MANIFEST = ARCHIVE / "manifest.jsonl"

console = Console()
app = typer.Typer(add_completion=False, help=__doc__)

# Canonical ecoregion order -- must stay in step with src/config/ecoregions.ts, since the
# abundance arrays are positional.
ECOREGION_SLUGS = [
    "oceanic", "pacific_northwest_coast", "puget_trough", "north_cascades",
    "west_cascades", "east_cascades", "okanogan", "canadian_rockies",
    "blue_mountains", "columbia_plateau",
]

# The legacy <h3> headings, mapped onto our field names. Anything not in here (the two map
# headings) is handled separately; anything unrecognized is reported rather than dropped.
SECTION_HEADINGS = {
    "general description": "general_description",
    "habitat": "habitat",
    "behavior": "behavior",
    "diet": "diet",
    "nesting": "nesting",
    "migration status": "migration_status",
    "conservation status": "conservation_status",
    "when and where to find in washington": "when_where_wa",
}
MAP_HEADINGS = {"washington range map", "north american range map"}

SITE_HEADINGS = {
    "the site": "site",
    "the birds": "birds",
    "directions and suggestions": "directions",
    "references": "references",
}

SECTION_ORDER = list(SECTION_HEADINGS.values())
SPECIES_KEY_ORDER = [
    "slug", "common_name", "scientific_name", "order", "family", "status",
    "species_of_concern", "sections", "photos", "audio", "maps", "abundance",
    "taxonomy", "source",
]
SITE_KEY_ORDER = [
    "slug", "name", "number", "ecoregions", "sections", "photos",
    "lat", "lon", "county", "geocode_source", "source",
]
PHOTO_KEY_ORDER = ["file", "caption", "credit", "hero"]

ABUNDANCE_VALID = {"C", "F", "U", "R", "I", ""}


# ----------------------------------------------------------------------------------------
# YAML serialization
# ----------------------------------------------------------------------------------------


class FlowList(list):
    """A list that dumps inline. Used for the twelve-month abundance rows, where block
    style would turn one species into 120 lines and make a single-cell edit unreviewable."""


class _Dumper(yaml.SafeDumper):
    """Block style everywhere, and no anchors/aliases sneaking into hand-edited files."""

    def ignore_aliases(self, data: Any) -> bool:  # noqa: D102
        return True


def _str_representer(dumper: yaml.Dumper, data: str):
    # Multi-paragraph prose becomes a literal block, which is the only way these accounts
    # stay readable (and reviewable in a diff) inside a YAML file.
    style = "|" if "\n" in data else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)


def _flow_list_representer(dumper: yaml.Dumper, data: FlowList):
    return dumper.represent_sequence("tag:yaml.org,2002:seq", list(data), flow_style=True)


_Dumper.add_representer(str, _str_representer)
_Dumper.add_representer(FlowList, _flow_list_representer)


def ordered(record: dict, key_order: Iterable[str]) -> dict:
    """Known keys first in a fixed order, then any extras, so diffs stay minimal."""
    out = {k: record[k] for k in key_order if k in record}
    out.update({k: v for k, v in record.items() if k not in out})
    return out


# Fields the extractor does NOT own. They come from later pipeline stages or from a human
# working in the editor, and re-running `extract` must not silently discard them: a site's
# coordinate is confirmed by a person looking at a map, and there is no way to recompute it.
PRESERVED_FIELDS = {
    "sites": ("lat", "lon", "county", "geocode_source"),
    "species": ("taxonomy",),
}


def preserve_existing(path: Path, record: dict, collection: str) -> dict:
    """Carry forward the fields this script did not produce."""
    keys = PRESERVED_FIELDS.get(collection)
    if not keys or not path.exists():
        return record
    try:
        existing = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError:
        return record
    for key in keys:
        value = existing.get(key)
        # Only carry a value that actually says something; a null must not mask a fresh one.
        if value not in (None, {}, []):
            record[key] = value
    return record


def write_yaml(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = yaml.dump(
        record, Dumper=_Dumper, sort_keys=False, allow_unicode=True, width=100000, indent=2
    )
    path.write_text(text, encoding="utf-8")


# ----------------------------------------------------------------------------------------
# Shared helpers
# ----------------------------------------------------------------------------------------


def archived_date() -> str:
    """Crawl date of the archive, read from the manifest rather than assumed."""
    if not MANIFEST.exists():
        return "unknown"
    with MANIFEST.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                return json.loads(line)["fetched_at"][:10]
            except (json.JSONDecodeError, KeyError, TypeError):
                continue
    return "unknown"


def asset_name(url: str | None) -> str | None:
    """Bare filename for an asset URL, which is how src/assets/ is keyed."""
    if not url:
        return None
    return url.split("?")[0].rstrip("/").rsplit("/", 1)[-1] or None


def clean_url(value: str | None) -> str | None:
    """Normalize a credit URL, or drop it if it is not usable.

    The 2005 data has a few hand-typed entries -- a trailing space inside the href, a
    bare `www.example.com` with no scheme. Repairing them here keeps five bad cells from
    failing the whole build, and a photographer's link is worth keeping.
    """
    if not value:
        return None
    url = value.strip().strip("'\"")
    if not url or url.startswith(("mailto:", "#", "javascript:")):
        return None
    if not re.match(r"^https?://", url, re.I):
        if not re.match(r"^[\w.-]+\.[a-z]{2,}(/|$)", url, re.I):
            return None
        url = f"http://{url}"
    return url


def credit_from(node: Node | None) -> dict[str, Any]:
    """Pull a photographer credit out of a `.credit` block."""
    if node is None:
        return {"name": "", "url": None}
    link = node.css_first("a")
    name = collapse(node.text())
    name = re.sub(r"^\s*(?:©|&copy;)\s*", "", name).strip()
    return {"name": name, "url": clean_url(link.attributes.get("href") if link else None)}


def section_map(tree: HTMLParser, headings: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    """Collect `div.details` / `h2.details` sections, keyed by our field names."""
    found: dict[str, str] = {}
    unknown: list[str] = []
    for block in tree.css("div.details"):
        head = block.css_first("h3")
        if head is None:
            continue
        label = collapse(head.text()).lower()
        if label in MAP_HEADINGS:
            continue
        key = headings.get(label)
        if key is None:
            unknown.append(label)
            continue
        head.decompose()
        text = node_text(block)
        if text:
            found[key] = text
    return found, unknown


# ----------------------------------------------------------------------------------------
# Species
# ----------------------------------------------------------------------------------------


def extract_species(path: Path, archived: str) -> tuple[dict, list[str]]:
    tree = parse(path.read_bytes())
    slug = path.stem
    warnings: list[str] = []

    common = collapse(tree.css_first("#commonname").text()) if tree.css_first("#commonname") else ""
    scientific = (
        collapse(tree.css_first("#scientific_name").text())
        if tree.css_first("#scientific_name")
        else ""
    )

    order_link = tree.css_first("#orderdialog")
    family_link = tree.css_first("#familydialog")
    order_name = collapse(order_link.text()) if order_link else ""
    family_name = collapse(family_link.text()) if family_link else ""

    status = ""
    for div in tree.css("#bird_summary div"):
        label = div.css_first("label")
        if label and collapse(label.text()).rstrip(":").lower() == "status":
            label.decompose()
            status = collapse(div.text())
            break
    if not status:
        warnings.append("RARITY: no status line")

    concern = any(
        "concern" in (img.attributes.get("title") or "").lower() for img in tree.css("#badges img")
    )

    sections, unknown = section_map(tree, SECTION_HEADINGS)
    for label in unknown:
        warnings.append(f"unrecognized section heading: {label!r}")
    if "general_description" not in sections:
        warnings.append("missing General Description")

    photos = extract_species_photos(tree, warnings)
    audio = extract_audio(tree)
    maps = extract_maps(tree)
    abundance, abundance_warnings = extract_abundance(tree)
    warnings.extend(abundance_warnings)

    record = {
        "slug": slug,
        "common_name": common,
        "scientific_name": scientific,
        "order": {"name": order_name, "slug": order_name.lower()},
        "family": {"name": family_name, "slug": family_name.lower()},
        "status": status,
        "species_of_concern": concern,
        "sections": {k: sections[k] for k in SECTION_ORDER if k in sections},
        "photos": photos,
        "audio": audio,
        "maps": maps,
        "abundance": abundance,
        "taxonomy": {
            "ebird_code": None,
            "current_common_name": None,
            "current_scientific_name": None,
            "clements_sort": None,
            "historic_common_name": None,
            "display_historic": False,
            "note": None,
        },
        "source": {"url": f"https://birdweb.org/birdweb/bird/{slug}", "archived": archived},
    }
    for field, value in (("common_name", common), ("scientific_name", scientific)):
        if not value:
            warnings.append(f"missing {field}")
    return ordered(record, SPECIES_KEY_ORDER), warnings


def extract_species_photos(tree: HTMLParser, warnings: list[str]) -> list[dict]:
    """Gallery photos, de-duplicated, with the hero flagged.

    The filmstrip carries the full set with credits in data- attributes; the hero figure
    repeats one of them at full size but credits it in a `.credit` block instead. We key on
    the large-file name so the same photo is never emitted twice.
    """
    hero_img = tree.css_first("div.photo figure img")
    hero_file = asset_name(hero_img.attributes.get("src")) if hero_img else None

    photos: list[dict] = []
    seen: set[str] = set()
    for img in tree.css("#filmstrip img"):
        attrs = img.attributes
        file = asset_name(attrs.get("data-large_file"))
        if not file or file in seen:
            continue
        seen.add(file)
        name = collapse(attrs.get("data-contributor"))
        if not name:
            warnings.append(f"photo missing credit: {file}")
        photos.append(
            ordered(
                {
                    "file": file,
                    "caption": collapse(attrs.get("title") or attrs.get("alt")),
                    "credit": {"name": name, "url": clean_url(attrs.get("data-contributor_url"))},
                    "hero": file == hero_file,
                },
                PHOTO_KEY_ORDER,
            )
        )

    # Some species have a single photo and therefore no filmstrip at all.
    if hero_file and hero_file not in seen:
        credit = credit_from(tree.css_first("div.photo figure figcaption .credit"))
        if not credit["name"]:
            warnings.append(f"photo missing credit: {hero_file}")
        photos.insert(
            0,
            ordered(
                {
                    "file": hero_file,
                    "caption": collapse(hero_img.attributes.get("title")),
                    "credit": credit,
                    "hero": True,
                },
                PHOTO_KEY_ORDER,
            ),
        )

    if photos and not any(p["hero"] for p in photos):
        photos[0]["hero"] = True
    return photos


def extract_audio(tree: HTMLParser) -> dict | None:
    source = tree.css_first("#player source")
    if source is None:
        return None
    file = asset_name(source.attributes.get("src"))
    if not file:
        return None
    return {"file": file, "credit": None}


def extract_maps(tree: HTMLParser) -> dict[str, str | None]:
    """The Washington and North America range maps.

    `#maps` also holds a shared legend graphic; it is chrome rather than data, and the NA
    map is the one tagged `na_map`, so both are identified by class rather than position.
    """
    wa = na = None
    for img in tree.css("#maps img"):
        classes = (img.attributes.get("class") or "").split()
        if "map_legend" in classes:
            continue
        name = asset_name(img.attributes.get("src"))
        if "na_map" in classes:
            na = na or name
        else:
            wa = wa or name
    return {"wa": wa, "north_america": na}


def extract_abundance(tree: HTMLParser) -> tuple[dict[str, list[str]], list[str]]:
    """The 12-month x 10-ecoregion matrix.

    Rows are keyed by the ecoregion slug in each row's own link rather than by position,
    so a reordered table can never silently shift a species' data into the wrong region.
    """
    warnings: list[str] = []
    matrix = {slug: FlowList([""] * 12) for slug in ECOREGION_SLUGS}
    table = tree.css_first("#concern table")
    if table is None:
        # Rarity accounts (written separately from the main species accounts) carry no
        # abundance table at all. That is a property of the source, not a parser miss.
        warnings.append("RARITY: no abundance table")
        return matrix, warnings

    seen: set[str] = set()
    for row in table.css("tr"):
        header = row.css_first("th.birdname")
        if header is None:
            continue
        link = header.css_first("a")
        slug = None
        if link and (href := link.attributes.get("href")):
            match = re.search(r"/ecoregion/([a-z_]+)", href, re.I)
            if match:
                slug = match.group(1).lower()
        if slug not in matrix:
            warnings.append(f"unknown ecoregion row: {collapse(header.text())!r}")
            continue

        cells = [collapse(td.text()).upper() for td in row.css("td")]
        if len(cells) != 12:
            warnings.append(f"{slug}: expected 12 months, got {len(cells)}")
            continue
        bad = [c for c in cells if c not in ABUNDANCE_VALID]
        if bad:
            warnings.append(f"{slug}: unexpected abundance codes {sorted(set(bad))}")
        matrix[slug] = FlowList(c if c in ABUNDANCE_VALID else "" for c in cells)
        seen.add(slug)

    missing = [s for s in ECOREGION_SLUGS if s not in seen]
    if missing and len(missing) != len(ECOREGION_SLUGS):
        warnings.append(f"abundance table missing rows: {missing}")
    return matrix, warnings


# ----------------------------------------------------------------------------------------
# Birding sites
# ----------------------------------------------------------------------------------------


def extract_site(path: Path, archived: str, numbers: dict[str, tuple[int | None, list[str]]]) -> tuple[dict, list[str]]:
    tree = parse(path.read_bytes())
    slug = path.parent.name
    ecoregion_id = path.stem
    warnings: list[str] = []

    heading = tree.css_first("article.content h1")
    name = collapse(heading.text()) if heading else ""

    sections: dict[str, str] = {}
    unknown: list[str] = []
    for head in tree.css("h2.details"):
        label = collapse(head.text()).lower()
        key = SITE_HEADINGS.get(label)
        if key is None:
            unknown.append(label)
            continue
        # Site prose is a flat run of siblings after the heading rather than a wrapper
        # element, so walk forward until the next section starts.
        chunks: list[str] = []
        node = head.next
        while node is not None:
            if node.tag in ("h2", "h1"):
                break
            if node.tag == "p" and "top" in (node.attributes.get("class") or ""):
                node = node.next
                continue
            if node.tag in ("p", "div", "ul", "ol", "table"):
                text = clean_text(node.html or "")
                if text:
                    chunks.append(text)
            node = node.next
        if chunks:
            sections[key] = "\n\n".join(chunks)
    for label in unknown:
        warnings.append(f"unrecognized site heading: {label!r}")

    photos = []
    for figure in tree.css("div.photo figure"):
        img = figure.css_first("img")
        if img is None:
            continue
        file = asset_name(img.attributes.get("src"))
        if not file:
            continue
        credit = credit_from(figure.css_first("figcaption .credit"))
        if not credit["name"]:
            warnings.append(f"photo missing credit: {file}")
        photos.append(
            ordered(
                {
                    "file": file,
                    "caption": collapse(img.attributes.get("title")),
                    "credit": credit,
                    "hero": not photos,
                },
                PHOTO_KEY_ORDER,
            )
        )

    number, ecoregions = numbers.get(slug, (None, []))
    if not ecoregions:
        try:
            ecoregions = [ECOREGION_SLUGS[int(ecoregion_id) - 1]]
        except (ValueError, IndexError):
            warnings.append(f"cannot resolve ecoregion from id {ecoregion_id!r}")
            ecoregions = [ECOREGION_SLUGS[0]]
    if not name:
        warnings.append("missing site name")

    record = {
        "slug": slug,
        "name": name,
        "number": number,
        "ecoregions": ecoregions,
        "sections": sections,
        "photos": photos,
        "lat": None,
        "lon": None,
        "county": None,
        "geocode_source": None,
        "source": {
            "url": f"https://birdweb.org/birdweb/site/{slug}/{ecoregion_id}",
            "archived": archived,
        },
    }
    return ordered(record, SITE_KEY_ORDER), warnings


def site_index() -> dict[str, tuple[int | None, list[str]]]:
    """Map site slug -> (map number, ecoregion slugs), read from the ecoregion pages.

    The site pages themselves carry neither their map number nor their ecoregion by name;
    both only exist in the listing on the parent ecoregion page. Five sites are listed
    under two ecoregions because they genuinely straddle a boundary, so this accumulates
    rather than overwrites -- ecoregions come back in canonical order.
    """
    index: dict[str, tuple[int | None, list[str]]] = {}
    for page in sorted((PAGES / "ecoregion").glob("*.html")):
        slug = page.stem
        if slug not in ECOREGION_SLUGS:
            continue
        tree = parse(page.read_bytes())
        listing = tree.css_first("#sitelist")
        if listing is None:
            continue
        for item in listing.css("li"):
            link = item.css_first("a")
            if link is None:
                continue
            href = link.attributes.get("href") or ""
            match = re.search(r"/site/([^/]+)/\d+", href, re.I)
            if not match:
                continue
            text = collapse(item.text())
            number_match = re.match(r"^(\d+)\b", text)
            site_slug = match.group(1)
            number, seen = index.get(site_slug, (None, []))
            if slug not in seen:
                seen = seen + [slug]
            index[site_slug] = (
                number if number is not None else (int(number_match.group(1)) if number_match else None),
                seen,
            )
    # Canonical order, so a straddling site always lists its ecoregions the same way.
    return {
        s: (n, sorted(e, key=ECOREGION_SLUGS.index)) for s, (n, e) in index.items()
    }


# ----------------------------------------------------------------------------------------
# Ecoregions, families, orders
# ----------------------------------------------------------------------------------------


def extract_ecoregion(path: Path, archived: str) -> tuple[dict, list[str]]:
    tree = parse(path.read_bytes())
    slug = path.stem
    heading = tree.css_first("article.content h1")
    name = collapse(heading.text()).replace(" Ecoregion and Birding Sites", "") if heading else ""

    sections: dict[str, str] = {}
    for head in tree.css("h2.details"):
        label = collapse(head.text()).lower().replace(" ", "_")
        chunks: list[str] = []
        node = head.next
        while node is not None:
            if node.tag in ("h2", "h1"):
                break
            if node.tag == "p" and "top" in (node.attributes.get("class") or ""):
                node = node.next
                continue
            if node.tag in ("p", "div", "ul", "ol"):
                text = clean_text(node.html or "")
                if text:
                    chunks.append(text)
            node = node.next
        if chunks:
            sections[label] = "\n\n".join(chunks)

    map_img = tree.css_first("table.mapimage img")
    record = {
        "slug": slug,
        "name": name,
        "sections": sections,
        "map": asset_name(map_img.attributes.get("src")) if map_img else None,
        "source": {"url": f"https://birdweb.org/birdweb/ecoregion/{slug}", "archived": archived},
    }
    return record, ([] if name else ["missing ecoregion name"])


def extract_taxon_groups(archived: str) -> tuple[list[dict], list[dict]]:
    """Family and order prose, deduplicated out of the per-species dialogs.

    Every species page repeats its order's and family's description verbatim, so the
    descriptions are collected once here instead of ~491 times.
    """
    families: dict[str, dict] = {}
    orders: dict[str, dict] = {}

    for page in sorted((PAGES / "bird").glob("*.html")):
        tree = parse(page.read_bytes())
        order_link, family_link = tree.css_first("#orderdialog"), tree.css_first("#familydialog")
        if order_link:
            name = collapse(order_link.text())
            if name and name.lower() not in orders:
                orders[name.lower()] = {
                    "slug": name.lower(),
                    "name": name,
                    "common_name": None,
                    "description": node_text(tree.css_first("#infodialogorder")),
                    "source": None,
                }
        if family_link:
            name = collapse(family_link.text())
            if name and name.lower() not in families:
                families[name.lower()] = {
                    "slug": name.lower(),
                    "name": name,
                    "common_name": None,
                    "description": node_text(tree.css_first("#infodialogfamily")),
                    "order": collapse(order_link.text()).lower() if order_link else None,
                    "source": None,
                }

    # The /birds index labels each family in plain English -- "Ducks, Geese and Swans
    # (Family Anatidae)" -- which is friendlier than the Latin and worth keeping. The name
    # is in the link text itself; scoping to article.content matters because the page's
    # sidebar carries its own headings ("Get Involved With Birds Connect Seattle!") that
    # would otherwise be mistaken for family labels.
    index = PAGES / "birds.html"
    if index.exists():
        tree = parse(index.read_bytes())
        content = tree.css_first("article.content") or tree
        for node in content.css("a"):
            href = node.attributes.get("href") or ""
            match = re.search(r"/family/([a-z]+)", href, re.I)
            if not match:
                continue
            slug = match.group(1).lower()
            label = collapse(node.text())
            if not label or slug not in families:
                continue
            # Strip the trailing "(Family Anatidae)", leaving the vernacular name.
            label = re.sub(r"\s*\(Family\s+[^)]*\)\s*$", "", label, flags=re.I).strip()
            if label:
                families[slug]["common_name"] = label

    for record in list(families.values()) + list(orders.values()):
        url_kind = "family" if "order" in record else "order"
        record["source"] = {
            "url": f"https://birdweb.org/birdweb/{url_kind}/{record['slug']}",
            "archived": archived,
        }
    return list(families.values()), list(orders.values())


# ----------------------------------------------------------------------------------------
# Static pages
# ----------------------------------------------------------------------------------------

# The legacy site's standing pages. These carry real BCS-authored prose -- how to read the
# abundance codes, what an ecoregion is, where the recordings came from -- that the rebuild
# would otherwise lose. Mapped to friendlier slugs than the originals.
STATIC_PAGES = {
    "specialconcern": "species-of-concern",
    "resources": "resources",
    "aboutbirdingsites": "about-birding-sites",
    "ecoregiondefinition": "what-is-an-ecoregion",
    "audiosource": "audio-sources",
    "abundancecode/bird_detail": "abundance-codes",
}


def extract_static_pages(archived: str) -> list[tuple[dict, list[str]]]:
    """Pull the standing pages into a `pages` collection."""
    out: list[tuple[dict, list[str]]] = []
    for legacy, slug in STATIC_PAGES.items():
        page = PAGES / f"{legacy}.html"
        if not page.exists():
            out.append(({"slug": slug}, [f"missing archived page {legacy}"]))
            continue
        tree = parse(page.read_bytes())
        content = tree.css_first("article.content")
        if content is None:
            out.append(({"slug": slug}, [f"{legacy}: no article.content"]))
            continue

        heading = content.css_first("h1")
        title = collapse(heading.text()) if heading else slug.replace("-", " ").title()
        if heading is not None:
            heading.decompose()

        # Keep sub-headings as Markdown so the page structure survives into the site.
        #
        # Walked with traverse() rather than css("h2, p, ul"): selectolax's selector lists
        # return matches grouped by selector, not in document order, which silently
        # reorders a page into "every heading, then every paragraph". And a direct-children
        # walk misses `resources`, whose whole body sits inside one wrapper div.
        BLOCK_TAGS = {"h2", "h3", "p", "ul", "ol"}

        def inside_block(node) -> bool:
            """True if a block tag already encloses this one.

            Checked by walking parents rather than by remembering visited nodes: selectolax
            creates node wrappers on the fly, so CPython reuses their id()s and an
            id-keyed "consumed" set silently discards unrelated later nodes.
            """
            parent = node.parent
            while parent is not None and parent is not content:
                if parent.tag in BLOCK_TAGS:
                    return True
                parent = parent.parent
            return False

        blocks: list[str] = []
        for node in content.traverse(include_text=False):
            if node.tag not in BLOCK_TAGS or inside_block(node):
                continue
            if node.tag in ("h2", "h3"):
                label = collapse(node.text())
                if label:
                    blocks.append(("## " if node.tag == "h2" else "### ") + label)
                continue
            if node.tag == "p" and "top" in (node.attributes.get("class") or ""):
                continue  # the "back to top" links
            text = clean_text(node.html or "")
            if text:
                blocks.append(text)

        body = "\n\n".join(dict.fromkeys(b for b in blocks if b))
        record = {
            "slug": slug,
            "title": title,
            "body": body,
            "source": {
                "url": f"https://birdweb.org/birdweb/{legacy}",
                "archived": archived,
            },
        }
        out.append((record, [] if body else [f"{legacy}: no prose extracted"]))
    return out


# ----------------------------------------------------------------------------------------
# Driver
# ----------------------------------------------------------------------------------------


@app.command()
def run(
    only: str = typer.Option("", help="Comma-separated slugs to extract, for fast iteration."),
    quiet: bool = typer.Option(False, help="Suppress the per-record warning list."),
) -> None:
    """Extract archive/ into src/content/."""
    if not PAGES.exists():
        console.print("[red]No archive found. Run `pixi run mirror` first.[/red]")
        raise typer.Exit(1)

    archived = archived_date()
    wanted = {s.strip() for s in only.split(",") if s.strip()}
    all_warnings: dict[str, list[str]] = {}
    counts: dict[str, int] = {}

    species_pages = sorted((PAGES / "bird").glob("*.html"))
    if wanted:
        species_pages = [p for p in species_pages if p.stem in wanted]
    for page in track(species_pages, description="species", console=console):
        record, warnings = extract_species(page, archived)
        target = CONTENT / "species" / f"{page.stem}.yaml"
        write_yaml(target, preserve_existing(target, record, "species"))
        if warnings:
            all_warnings[f"species/{page.stem}"] = warnings
    counts["species"] = len(species_pages)

    numbers = site_index()
    # One record per site, even though five sites have a page under each of two
    # ecoregions. The pages are identical apart from the URL, so take the first.
    site_pages = []
    seen_sites: set[str] = set()
    for page in sorted((PAGES / "site").glob("*/*.html")):
        if page.parent.name not in seen_sites:
            seen_sites.add(page.parent.name)
            site_pages.append(page)
    if wanted:
        site_pages = [p for p in site_pages if p.parent.name in wanted]
    for page in track(site_pages, description="sites   ", console=console):
        record, warnings = extract_site(page, archived, numbers)
        target = CONTENT / "sites" / f"{page.parent.name}.yaml"
        write_yaml(target, preserve_existing(target, record, "sites"))
        if warnings:
            all_warnings[f"sites/{page.parent.name}"] = warnings
    counts["sites"] = len(site_pages)

    eco_pages = sorted((PAGES / "ecoregion").glob("*.html"))
    for page in eco_pages:
        record, warnings = extract_ecoregion(page, archived)
        write_yaml(CONTENT / "ecoregions" / f"{page.stem}.yaml", record)
        if warnings:
            all_warnings[f"ecoregions/{page.stem}"] = warnings
    counts["ecoregions"] = len(eco_pages)

    if not wanted:
        for record, warnings in extract_static_pages(archived):
            if record.get("body"):
                write_yaml(CONTENT / "pages" / f"{record['slug']}.yaml", record)
            if warnings:
                all_warnings[f"pages/{record['slug']}"] = warnings
        counts["pages"] = len(STATIC_PAGES)

        families, orders = extract_taxon_groups(archived)
        for record in families:
            write_yaml(CONTENT / "families" / f"{record['slug']}.yaml", record)
        for record in orders:
            write_yaml(CONTENT / "orders" / f"{record['slug']}.yaml", record)
        counts["families"] = len(families)
        counts["orders"] = len(orders)

    table = Table(title="Extracted", show_header=True)
    table.add_column("collection")
    table.add_column("records", justify="right")
    for key, value in counts.items():
        table.add_row(key, str(value))
    console.print(table)

    if all_warnings and not quiet:
        total = sum(len(v) for v in all_warnings.values())
        console.print(f"\n[yellow]{total} warning(s) across {len(all_warnings)} record(s)[/yellow]")
        for key, warnings in list(all_warnings.items())[:25]:
            for warning in warnings:
                console.print(f"  [yellow]{key}[/yellow]: {warning}")
        if len(all_warnings) > 25:
            console.print(f"  … and {len(all_warnings) - 25} more records")
    console.print("\nNext: [bold]pixi run verify[/bold]")


if __name__ == "__main__":
    # Single-command Typer app: `run` is the implicit entry point, no subcommand needed.
    app()
