"""Mirror the legacy birdweb.org into archive/.

The original BirdWeb source code and database are lost and nobody at Birds Connect
Seattle can reach the host, so the live site is the only surviving copy of the content.
This script pulls raw bytes off it exactly once and records a checksum manifest;
everything downstream (extract_birdweb.py) parses that mirror offline.

Two consequences shape the design:

* The server is a fragile, unattended IIS 7.5 / ASP.NET 4.0 box. If it falls over nobody
  can restart it, so the crawl is single-connection with a delay between requests. There
  is no robots.txt and no observed rate limiting; we go slow anyway.
* Bytes are stored undecoded. The pages are iso-8859-1 with entity soup, and deciding how
  to normalize that is the *extractor's* job. An archive that has already been through
  someone's idea of cleanup is not an archive.

Usage:
    pixi run mirror                 # crawl (resumable; re-running skips what's done)
    pixi run mirror -- --force      # refetch everything
    pixi run verify-archive         # re-hash every file against the manifest
    python scripts/mirror_birdweb.py rewrite   # build archive/browsable/
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

import httpx
import typer
from rich.console import Console
from rich.progress import (
    track,
    BarColumn,
    MofNCompleteColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
    TimeElapsedColumn,
)
from rich.table import Table

REPO_ROOT = Path(__file__).resolve().parent.parent
ARCHIVE = REPO_ROOT / "archive"
PAGES_DIR = ARCHIVE / "pages"
ASSETS_DIR = ARCHIVE / "assets"
MANIFEST = ARCHIVE / "manifest.jsonl"

ORIGIN = "https://birdweb.org"
ROOT = f"{ORIGIN}/birdweb/"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

# Page URL shapes we archive. Anything not matching one of these is not a BirdWeb page
# and is left alone -- this is what keeps the crawl from wandering into birdsconnectsea.org
# or the dead `countries.www.birdweb.org` rewrite artifact.
PAGE_PATTERNS = [
    re.compile(r"^/birdweb/$"),
    re.compile(
        r"^/birdweb/(birds|sites|acknowledgments|resources|aboutbirdingsites"
        r"|ecoregiondefinition|audiosource|specialconcern)$"
    ),
    re.compile(r"^/birdweb/abundancecode/(bird_detail|ecoregion)$"),
    re.compile(r"^/birdweb/bird/[^/]+$"),
    re.compile(r"^/birdweb/family/[^/]+$"),
    re.compile(r"^/birdweb/ecoregion/[^/]+$"),
    re.compile(r"^/birdweb/ecoregion/sites/[^/]+/site$"),
    re.compile(r"^/birdweb/site/[^/]+/\d+$"),
]

ASSET_DIR_PATTERN = re.compile(r"^/birdweb/(images|sounds|web_images|css|js)/[^/]+$", re.I)
ROOT_ASSET_PATTERN = re.compile(
    r"^/birdweb/[^/]+\.(ico|png|svg|webmanifest|jpg|gif|css|js)$", re.I
)

# Photos exist in four renditions: _s (small), _t (filmstrip thumb), _l (180px) and -- the
# one that matters -- an UNSUFFIXED file that is the 500x500 original.
#
# Nothing in the page markup links the unsuffixed file directly. The filmstrip points at
# `bigger_image.aspx?id=...`, which returns an HTML wrapper around `<img src='images/
# MALL_fl_gl.jpg' width='500'>`. Following that endpoint per-photo would double the crawl;
# deriving the name from any sibling gets the same bytes in one request. Missing this is
# the difference between archiving 180px thumbnails and archiving the real photographs,
# so the sibling set is expanded eagerly and a 404 simply records as a 404.
VARIANT_RE = re.compile(r"^(?P<stem>.+)_(?P<variant>[stl])\.(?P<ext>jpg|jpeg|gif|png)$", re.I)
VARIANTS = ("s", "t", "l")

# href/src/data-* attributes, plus url() inside the stylesheets.
# `bigger_image.aspx?id=N&type=M` wraps a full-size image in a scrap of HTML. The maps it
# points at are referenced nowhere else, so these are followed once each and only the image
# they name is archived -- the wrapper itself is chrome.
WRAPPER_RE = re.compile(r"bigger_image\.aspx\?id=(\d+)&(?:amp;)?type=([A-Za-z])", re.I)
WRAPPED_IMG_RE = re.compile(r"""<img[^>]*src=['"]([^'"]+)['"]""", re.I)

LINK_ATTR_RE = re.compile(
    r"""(?:href|src|data-large_file|data-image_url)\s*=\s*(?P<q>["'])(?P<url>[^"']+)(?P=q)""",
    re.I,
)
CSS_URL_RE = re.compile(r"""url\(\s*(?P<q>["']?)(?P<url>[^"')]+)(?P=q)\s*\)""", re.I)
# A handful of images are named only inside inline scripts -- the search button is set via
# `$(...).css("background", "url(\"https://birdweb.org/birdweb/web_images/...\")")`, which
# no href/src scan will ever see. Matching bare birdweb URLs in the page text catches them.
INLINE_URL_RE = re.compile(
    r"""https?:\\?/\\?/(?:[\w.-]*\.)?birdweb\.org/[Bb]irdweb/[^\s"'\\<>()]+""", re.I
)

console = Console()
app = typer.Typer(add_completion=False, help=__doc__)


# --------------------------------------------------------------------------------------
# URL handling
# --------------------------------------------------------------------------------------


def canonical(url: str) -> str | None:
    """Normalize a URL to its canonical archive form, or None if it is out of scope.

    The legacy site is wildly inconsistent about case (`/birdweb/`, `/Birdweb/`,
    `/BIRDWEB/`) and some pages carry a `countries.www.birdweb.org` host that is a broken
    server-side rewrite rather than a real subdomain. Both collapse to one origin here so
    the same page is never archived twice under two names.
    """
    url = url.strip()
    if not url or url.startswith(("mailto:", "javascript:", "data:", "#", "tel:")):
        return None

    parts = urlsplit(url)
    host = parts.netloc.lower()
    if host:
        # Accept birdweb.org and any of its bogus rewrite hosts; reject everything else.
        if not (host.endswith("birdweb.org") or host.endswith("birdweb.org:443")):
            return None

    path = parts.path
    if not path.startswith("/"):
        return None

    # Normalize only the leading /birdweb segment; the rest of the path is case-sensitive
    # data (slugs are lowercase in practice, but we do not assume it).
    if re.match(r"^/birdweb/?$", path, re.I):
        path = "/birdweb/"
    elif re.match(r"^/birdweb/", path, re.I):
        path = "/birdweb/" + path[len("/birdweb/") :]
    else:
        return None

    path = unquote(path)
    # bigger_image.aspx is an HTML wrapper, not an image -- but it is the *only* place some
    # images are named. Photos are recoverable without it (the unsuffixed sibling is the
    # 500x500 original), but the nine detailed ecoregion maps are not: they live at names
    # like images/puget_trough_map.jpg that appear nowhere else in the markup. So the
    # wrapper is resolved rather than skipped; see resolve_wrapper().
    if "bigger_image.aspx" in path.lower():
        return None
    if path.lower().endswith("/searchresults"):
        return None

    query = f"?{parts.query}" if parts.query and path.lower().endswith((".ico", ".css")) else ""
    return f"{ORIGIN}{path}{query}"


def url_kind(url: str) -> str | None:
    """Classify a canonical URL as 'page', 'asset', or None (not archived)."""
    path = urlsplit(url).path
    for pattern in PAGE_PATTERNS:
        if pattern.match(path):
            return "page"
    if ASSET_DIR_PATTERN.match(path) or ROOT_ASSET_PATTERN.match(path):
        return "asset"
    return None


def local_path(url: str) -> Path:
    """Map a canonical URL to its on-disk location inside archive/."""
    path = urlsplit(url).path
    rest = path[len("/birdweb/") :]
    if not rest:
        return PAGES_DIR / "index.html"
    if ASSET_DIR_PATTERN.match(path) or ROOT_ASSET_PATTERN.match(path):
        return ASSETS_DIR / rest
    # Pages have no extension on this site; give them one so they open in a browser.
    return PAGES_DIR / f"{rest}.html"


def variant_siblings(url: str) -> list[str]:
    """Given an image URL, return the sibling _s/_t/_l renditions."""
    parts = urlsplit(url)
    directory, _, filename = parts.path.rpartition("/")
    match = VARIANT_RE.match(filename)
    if not match:
        return []
    stem, ext = match.group("stem"), match.group("ext")
    siblings = [
        f"{ORIGIN}{directory}/{stem}_{v}.{ext}"
        for v in VARIANTS
        if v != match.group("variant").lower()
    ]
    # The unsuffixed 500x500 original.
    siblings.append(f"{ORIGIN}{directory}/{stem}.{ext}")
    return siblings


def extract_links(body: bytes, base_url: str) -> list[str]:
    """Pull every in-scope URL out of a fetched document."""
    text = body.decode("iso-8859-1", errors="replace")
    found: list[str] = []
    for match in LINK_ATTR_RE.finditer(text):
        found.append(match.group("url"))
    if base_url.lower().endswith((".css", ".js")):
        for match in CSS_URL_RE.finditer(text):
            found.append(match.group("url"))
    for match in INLINE_URL_RE.finditer(text):
        found.append(match.group(0).replace("\\/", "/"))

    out: list[str] = []
    for raw in found:
        absolute = urljoin(base_url, raw.replace("&amp;", "&"))
        normalized = canonical(absolute)
        if normalized and url_kind(normalized):
            out.append(normalized)
    return out


# --------------------------------------------------------------------------------------
# Manifest
# --------------------------------------------------------------------------------------


def resolve_wrappers(
    client: httpx.Client, body: bytes, base_url: str, delay: float
) -> list[str]:
    """Follow any bigger_image.aspx wrappers on a page and return the images they name."""
    text = body.decode("iso-8859-1", errors="replace")
    out: list[str] = []
    for match in WRAPPER_RE.finditer(text):
        # Built from the origin, not urljoin(base_url, ...): the wrapper lives at
        # /birdweb/bigger_image.aspx, and joining against a page like
        # /birdweb/ecoregion/puget_trough resolves it into /birdweb/ecoregion/ instead,
        # which 404s quietly and archives nothing.
        wrapper = f"{ROOT}bigger_image.aspx?id={match.group(1)}&type={match.group(2)}"
        try:
            response = client.get(wrapper)
            time.sleep(delay)
        except httpx.HTTPError:
            continue
        if response.status_code != 200:
            continue
        for src in WRAPPED_IMG_RE.findall(response.text):
            normalized = canonical(urljoin(wrapper, src))
            if normalized and url_kind(normalized) == "asset":
                out.append(normalized)
    return out


def load_manifest() -> dict[str, dict]:
    if not MANIFEST.exists():
        return {}
    records: dict[str, dict] = {}
    with MANIFEST.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            records[record["url"]] = record  # later entries win
    return records


def append_manifest(record: dict) -> None:
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    with MANIFEST.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


# --------------------------------------------------------------------------------------
# Crawl
# --------------------------------------------------------------------------------------


@app.command()
def crawl(
    delay: float = typer.Option(0.6, help="Seconds to wait between requests."),
    force: bool = typer.Option(False, help="Refetch URLs already present in the manifest."),
    limit: int = typer.Option(0, help="Stop after N fetches (0 = no limit). For smoke tests."),
    skip_assets: bool = typer.Option(False, help="Archive pages only; useful for a dry run."),
) -> None:
    """Crawl the legacy site into archive/ (resumable)."""
    PAGES_DIR.mkdir(parents=True, exist_ok=True)
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    done = load_manifest()
    if force:
        console.print("[yellow]--force: refetching everything[/yellow]")
        done = {}

    # Two tiers, drained pages-first. The page graph is what makes the archive
    # *navigable*, and it is only ~650 URLs, so finishing it early means an interrupted
    # crawl still leaves something coherent -- and the expected-count check can catch a
    # crawler regression minutes in rather than an hour in.
    page_queue: deque[tuple[str, str]] = deque()
    asset_queue: deque[tuple[str, str]] = deque()
    seen: set[str] = set()

    def enqueue(url: str, referrer: str) -> None:
        if url in seen:
            return
        kind = url_kind(url)
        if not kind or (skip_assets and kind == "asset"):
            return
        seen.add(url)
        (page_queue if kind == "page" else asset_queue).append((url, referrer))

    enqueue(ROOT, "seed")

    fetched = skipped = failed = 0
    headers = {"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9"}

    with httpx.Client(
        headers=headers, follow_redirects=True, timeout=45.0, http2=False
    ) as client, Progress(
        SpinnerColumn(),
        TextColumn("[bold blue]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("mirroring", total=1)

        while page_queue or asset_queue:
            url, referrer = (page_queue or asset_queue).popleft()
            progress.update(task, total=len(seen), description=f"mirroring {url[-52:]}")

            target = local_path(url)
            prior = done.get(url)
            if prior and prior.get("http_status") == 200 and target.exists():
                skipped += 1
                progress.advance(task)
                # Still need this page's links to reach the rest of the graph.
                if url_kind(url) == "page" or url.lower().endswith((".css", ".js")):
                    cached = target.read_bytes()
                    for link in extract_links(cached, url):
                        enqueue(link, url)
                        for sibling in variant_siblings(link):
                            enqueue(sibling, url)
                    if url_kind(url) == "page" and WRAPPER_RE.search(
                        cached.decode("iso-8859-1", errors="replace")
                    ):
                        for wrapped in resolve_wrappers(client, cached, url, delay):
                            enqueue(wrapped, url)
                continue

            body, status, content_type, error = fetch(client, url, delay)
            if body is None:
                failed += 1
                append_manifest(
                    {
                        "url": url,
                        "local_path": None,
                        "sha256": None,
                        "content_type": content_type,
                        "content_length": 0,
                        "http_status": status,
                        "error": error,
                        "fetched_at": now_iso(),
                        "referrer": referrer,
                    }
                )
                progress.advance(task)
                continue

            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
            append_manifest(
                {
                    "url": url,
                    "local_path": str(target.relative_to(ARCHIVE)),
                    "sha256": hashlib.sha256(body).hexdigest(),
                    "content_type": content_type,
                    "content_length": len(body),
                    "http_status": status,
                    "error": None,
                    "fetched_at": now_iso(),
                    "referrer": referrer,
                }
            )
            fetched += 1

            if url_kind(url) == "page" or url.lower().endswith((".css", ".js")):
                for link in extract_links(body, url):
                    enqueue(link, url)
                    for sibling in variant_siblings(link):
                        enqueue(sibling, url)
                if url_kind(url) == "page" and WRAPPER_RE.search(
                    body.decode("iso-8859-1", errors="replace")
                ):
                    for wrapped in resolve_wrappers(client, body, url, delay):
                        enqueue(wrapped, url)

            progress.advance(task)
            if limit and fetched >= limit:
                console.print(f"[yellow]--limit {limit} reached; stopping[/yellow]")
                break

    console.print(
        f"\n[green]done[/green]  fetched={fetched}  skipped={skipped}  failed={failed}  "
        f"discovered={len(seen)}"
    )
    summarize()
    if failed:
        console.print(f"[red]{failed} URL(s) failed — re-run to retry them.[/red]")


def fetch(
    client: httpx.Client, url: str, delay: float
) -> tuple[bytes | None, int, str | None, str | None]:
    """Fetch one URL with backoff. Returns (body, status, content_type, error)."""
    backoff = 2.0
    for attempt in range(4):
        try:
            response = client.get(url)
        except httpx.HTTPError as exc:
            if attempt == 3:
                return None, 0, None, f"{type(exc).__name__}: {exc}"
            time.sleep(backoff)
            backoff *= 2
            continue

        if response.status_code == 200:
            time.sleep(delay)
            return (
                response.content,
                200,
                response.headers.get("content-type"),
                None,
            )
        if response.status_code in (429, 500, 502, 503, 504) and attempt < 3:
            time.sleep(backoff)
            backoff *= 2
            continue
        time.sleep(delay)
        return None, response.status_code, response.headers.get("content-type"), "http error"
    return None, 0, None, "exhausted retries"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------------------
# Offline rewrite
# --------------------------------------------------------------------------------------

BROWSABLE = ARCHIVE / "browsable"

# The home page's "Birding Site of the Week" links a site without its ecoregion id --
# /birdweb/site/fort_simcoe_state_park rather than .../6 -- and the server resolves it.
# The page itself is archived under whichever id it was crawled with, so the bare form has
# to be mapped onto that file or the offline copy keeps a link to a server that will die.
BARE_SITE_RE = re.compile(r"^/birdweb/site/([^/]+)/?$", re.I)


def resolve_bare_site(path: str) -> Path | None:
    """Map /birdweb/site/<slug> (no ecoregion id) onto the archived page for that slug."""
    match = BARE_SITE_RE.match(path)
    if not match:
        return None
    directory = PAGES_DIR / "site" / match.group(1)
    if not directory.is_dir():
        return None
    pages = sorted(directory.glob("*.html"))
    return pages[0] if pages else None

# The pages load jQuery and jQuery UI from Google's CDN. They are third-party and MIT
# licensed, but without them the archived pages lose their tab widgets and image filmstrip,
# so a faithful offline copy has to carry them. Analytics is deliberately NOT vendored:
# it is tracking, not content, and an archive should not phone home.
VENDOR_SCRIPTS = {
    "https://ajax.googleapis.com/ajax/libs/jquery/1.5.2/jquery.min.js": "jquery.min.js",
    "https://ajax.googleapis.com/ajax/libs/jqueryui/1.8.17/jquery-ui.min.js": "jquery-ui.min.js",
}


@app.command()
def rewrite() -> None:
    """Build archive/browsable/ -- the mirror with links rewritten to relative paths.

    This is the difference between a folder of files and a preserved site. Someone opening
    the tarball in twenty years should be able to double-click index.html and click through
    every species, site and ecoregion with no web server, no network and none of this
    tooling.
    """
    if not PAGES_DIR.exists():
        console.print("[red]Nothing to rewrite. Run `pixi run mirror` first.[/red]")
        raise typer.Exit(1)

    if BROWSABLE.exists():
        shutil.rmtree(BROWSABLE)
    BROWSABLE.mkdir(parents=True)

    # Fetch the CDN scripts once into the browsable tree.
    vendor_dir = BROWSABLE / "vendor"
    vendor_dir.mkdir(parents=True, exist_ok=True)
    headers = {"User-Agent": USER_AGENT}
    with httpx.Client(headers=headers, follow_redirects=True, timeout=30.0) as client:
        for url, name in VENDOR_SCRIPTS.items():
            target = vendor_dir / name
            if target.exists():
                continue
            try:
                response = client.get(url)
                if response.status_code == 200:
                    target.write_bytes(response.content)
                    console.print(f"  vendored {name} ({len(response.content) / 1024:.0f} KB)")
            except httpx.HTTPError as exc:
                console.print(f"  [yellow]could not vendor {name}: {exc}[/yellow]")

    pages = sorted(PAGES_DIR.rglob("*.html"))
    written = 0

    for page in track(pages, description="rewriting", console=console):
        rel = page.relative_to(PAGES_DIR)
        target = BROWSABLE / "pages" / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        html = page.read_bytes().decode("iso-8859-1", errors="replace")

        here_dir = (Path("pages") / rel).parent

        def to_relative(match: re.Match[str]) -> str:
            attr, quote, raw = match.group("attr"), match.group("q"), match.group("url")
            if raw in VENDOR_SCRIPTS:
                dest = Path("vendor") / VENDOR_SCRIPTS[raw]
                return f'{attr}={quote}{os.path.relpath(dest, here_dir)}{quote}'
            absolute = urljoin(f"{ORIGIN}{'/birdweb/'}{rel.as_posix()}", raw)
            normalized = canonical(absolute)
            if not normalized:
                return match.group(0)
            bare = resolve_bare_site(urlsplit(normalized).path)
            if bare is not None:
                dest_rel = Path("pages") / bare.relative_to(PAGES_DIR)
                return f'{attr}={quote}{os.path.relpath(dest_rel, here_dir)}{quote}'
            kind = url_kind(normalized)
            if not kind:
                return match.group(0)
            dest = local_path(normalized)
            # Assets sit beside pages/ in the browsable tree, so relativize from the page.
            dest_rel = (
                Path("pages") / dest.relative_to(PAGES_DIR)
                if kind == "page"
                else Path("assets") / dest.relative_to(ASSETS_DIR)
            )
            here = (Path("pages") / rel).parent
            return f'{attr}={quote}{os.path.relpath(dest_rel, here)}{quote}'

        html = re.sub(
            r"""(?P<attr>href|src)\s*=\s*(?P<q>["'])(?P<url>[^"']+)(?P=q)""",
            to_relative,
            html,
            flags=re.I,
        )
        # Second pass: any absolute birdweb URL still left is inside an inline script (the
        # search button sets its own background image that way). The attribute pass above
        # has already turned every real link relative, so whatever matches here is JS.
        def inline_to_relative(match: re.Match[str]) -> str:
            normalized = canonical(match.group(0).replace("\\/", "/"))
            if not normalized:
                return match.group(0)
            bare = resolve_bare_site(urlsplit(normalized).path)
            if bare is not None:
                return os.path.relpath(Path("pages") / bare.relative_to(PAGES_DIR), here_dir)
            if not url_kind(normalized):
                return match.group(0)
            dest = local_path(normalized)
            kind = url_kind(normalized)
            dest_rel = (
                Path("pages") / dest.relative_to(PAGES_DIR)
                if kind == "page"
                else Path("assets") / dest.relative_to(ASSETS_DIR)
            )
            return os.path.relpath(dest_rel, here_dir)

        html = INLINE_URL_RE.sub(inline_to_relative, html)
        html = re.sub(
            r"<script[^>]*googletagmanager[^>]*>.*?</script>", "", html, flags=re.S | re.I
        )
        target.write_text(html, encoding="iso-8859-1", errors="replace")
        written += 1

    # Assets are hardlinked where the filesystem allows it, so the browsable copy costs
    # almost nothing on disk; tar resolves them back to regular files.
    linked = 0
    for asset in ASSETS_DIR.rglob("*"):
        if not asset.is_file():
            continue
        dest = BROWSABLE / "assets" / asset.relative_to(ASSETS_DIR)
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(asset, dest)
        except OSError:
            shutil.copy2(asset, dest)
        linked += 1

    (BROWSABLE / "index.html").write_text(
        "<!doctype html>\n<meta charset='iso-8859-1'>\n"
        "<title>BirdWeb archive</title>\n"
        "<meta http-equiv='refresh' content='0; url=pages/index.html'>\n"
        "<p>Opening the <a href='pages/index.html'>BirdWeb archive</a>…</p>\n",
        encoding="utf-8",
    )

    console.print(
        f"\n[green]{written} pages rewritten, {linked} assets linked.[/green]\n"
        f"Open [bold]{BROWSABLE / 'index.html'}[/bold] with the network off."
    )


# --------------------------------------------------------------------------------------
# Verify
# --------------------------------------------------------------------------------------

# What the live site held when this tool was written, verified by hand against the
# homepage autocomplete array and the /birds family index on 2026-09-11. If a later crawl
# disagrees, either the site changed or the crawler regressed -- both are worth knowing.
EXPECTED = {"species": 491, "sites": 69, "ecoregions": 10, "families": 64}


@app.command()
def verify() -> None:
    """Re-hash every archived file against the manifest and report coverage."""
    records = load_manifest()
    if not records:
        console.print("[red]No manifest found. Run `pixi run mirror` first.[/red]")
        raise typer.Exit(1)

    missing: list[str] = []
    corrupt: list[str] = []
    errored = [r for r in records.values() if r.get("http_status") != 200]

    for url, record in records.items():
        if record.get("http_status") != 200:
            continue
        path = ARCHIVE / record["local_path"]
        if not path.exists():
            missing.append(url)
            continue
        if hashlib.sha256(path.read_bytes()).hexdigest() != record["sha256"]:
            corrupt.append(url)

    summarize()

    table = Table(title="Integrity", show_header=True)
    table.add_column("check")
    table.add_column("result", justify="right")
    table.add_row("manifest records", str(len(records)))
    table.add_row("missing files", f"[red]{len(missing)}[/red]" if missing else "0")
    table.add_row("checksum mismatches", f"[red]{len(corrupt)}[/red]" if corrupt else "0")
    table.add_row("non-200 URLs", f"[yellow]{len(errored)}[/yellow]" if errored else "0")
    console.print(table)

    for url in missing[:10]:
        console.print(f"  [red]missing[/red] {url}")
    for url in corrupt[:10]:
        console.print(f"  [red]corrupt[/red] {url}")
    for record in errored[:10]:
        console.print(f"  [yellow]{record.get('http_status')}[/yellow] {record['url']}")

    counts = page_counts()
    shortfall = {k: v - counts.get(k, 0) for k, v in EXPECTED.items() if counts.get(k, 0) < v}
    if missing or corrupt or shortfall:
        if shortfall:
            console.print(f"[red]Short of expected counts: {shortfall}[/red]")
        raise typer.Exit(1)
    console.print("[green]Archive verified.[/green]")


def page_counts() -> dict[str, int]:
    def count(pattern: str) -> int:
        return len(list(PAGES_DIR.glob(pattern))) if PAGES_DIR.exists() else 0

    # Sites are counted by unique slug, not by page: five sites straddle an ecoregion
    # boundary and the legacy site served each of them under two URLs.
    site_slugs = (
        {p.parent.name for p in PAGES_DIR.glob("site/*/*.html")} if PAGES_DIR.exists() else set()
    )
    return {
        "species": count("bird/*.html"),
        "sites": len(site_slugs),
        "ecoregions": count("ecoregion/*.html"),
        "families": count("family/*.html"),
    }


def summarize() -> None:
    counts = page_counts()
    table = Table(title="Archive contents", show_header=True)
    table.add_column("kind")
    table.add_column("archived", justify="right")
    table.add_column("expected", justify="right")
    for key, expected in EXPECTED.items():
        got = counts.get(key, 0)
        marker = "[green]" if got >= expected else "[red]"
        table.add_row(key, f"{marker}{got}[/]", str(expected))

    images = len(list((ASSETS_DIR / "images").glob("*"))) if (ASSETS_DIR / "images").exists() else 0
    sounds = len(list((ASSETS_DIR / "sounds").glob("*"))) if (ASSETS_DIR / "sounds").exists() else 0
    table.add_row("images", str(images), "~3000")
    table.add_row("sounds", str(sounds), "~400")
    console.print(table)

    if ARCHIVE.exists():
        total = sum(f.stat().st_size for f in ARCHIVE.rglob("*") if f.is_file())
        console.print(f"archive size: [bold]{total / 1e9:.2f} GB[/bold]  at {ARCHIVE}")


if __name__ == "__main__":
    # A bare `python mirror_birdweb.py` should crawl; subcommands are opt-in.
    if len(sys.argv) == 1 or sys.argv[1].startswith("-"):
        sys.argv.insert(1, "crawl")
    app()
