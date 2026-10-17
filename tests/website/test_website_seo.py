#!/usr/bin/env python3
"""Acceptance tests for the neohive.alionix.com static site (zero deps).

Run from the repo root:
    python3 tests/website/test_website_seo.py
    python3 -m unittest discover -s tests/website

Locates the published site relative to this file (repo_root/website), never by
absolute path. No network access.
"""

import html
import json
import re
import unittest
import urllib.parse
from html.parser import HTMLParser
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WEBSITE = REPO_ROOT / "website"
LLMS_TXT = WEBSITE / "llms.txt"
ROBOTS_TXT = WEBSITE / "robots.txt"

SITE_ORIGIN = "https://neohive.alionix.com"
SITEMAP_URL = SITE_ORIGIN + "/sitemap.xml"
PRODUCT_NAME = "neoHive"
# Lower-case token(s) that count as naming the product in the llms.txt H1.
PRODUCT_TOKENS = ("neohive",)
INDEX_HTML = WEBSITE / "index.html"

AI_USER_AGENTS = (
    "GPTBot",
    "ClaudeBot",
    "PerplexityBot",
    "Google-Extended",
    "OAI-SearchBot",
)

CODE_HOSTS = (
    "github.com",
    "gitlab.com",
    "codeberg.org",
    "bitbucket.org",
    "raw.githubusercontent.com",
)
DOC_PATH_RE = re.compile(
    r"(?:^|/)(?:docs?|documentation|readme|repo|repository)(?:/|$|\.)", re.IGNORECASE
)
HTTPS_URL_RE = re.compile(r"https://[^\s<>()\[\]\"'`]+")

LD_JSON_RE = re.compile(
    r"<script\b[^>]*\btype\s*=\s*[\"']application/ld\+json[\"'][^>]*>(.*?)</script\s*>",
    re.IGNORECASE | re.DOTALL,
)


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def read_text(path):
    return path.read_text(encoding="utf-8")


def ld_json_blocks(page_text):
    return [m.group(1) for m in LD_JSON_RE.finditer(page_text)]


def parse_robots(text):
    """Return (groups, sitemaps).

    groups: list of {"agents": [lower-case tokens], "directives": [(field, value)]}
    sitemaps: list of raw Sitemap: values
    """
    groups = []
    sitemaps = []
    current = None
    in_rules = False

    for raw_line in text.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            current = None
            in_rules = False
            continue
        if ":" not in line:
            continue
        field, _, value = line.partition(":")
        field = field.strip().lower()
        value = value.strip()

        if field == "user-agent":
            if current is None or in_rules:
                current = {"agents": [], "directives": []}
                groups.append(current)
                in_rules = False
            current["agents"].append(value.lower())
        elif field in ("allow", "disallow"):
            if current is not None:
                current["directives"].append((field, value))
                in_rules = True
        elif field == "sitemap":
            sitemaps.append(value)

    return groups, sitemaps


def iter_nodes(obj):
    """Depth-first walk of every dict inside a JSON document."""
    stack = [obj]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            yield current
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)


def type_has(node, name):
    value = node.get("@type")
    if isinstance(value, str):
        return value == name
    if isinstance(value, list):
        return any(isinstance(v, str) and v == name for v in value)
    return False


_BLOCK_TAGS = frozenset(
    """
    address article aside blockquote br dd div dl dt fieldset figcaption figure
    footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table
    tbody td tfoot th thead tr ul
    """.split()
)


