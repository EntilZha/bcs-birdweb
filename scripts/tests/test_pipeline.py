"""Tests for the archive/extract pipeline.

These cover the decisions that were expensive to get right and are easy to break
silently: text normalization of a 2005 Windows-1252 page, the shape of the abundance
matrix, the taxonomy matching ladder that must refuse to guess, the geocoder's refusal to
propose a building, and the rule that re-running `extract` never discards a coordinate a
person confirmed by hand.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from birdweb_text import clean_text, collapse, fix_encoding  # noqa: E402
import extract_birdweb as ex  # noqa: E402
import geocode_sites as geo  # noqa: E402
import map_taxonomy as tax  # noqa: E402


# ----------------------------------------------------------------------------------------
# Text normalization
# ----------------------------------------------------------------------------------------


class TestTextNormalization:
    def test_doubled_apostrophes_become_curly_quotes(self):
        # The site prose types quotation marks as '' … '' throughout.
        assert clean_text("the ''East Meadow'' has forbs") == "the “East Meadow” has forbs"

    def test_windows_1252_control_bytes_are_repaired(self):
        # Pages declare iso-8859-1 but were authored in cp1252, so an apostrophe arrives
        # as \x92 and would otherwise sit in the output as an invisible control character.
        assert fix_encoding("Ross\x92s Goose") == "Ross’s Goose"
        assert fix_encoding("a \x97 b") == "a — b"

    def test_double_br_becomes_a_paragraph_break(self):
        assert clean_text("one<br/><br/>two") == "one\n\ntwo"

    def test_single_br_is_a_line_break_not_a_paragraph(self):
        assert clean_text("one<br/>two") == "one\ntwo"

    def test_emphasis_survives_as_markdown(self):
        # The volunteer authors italicised scientific names deliberately.
        assert clean_text("<em>Carex</em> sedge") == "*Carex* sedge"

    def test_links_survive_as_markdown(self):
        out = clean_text('see <a href="https://x.org">the code</a>')
        assert out == "see [the code](https://x.org)"

    def test_empty_links_are_dropped_rather_than_left_as_empty_brackets(self):
        assert clean_text('<a href="https://x.org"></a>text').strip() == "text"

    def test_entities_are_unescaped(self):
        assert clean_text("a &#8212; b &amp; c") == "a — b & c"

    def test_collapse_flattens_multiline_names(self):
        # #scientific_name puts genus and species on separate lines.
        assert collapse("  Anas\n     platyrhynchos ") == "Anas platyrhynchos"


# ----------------------------------------------------------------------------------------
# Abundance
# ----------------------------------------------------------------------------------------

ABUNDANCE_HTML = """
<div id='concern'><table>
<tr><th>Ecoregion</th><th>Jan</th></tr>
<tr><th class='birdname'><a href='https://birdweb.org/birdweb/ecoregion/puget_trough'>Puget Trough</a></th>
{puget}</tr>
<tr><th class='birdname'><a href='https://birdweb.org/birdweb/ecoregion/oceanic'>Oceanic</a></th>
{oceanic}</tr>
</table></div>
"""


def _abundance(puget: str, oceanic: str):
    from selectolax.parser import HTMLParser

    cells = lambda row: "".join(f"<td>{c}</td>" for c in row)  # noqa: E731
    html = ABUNDANCE_HTML.format(puget=cells(puget), oceanic=cells(oceanic))
    return ex.extract_abundance(HTMLParser(html))


class TestAbundance:
    def test_rows_are_keyed_by_the_ecoregion_link_not_by_position(self):
        # The table lists Puget Trough before Oceanic; canonical order is the reverse.
        # Keying by position here would swap two species' worth of data.
        matrix, _ = _abundance("CCCCCCCCCCCC", "RRRRRRRRRRRR")
        assert matrix["puget_trough"] == list("CCCCCCCCCCCC")
        assert matrix["oceanic"] == list("RRRRRRRRRRRR")

    def test_every_ecoregion_is_present_even_when_the_table_omits_it(self):
        matrix, _ = _abundance("CCCCCCCCCCCC", "            ")
        assert set(matrix) == set(ex.ECOREGION_SLUGS)
        assert all(len(row) == 12 for row in matrix.values())

    def test_blank_cells_mean_absent(self):
        matrix, _ = _abundance("CC  CC  CC  ", " " * 12)
        assert matrix["puget_trough"] == ["C", "C", "", "", "C", "C", "", "", "C", "C", "", ""]

    def test_a_short_row_is_reported_rather_than_written(self):
        matrix, warnings = _abundance("CCC", " " * 12)
        assert any("expected 12 months" in w for w in warnings)
        # The bad row must not land in the data half-filled.
        assert matrix["puget_trough"] == [""] * 12

    def test_unknown_codes_are_reported_and_dropped(self):
        matrix, warnings = _abundance("CCCCCCCCCCCX", " " * 12)
        assert any("unexpected abundance codes" in w for w in warnings)
        assert matrix["puget_trough"][11] == ""

    def test_a_missing_table_is_flagged_as_a_rarity_account(self):
        from selectolax.parser import HTMLParser

        _, warnings = ex.extract_abundance(HTMLParser("<div></div>"))
        assert any(w.startswith("RARITY:") for w in warnings)


# ----------------------------------------------------------------------------------------
# Round-tripping and preservation
# ----------------------------------------------------------------------------------------


class TestSerialization:
    def test_abundance_rows_are_written_in_flow_style(self, tmp_path: Path):
        # Block style would make one species 120 lines and a one-cell edit unreviewable --
        # and would diverge from what the editor's JS writer produces.
        target = tmp_path / "x.yaml"
        ex.write_yaml(target, {"abundance": {"oceanic": ex.FlowList(["C"] * 12)}})
        assert "oceanic: [C, C, C, C, C, C, C, C, C, C, C, C]" in target.read_text()

    def test_multi_paragraph_prose_is_written_as_a_literal_block(self, tmp_path: Path):
        target = tmp_path / "x.yaml"
        ex.write_yaml(target, {"body": "one\n\ntwo"})
        assert "body: |-" in target.read_text()

    def test_key_order_is_stable(self):
        out = ex.ordered({"source": 1, "slug": 2, "status": 3}, ex.SPECIES_KEY_ORDER)
        assert list(out) == ["slug", "status", "source"]

    def test_unknown_keys_are_preserved_at_the_end(self):
        out = ex.ordered({"slug": 1, "invented_later": 2}, ex.SPECIES_KEY_ORDER)
        assert out["invented_later"] == 2


class TestPreservation:
    """Re-running `extract` must never destroy what a person confirmed by hand."""

    def test_a_confirmed_coordinate_survives_re_extraction(self, tmp_path: Path):
        target = tmp_path / "marymoor_park.yaml"
        ex.write_yaml(
            target,
            {"slug": "marymoor_park", "lat": 47.6587, "lon": -122.1111,
             "county": "King", "geocode_source": "confirmed"},
        )
        fresh = {"slug": "marymoor_park", "lat": None, "lon": None,
                 "county": None, "geocode_source": None}
        merged = ex.preserve_existing(target, fresh, "sites")
        assert merged["lat"] == 47.6587
        assert merged["geocode_source"] == "confirmed"

    def test_the_taxonomy_layer_survives_re_extraction(self, tmp_path: Path):
        target = tmp_path / "gray_jay.yaml"
        ex.write_yaml(target, {"slug": "gray_jay", "taxonomy": {"ebird_code": "gryjay"}})
        merged = ex.preserve_existing(
            target, {"slug": "gray_jay", "taxonomy": {"ebird_code": None}}, "species"
        )
        assert merged["taxonomy"]["ebird_code"] == "gryjay"

    def test_archive_owned_fields_are_still_refreshed(self, tmp_path: Path):
        target = tmp_path / "x.yaml"
        ex.write_yaml(target, {"slug": "x", "name": "Old Name", "lat": 1.0})
        merged = ex.preserve_existing(target, {"slug": "x", "name": "New Name"}, "sites")
        assert merged["name"] == "New Name"   # the archive is authoritative here
        assert merged["lat"] == 1.0           # this is not

    def test_a_missing_file_is_not_an_error(self, tmp_path: Path):
        fresh = {"slug": "new", "lat": None}
        assert ex.preserve_existing(tmp_path / "nope.yaml", fresh, "sites") == fresh


# ----------------------------------------------------------------------------------------
# Taxonomy
# ----------------------------------------------------------------------------------------


class TestTaxonomyNormalization:
    @pytest.mark.parametrize(
        "a,b",
        [
            ("Ross's Goose", "Rosss Goose"),
            ("Fulvous Whistling-Duck", "Fulvous Whistling Duck"),
        ],
    )
    def test_punctuation_and_hyphen_drift_folds_away(self, a: str, b: str):
        assert tax.normalize(a) == tax.normalize(b)

    def test_a_word_break_is_deliberately_not_folded(self):
        # BirdWeb writes "Le Conte's Sparrow", eBird writes "LeConte's Sparrow". Folding
        # internal spaces would match them, but it would also merge genuinely distinct
        # names, so this stays a human call -- it is one of the entries in
        # src/config/taxonomy-overrides.yaml.
        assert tax.normalize("LeConte's Sparrow") != tax.normalize("Le Conte's Sparrow")

    def test_case_and_accents_fold_away(self):
        assert tax.normalize("ANAS platyrhynchos") == tax.normalize("Anas Platyrhynchos")


# ----------------------------------------------------------------------------------------
# Geocoding
# ----------------------------------------------------------------------------------------


def _osm(category: str, typ: str, display: str, importance: float = 0.3) -> dict:
    return {
        "category": category,
        "type": typ,
        "display_name": display,
        "importance": importance,
    }


class TestGeocodeScoring:
    """The scorer exists because Nominatim's top hit proposed an apartment block for
    Samish Flats, a fire station for Green Lake and a notice board for Naches Peak."""

    def test_a_building_is_rejected_outright(self):
        points, why = geo.score("Samish Flats", _osm("building", "apartments", "Samish Flats"))
        assert points == 0.0
        assert "not a place you go birding" in why

    def test_a_fire_station_is_rejected_even_with_a_perfect_name_match(self):
        points, _ = geo.score(
            "Seattle - Green Lake", _osm("amenity", "fire_station", "Green Lake, Seattle")
        )
        assert points == 0.0

    def test_a_notice_board_is_rejected(self):
        points, _ = geo.score("Naches Peak Loop", _osm("tourism", "board", "Naches Peak Loop"))
        assert points == 0.0

    def test_a_nature_reserve_with_a_matching_name_clears_the_bar(self):
        points, _ = geo.score(
            "Nisqually National Wildlife Refuge",
            _osm("leisure", "nature_reserve", "Nisqually National Wildlife Refuge, Thurston"),
        )
        assert points >= geo.THRESHOLD

    def test_a_credible_type_with_an_unrelated_name_does_not_clear_the_bar(self):
        points, _ = geo.score(
            "Samish Flats", _osm("leisure", "nature_reserve", "Somewhere Else, Idaho", 0.1)
        )
        assert points < geo.THRESHOLD

    def test_the_category_field_is_read_not_just_class(self):
        # jsonv2 returns `category`; reading only `class` silently disables every type
        # rule above and reduces the score to name similarity.
        assert geo.score("X", _osm("building", "apartments", "X"))[0] == 0.0
        assert geo.score("X", {"class": "building", "type": "apartments", "display_name": "X"})[0] == 0.0

    def test_queries_strip_the_city_prefix_the_geocoder_cannot_use(self):
        queries = geo.queries_for("Seattle - Discovery Park")
        assert any(q.startswith("Discovery Park") for q in queries)

    def test_queries_split_slash_joined_names(self):
        queries = geo.queries_for("Blaine/Semiahmoo/Drayton Harbor")
        assert any(q.startswith("Blaine,") for q in queries)
