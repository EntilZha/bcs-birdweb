"""Shared text normalization for the BirdWeb extraction pipeline.

The legacy pages are iso-8859-1 with entity soup, em dashes encoded as `&#8212;`, and --
in the birding-site prose -- quotation marks typed as doubled ASCII apostrophes (``the
''East Meadow'' has bunchgrasses``). Paragraph breaks are `<br/><br/>` rather than real
`<p>` elements in several places.

Everything that decides how to clean that up lives here rather than in the archive, so the
mirror stays a faithful copy of what the server served and the cleanup stays reviewable in
one file.
"""

from __future__ import annotations

import html as html_module
import re

from selectolax.parser import HTMLParser, Node

# `''quoted''` -> curly quotes. Applied after tag stripping so it cannot eat an attribute.
DOUBLED_APOSTROPHE_RE = re.compile(r"''(.+?)''", re.S)
BR_BREAK_RE = re.compile(r"(?:\s*<br\s*/?>\s*){2,}", re.I)
TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"[^\S\n]+")
BLANKLINES_RE = re.compile(r"\n{3,}")

# The pages declare iso-8859-1 but were authored in Windows-1252, so smart quotes, en/em
# dashes and ellipses arrive as C1 control characters when decoded strictly as latin-1.
# Mapping them back is what keeps apostrophes from showing up as invisible control codes
# in the middle of "Ross's Goose".
CP1252_FIXUPS = {
    "\x91": "‘",  # left single quote
    "\x92": "’",  # right single quote / apostrophe
    "\x93": "“",  # left double quote
    "\x94": "”",  # right double quote
    "\x95": "•",  # bullet
    "\x96": "–",  # en dash
    "\x97": "—",  # em dash
    "\x85": "…",  # ellipsis
    "\xa0": " ",       # non-breaking space
}


def decode(raw: bytes) -> str:
    """Decode an archived page. The site declares iso-8859-1 and means it."""
    return raw.decode("iso-8859-1", errors="replace")


def inline_markdown(fragment: str) -> str:
    """Convert the handful of inline tags the accounts actually use into Markdown.

    Emphasis carries meaning in these texts -- scientific names and vernacular terms are
    italicized -- so flattening everything to plain text would lose information that the
    volunteer authors deliberately added.
    """
    fragment = re.sub(
        r"<\s*(?:em|i)\b[^>]*>(.*?)<\s*/\s*(?:em|i)\s*>", r"*\1*", fragment, flags=re.S | re.I
    )
    fragment = re.sub(
        r"<\s*(?:strong|b)\b[^>]*>(.*?)<\s*/\s*(?:strong|b)\s*>",
        r"**\1**",
        fragment,
        flags=re.S | re.I,
    )
    fragment = re.sub(
        r"""<\s*a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>(.*?)<\s*/\s*a\s*>""",
        lambda m: f"[{m.group(3)}]({m.group(2)})" if m.group(3).strip() else "",
        fragment,
        flags=re.S | re.I,
    )
    return fragment


def fix_encoding(text: str) -> str:
    for bad, good in CP1252_FIXUPS.items():
        text = text.replace(bad, good)
    return text


def clean_text(fragment: str) -> str:
    """Turn an HTML fragment into normalized Markdown-ish prose."""
    fragment = BR_BREAK_RE.sub("\n\n", fragment)
    fragment = re.sub(r"<br\s*/?>", "\n", fragment, flags=re.I)
    fragment = inline_markdown(fragment)
    text = TAG_RE.sub("", fragment)
    text = html_module.unescape(text)
    text = fix_encoding(text)
    text = DOUBLED_APOSTROPHE_RE.sub(lambda m: "“" + m.group(1) + "”", text)

    lines = [WS_RE.sub(" ", line).strip() for line in text.split("\n")]
    text = "\n".join(lines)
    text = BLANKLINES_RE.sub("\n\n", text)
    return text.strip()


def node_text(node: Node | None) -> str:
    """Normalized prose for a whole node, paragraph structure preserved."""
    if node is None:
        return ""
    paragraphs: list[str] = []
    blocks = node.css("p")
    if blocks:
        for block in blocks:
            chunk = clean_text(block.html or "")
            paragraphs.extend(part for part in chunk.split("\n\n") if part)
    else:
        chunk = clean_text(node.html or "")
        paragraphs.extend(part for part in chunk.split("\n\n") if part)
    return "\n\n".join(paragraphs)


def collapse(value: str | None) -> str:
    """Collapse all whitespace to single spaces -- for names and one-line fields."""
    if not value:
        return ""
    text = fix_encoding(html_module.unescape(value))
    return re.sub(r"\s+", " ", text).strip()


def parse(raw: bytes) -> HTMLParser:
    return HTMLParser(decode(raw))
