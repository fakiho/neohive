#!/usr/bin/env python3
"""Acceptance tests for the <title>/<h1> search terms on the static site.

Run from the repo root:
    python3 tests/website/test_search_terms.py
    python3 -m unittest discover -s tests/website

The page must be findable for the queries people actually type: it needs the
category term and client names in the document title (snippet-sized) and the
category term in the single <h1>. A term claimed in the title or <h1> must
also be real copy, not a keyword planted for crawlers: every client named in
the title must occur in the visible body, and the category term used in the
<h1> must occur in the body outside that <h1>. Terms in <head> meta tags or
JSON-LD do not satisfy either check.

"coding agents" is deliberately part of the asserted category set even though
it currently appears nowhere in the page except the <h1> itself; the H1
substantiation test is what demands body prose to back it up.

Locates the published site relative to this file (repo_root/website), never by
absolute path. No network access.
"""

import html
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
INDEX_HTML = REPO_ROOT / "website" / "index.html"

PRODUCT_NAME = "neoHive"

# Category terms the page body already supports, except "coding agents", which
# today appears only in the <h1> and nowhere else (see the substantiation test
# in H1Tests). "AI agents" is deliberately excluded: it is a head term the page
# cannot win, while MCP / coding agents is the winnable category this change
# targets.
CATEGORY_TERMS = (
    "MCP",
    "coding agent",
    "coding agents",
)

# Client names the page body already supports.
CLIENT_NAMES = (
    "Claude Code",
    "Cursor",
    "Gemini CLI",
    "Copilot",
    "Codex",
)

# Hard ceiling for a search-result title; well under is the norm.
TITLE_MAX_CHARS = 70
# At most this many client names are required (two distinct is the criterion).
REQUIRED_CLIENT_NAMES = 2

TITLE_RE = re.compile(r"(?is)<title\b[^>]*>(.*?)</title\s*>")
H1_RE = re.compile(r"(?is)<h1\b[^>]*>(.*?)</h1\s*>")
BODY_RE = re.compile(r"(?is)<body\b[^>]*>(.*?)</body\s*>")
SCRIPT_STYLE_RE = re.compile(r"(?is)<(script|style)\b[^>]*>.*?</\1\s*>")
TAG_RE = re.compile(r"(?s)<[^>]+>")

_QUOTE_MAP = str.maketrans(
    {
        "\u2018": "'",
        "\u2019": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u2013": "-",
        "\u2014": "-",
        "\u2026": "...",
    }
)


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def read_text(path):
    return path.read_text(encoding="utf-8")


def normalize_text(value):
    """Unescape entities, strip inner tags, unify punctuation, collapse space."""
    value = TAG_RE.sub(" ", value)
    value = html.unescape(value)
    value = value.replace("\u00a0", " ").translate(_QUOTE_MAP)
    return re.sub(r"\s+", " ", value).strip()


def contains_term(text, term):
    """Case-insensitive whole-term match ("AI agent" must not match "AI agentsx")."""
    pattern = r"(?<![\w-])" + re.escape(term) + r"(?![\w-])"
    return re.search(pattern, text, re.IGNORECASE) is not None


def matching_terms(text, terms):
    return [term for term in terms if contains_term(text, term)]


def contains_exact_term(text, term):
    """Case-sensitive whole-term match, for proper nouns (clients, brand)."""
    pattern = r"(?<![\w-])" + re.escape(term) + r"(?![\w-])"
    return re.search(pattern, text) is not None


def visible_body_text(page_text, drop_h1=False):
    """Rendered prose of the <body>, or None when the page has no <body>.

    <script>/<style> contents and all tags (so every <head> meta tag, the
    JSON-LD blocks and attribute values) are excluded, leaving only text a
    reader sees. drop_h1=True additionally removes the <h1> element.
    """
    match = BODY_RE.search(page_text)
    if match is None:
        return None
    markup = match.group(1)
    if drop_h1:
        markup = H1_RE.sub(" ", markup)
    return normalize_text(SCRIPT_STYLE_RE.sub(" ", markup))