class _VisibleTextParser(HTMLParser):
    """Collects rendered text, skipping <script>/<style> and spacing blocks."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self._skipping = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skipping += 1
        elif tag in _BLOCK_TAGS:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            if self._skipping:
                self._skipping -= 1
        elif tag in _BLOCK_TAGS:
            self.parts.append(" ")

    def handle_data(self, data):
        if not self._skipping:
            self.parts.append(data)


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


def normalize_text(value):
    """Unescape entities, strip tags, unify unicode punctuation, collapse space."""
    value = re.sub(r"(?s)<[^>]+>", " ", value)
    value = html.unescape(value)
    value = value.replace("\u00a0", " ").translate(_QUOTE_MAP)
    return re.sub(r"\s+", " ", value).strip()


def visible_text(page_text):
    parser = _VisibleTextParser()
    parser.feed(page_text)
    parser.close()
    return normalize_text("".join(parser.parts))


def jsonld_objects(page_text):
    return [json.loads(block) for block in ld_json_blocks(page_text)]


def faq_questions(page_text):
    """All Question objects reachable from an FAQPage node in the page JSON-LD."""
    questions = []
    for document in jsonld_objects(page_text):
        for node in iter_nodes(document):
            if not type_has(node, "FAQPage"):
                continue
            main_entity = node.get("mainEntity")
            if isinstance(main_entity, dict):
                candidates = [main_entity]
            elif isinstance(main_entity, list):
                candidates = main_entity
            else:
                candidates = []
            for candidate in candidates:
                if isinstance(candidate, dict) and type_has(candidate, "Question"):
                    questions.append(candidate)
    return questions


def answer_text(question):
    """The plain text of a Question's acceptedAnswer if it is a valid Answer."""
    answer = question.get("acceptedAnswer")
    if isinstance(answer, list):
        answer = answer[0] if answer else None
    if not isinstance(answer, dict) or not type_has(answer, "Answer"):
        return None
    text = answer.get("text")
    if not isinstance(text, str) or not text.strip():
        return None
    return text


# --------------------------------------------------------------------------
# criteria 1-4: all sites
# --------------------------------------------------------------------------
class LlmsTxtTests(unittest.TestCase):
    def _text(self):
        self.assertTrue(
            LLMS_TXT.is_file(),
            "website/llms.txt is missing; it is published verbatim by the "
            "Worker's assets directory and must exist",
        )
        raw = LLMS_TXT.read_bytes()
        self.assertTrue(raw.strip(), "website/llms.txt is empty")
        return raw.decode("utf-8")  # raises on invalid UTF-8

    def test_llms_txt_is_non_empty_utf8(self):
        text = self._text()
        self.assertTrue(text.strip(), "website/llms.txt contains only whitespace")
        self.assertGreater(len(text.strip()), 0)

    def test_first_non_blank_line_is_h1_naming_product(self):
        text = self._text()
        first = next(
            (line.strip() for line in text.splitlines() if line.strip()), None
        )
        self.assertIsNotNone(first, "website/llms.txt has no non-blank line")
        self.assertTrue(
            first.startswith("# "),
            "first non-blank line must be a level-1 markdown heading, got: %r"
            % (first,),
        )
        heading = first[2:].strip()
        self.assertTrue(heading, "the level-1 heading is empty")
        lowered = heading.lower()
        self.assertTrue(
            any(token in lowered for token in PRODUCT_TOKENS),
            "level-1 heading %r must name the product (%s)"
            % (first, PRODUCT_NAME),
        )

    def test_llms_txt_links_to_repository_or_documentation(self):
        text = self._text()
        urls = HTTPS_URL_RE.findall(text)
        self.assertTrue(
            urls,
            "website/llms.txt must contain at least one absolute https:// URL",
        )

        def qualifies(url):
            parsed = urllib.parse.urlsplit(url)
            if parsed.scheme != "https" or not parsed.netloc:
                return False
            host = parsed.netloc.lower()
            if host in CODE_HOSTS:
                return True
            if host.startswith("docs.") or host.endswith(".readthedocs.io"):
                return True
            if DOC_PATH_RE.search(parsed.path):
                return True
            # A non-root path on any host is a documentation/deep link.
            return bool(parsed.path.strip("/"))

        self.assertTrue(
            any(qualifies(url) for url in urls),
            "no https:// URL in website/llms.txt points at a repository or "
            "documentation page; URLs found: %r" % (urls,),
        )


class RobotsTxtTests(unittest.TestCase):
    def _robots(self):
        self.assertTrue(ROBOTS_TXT.is_file(), "website/robots.txt is missing")
        return read_text(ROBOTS_TXT)

    def test_declares_named_group_for_each_ai_user_agent(self):
        groups, _ = parse_robots(self._robots())
        missing = []
        without_allow = []
        for agent in AI_USER_AGENTS:
            matches = [
                group
                for group in groups
                if agent.lower() in group["agents"]
            ]
            if not matches:
                missing.append(agent)
                continue
            directives = [
                (field, value)
                for group in matches
                for field, value in group["directives"]
            ]
            allows = [value for field, value in directives if field == "allow"]
            only_full_disallow = bool(directives) and all(
                field == "disallow" and value == "/" for field, value in directives
            )
            if not allows or only_full_disallow:
                without_allow.append(agent)
        self.assertEqual(
            missing,
            [],
            "robots.txt has no User-agent group for: %s" % ", ".join(missing),
        )
        self.assertEqual(
            without_allow,
            [],
            "these AI user-agent groups have no explicit Allow: directive: %s"
            % ", ".join(without_allow),
        )

    def test_keeps_wildcard_allow_and_own_sitemap(self):
        groups, sitemaps = parse_robots(self._robots())
        wildcard = [group for group in groups if "*" in group["agents"]]
        self.assertTrue(
            wildcard,
            "the pre-existing 'User-agent: *' group was removed from robots.txt",
        )
        self.assertTrue(
            any(
                field == "allow" and value == "/"
                for group in wildcard
                for field, value in group["directives"]
            ),
            "the pre-existing 'Allow: /' rule for 'User-agent: *' was removed",
        )
        self.assertIn(
            SITEMAP_URL,
            sitemaps,
            "robots.txt must keep a 'Sitemap: %s' line, found: %r"
            % (SITEMAP_URL, sitemaps),
        )


class JsonLdValidityTests(unittest.TestCase):
    def test_every_jsonld_block_parses(self):
        pages = sorted(WEBSITE.rglob("*.html"))
        self.assertTrue(pages, "no .html files found under website/")
        checked = 0
        for page in pages:
            blocks = ld_json_blocks(read_text(page))
            for index, block in enumerate(blocks):
                checked += 1
                try:
                    json.loads(block)
                except json.JSONDecodeError as exc:
                    self.fail(
                        "invalid application/ld+json block #%d in %s: %s"
                        % (index + 1, page.relative_to(REPO_ROOT), exc)
                    )
        self.assertGreater(
            checked, 0, "no <script type=\"application/ld+json\"> blocks found"
        )


# --------------------------------------------------------------------------
# criterion 5: brand casing is unified to neoHive
# --------------------------------------------------------------------------
class BrandCasingTests(unittest.TestCase):
    def test_no_occurrences_of_miscased_brand(self):
        page = read_text(INDEX_HTML)
        occurrences = page.count("Neohive")
        self.assertEqual(
            occurrences,
            0,
            "website/index.html still contains the miscased brand 'Neohive' "
            "%d time(s); the brand must be written 'neoHive'" % occurrences,
        )

    def test_brand_appears_in_canonical_casing(self):
        page = read_text(INDEX_HTML)
        self.assertTrue(
            "neoHive" in page,
            "website/index.html does not contain the brand in its canonical "
            "casing 'neoHive' at all",
        )


# --------------------------------------------------------------------------
# criteria 6-7: FAQPage JSON-LD and visible FAQ copy
# --------------------------------------------------------------------------
class FaqJsonLdTests(unittest.TestCase):
    def test_jsonld_contains_faqpage_with_three_answers(self):
        page = read_text(INDEX_HTML)
        questions = faq_questions(page)
        self.assertGreaterEqual(
            len(questions),
            3,
            "website/index.html JSON-LD has no FAQPage with at least 3 "
            "Question entries in mainEntity (found %d)" % len(questions),
        )

        answers = []
        for question in questions:
            text = answer_text(question)
            self.assertIsNotNone(
                text,
                "a FAQPage Question is missing a valid acceptedAnswer of "
                "@type Answer with non-empty text: %r" % (question,),
            )
            answers.append(text)
        self.assertGreaterEqual(
            len(answers),
            3,
            "FAQPage must expose at least 3 usable Answer texts, found %d"
            % len(answers),
        )


class FaqVisibleCopyTests(unittest.TestCase):
    def test_every_faq_answer_exists_in_visible_copy(self):
        page = read_text(INDEX_HTML)
        questions = faq_questions(page)
        self.assertGreaterEqual(
            len(questions),
            3,
            "cannot verify visible FAQ copy: JSON-LD has no FAQPage with at "
            "least 3 Questions",
        )
        body = visible_text(page)
        self.assertTrue(body, "website/index.html has no visible text")

        for question in questions:
            text = answer_text(question)
            self.assertIsNotNone(
                text,
                "a FAQPage Question has no usable acceptedAnswer text: %r"
                % (question,),
            )
            normalized = normalize_text(text)
            self.assertTrue(
                normalized in body,
                "FAQ answer text is present in JSON-LD only, not in the "
                "page's visible copy: %r" % (normalized[:160],),
            )


if __name__ == "__main__":
    unittest.main()