# --------------------------------------------------------------------------
# criterion 1-2: the document title carries category + clients, and fits
# --------------------------------------------------------------------------
class TitleTests(unittest.TestCase):
    def _title(self):
        page = read_text(INDEX_HTML)
        matches = TITLE_RE.findall(page)
        self.assertEqual(
            len(matches),
            1,
            "website/index.html must contain exactly one <title> element, "
            "found %d" % len(matches),
        )
        title = normalize_text(matches[0])
        self.assertTrue(title, "the <title> element is empty")
        return title

    def test_title_names_product_in_canonical_casing(self):
        title = self._title()
        self.assertIn(
            PRODUCT_NAME,
            title,
            "the <title> must contain the product name %r in exactly that "
            "casing, got: %r" % (PRODUCT_NAME, title),
        )

    def test_title_names_category(self):
        title = self._title()
        found = matching_terms(title, CATEGORY_TERMS)
        self.assertTrue(
            found,
            "the <title> names no category term from %r, so it cannot rank "
            "for them; got: %r" % (CATEGORY_TERMS, title),
        )

    def test_title_names_at_least_two_clients(self):
        title = self._title()
        found = matching_terms(title, CLIENT_NAMES)
        self.assertGreaterEqual(
            len(found),
            REQUIRED_CLIENT_NAMES,
            "the <title> must name at least %d distinct clients from %r, "
            "found %d (%r); got: %r"
            % (
                REQUIRED_CLIENT_NAMES,
                CLIENT_NAMES,
                len(found),
                found,
                title,
            ),
        )

    def test_title_is_snippet_sized(self):
        title = self._title()
        self.assertLessEqual(
            len(title),
            TITLE_MAX_CHARS,
            "the <title> is %d characters, over the %d-character snippet "
            "ceiling and will be truncated; got: %r"
            % (len(title), TITLE_MAX_CHARS, title),
        )

    def test_title_never_miscases_the_brand(self):
        title = self._title()
        miscased = [
            match
            for match in re.findall(r"neo\s*hive", title, re.IGNORECASE)
            if match != PRODUCT_NAME
        ]
        self.assertEqual(
            miscased,
            [],
            "the <title> writes the brand as %r; it must always be %r"
            % (miscased, PRODUCT_NAME),
        )

    def test_title_clients_appear_in_body_copy(self):
        """Every client named in the <title> must be real, visible page copy.

        Guards against a fabricated client claim: naming a client only in
        <head> meta tags, JSON-LD or the <title> itself does not count.
        """
        title = self._title()
        clients = matching_terms(title, CLIENT_NAMES)
        self.assertGreaterEqual(
            len(clients),
            REQUIRED_CLIENT_NAMES,
            "cannot check client substantiation: the <title> names only %d "
            "client(s) from %r, so the client criterion is failing "
            "separately; got: %r" % (len(clients), CLIENT_NAMES, title),
        )
        body = visible_body_text(read_text(INDEX_HTML))
        self.assertIsNotNone(
            body,
            "website/index.html has no <body> element, so the visible body "
            "copy cannot be checked",
        )
        unbacked = [
            client for client in clients if not contains_exact_term(body, client)
        ]
        self.assertEqual(
            unbacked,
            [],
            "the <title> names client(s) %r that never appear in the page's "
            "visible body copy; a client named in the title must be written "
            "in rendered prose, not only in <head> meta tags, JSON-LD or the "
            "title itself" % (unbacked,),
        )


# --------------------------------------------------------------------------
# criterion 3: the single visible <h1> carries the category
# --------------------------------------------------------------------------
class H1Tests(unittest.TestCase):
    def _h1(self):
        page = read_text(INDEX_HTML)
        matches = H1_RE.findall(page)
        self.assertEqual(
            len(matches),
            1,
            "website/index.html must keep exactly one <h1> heading, found %d"
            % len(matches),
        )
        heading = normalize_text(matches[0])
        self.assertTrue(heading, "the <h1> heading has no readable text")
        return heading

    def test_h1_names_category(self):
        heading = self._h1()
        found = matching_terms(heading, CATEGORY_TERMS)
        self.assertTrue(
            found,
            "the <h1> names no category term from %r, so the strongest "
            "heading signal cannot rank for them; got: %r"
            % (CATEGORY_TERMS, heading),
        )

    def test_h1_category_is_substantiated_in_body_copy(self):
        """A category term in the <h1> must also be real copy elsewhere.

        Guards against planting a keyword in the strongest heading while the
        page never says it in prose: the term has to appear in the visible
        body outside the <h1> itself (meta tags and JSON-LD do not count).
        """
        heading = self._h1()
        terms = matching_terms(heading, CATEGORY_TERMS)
        self.assertTrue(
            terms,
            "cannot check H1 substantiation: the <h1> names no category term "
            "from %r, so the H1 category criterion is failing separately; "
            "got: %r" % (CATEGORY_TERMS, heading),
        )
        body = visible_body_text(read_text(INDEX_HTML), drop_h1=True)
        self.assertIsNotNone(
            body,
            "website/index.html has no <body> element, so the visible body "
            "copy cannot be checked",
        )
        unbacked = [term for term in terms if not contains_term(body, term)]
        self.assertEqual(
            unbacked,
            [],
            "the <h1> claims category term(s) %r that appear nowhere in the "
            "visible body copy outside the <h1>; the heading term reads as "
            "planted for search engines rather than describing the product, "
            "and the page needs prose that actually uses it" % (unbacked,),
        )

    def test_h1_remains_readable_copy(self):
        heading = self._h1()
        words = heading.split()
        self.assertGreaterEqual(
            len(words),
            3,
            "the <h1> must remain real, readable copy rather than a bare "
            "keyword string; got: %r" % (heading,),
        )
        self.assertGreaterEqual(
            len(heading),
            12,
            "the <h1> is too short to read as a heading; got: %r" % (heading,),
        )
        self.assertNotIn(
            "<",
            heading,
            "the <h1> still contains markup after tag stripping: %r" % (heading,),
        )


if __name__ == "__main__":
    unittest.main()
