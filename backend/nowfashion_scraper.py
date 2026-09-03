"""
COZA Fashion — nowfashion.com scraper (independent runway photo agency).

Structure (confirmed by manual inspection, 2026-09):
  - Category listing: https://nowfashion.com/search?collection={couture|menswear|ready-to-wear}
  - Gallery page slug pattern: /{brand-slug}-{category}-{season}-{year}-{city}
    e.g. /rvdk-ronald-van-der-kemp-couture-fall-winter-2026-paris
  - Gallery pages show BRANDS / LOCATION / SEASON text blocks and a photo
    grid; some photos are paywalled beyond a free preview.

No JSON/API endpoint is exposed, so this scrapes the rendered HTML. The slug
itself is the most reliable source for brand/category/season/city (it's a
fixed, confirmed pattern) — page text is only used as a fallback.
"""
import os
import re
import logging

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger("coza.nowfashion_scraper")

BASE = "https://nowfashion.com"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

# nowfashion.com returns a flat 403 on direct requests (bot protection) — fall
# back to the same ScraperAPI proxy the Zara scraper already uses when that
# happens. Read directly from the env var rather than importing scraper.py,
# to keep this module independently importable/testable.
SCRAPER_API_KEY = os.environ.get("SCRAPER_API_KEY", "")
SCRAPER_PROXY_BASE = "http://api.scraperapi.com/"

# Our category -> the site's own `collection` filter value.
CATEGORY_TO_PARAM = {"women": "ready-to-wear", "men": "menswear", "haute-couture": "couture"}
# The site's slug segment for each category, longest-first so "ready-to-wear"
# (which contains no other category's name) is tried before shorter ones.
_SLUG_CATEGORY_MARKERS = [("ready-to-wear", "women"), ("menswear", "men"), ("couture", "haute-couture")]

KNOWN_CITIES = ["new-york", "paris", "milan", "london"]

_NON_GALLERY_SLUGS = {
    "search", "fashion-week", "about", "about-us", "contact", "login", "register",
    "privacy", "terms", "subscribe", "our-services", "services",
}
_GALLERY_HREF_RE = re.compile(r"^/([a-z0-9][a-z0-9-]{10,})/?$")


def _fetch(path_or_url: str, timeout: int = 30) -> str:
    url = path_or_url if path_or_url.startswith("http") else BASE + path_or_url
    try:
        resp = requests.get(url, headers=HEADERS, timeout=timeout)
        resp.raise_for_status()
        return resp.text
    except requests.exceptions.HTTPError as exc:
        blocked = exc.response is not None and exc.response.status_code in (403, 429)
        if not (blocked and SCRAPER_API_KEY):
            raise
        resp = requests.get(
            SCRAPER_PROXY_BASE,
            params={"api_key": SCRAPER_API_KEY, "url": url},
            timeout=max(timeout, 60),
        )
        resp.raise_for_status()
        return resp.text


def _extract_gallery_links(html: str, limit: int) -> list:
    soup = BeautifulSoup(html, "html.parser")
    seen = set()
    links = []
    for a in soup.find_all("a", href=True):
        m = _GALLERY_HREF_RE.match(a["href"])
        if not m:
            continue
        slug = m.group(1)
        if slug in _NON_GALLERY_SLUGS or slug in seen:
            continue
        seen.add(slug)
        links.append(slug)
        if len(links) >= limit:
            break
    return links


def _parse_slug(slug: str) -> dict:
    """Best-effort split of a confirmed {brand}-{category}-{season}-{year}-{city} slug."""
    category = None
    brand_part, rest = slug, ""
    for marker, cat in _SLUG_CATEGORY_MARKERS:
        idx = slug.find(f"-{marker}-")
        if idx != -1:
            category = cat
            brand_part = slug[:idx]
            rest = slug[idx + len(marker) + 2:]
            break

    city = None
    for c in KNOWN_CITIES:
        if rest.endswith(c):
            city = c.replace("-", " ").title()
            rest = rest[: -len(c)].rstrip("-")
            break

    season = None
    year_m = re.search(r"(19|20)\d{2}", rest)
    if year_m:
        year = year_m.group(0)
        if "fall-winter" in rest or "autumn-winter" in rest:
            season = f"{year}AW"
        elif "spring-summer" in rest:
            season = f"{year}SS"
        elif "resort" in rest or "cruise" in rest:
            season = f"{year}RESORT"
        elif "pre-fall" in rest:
            season = f"{year}PREFALL"

    brand = brand_part.replace("-", " ").strip().title() if brand_part else None
    return {"brand": brand, "category": category, "season": season, "city": city}


def _extract_images(html: str, limit: int = 40) -> list:
    soup = BeautifulSoup(html, "html.parser")
    seen = set()
    images = []
    for img in soup.find_all("img"):
        src = img.get("src") or img.get("data-src")
        if not src:
            continue
        if src.startswith("//"):
            src = "https:" + src
        elif src.startswith("/"):
            src = BASE + src
        if not src.startswith("http") or src in seen:
            continue
        # Skip obvious non-photo assets (icons/logos/svg).
        low = src.lower()
        if low.endswith(".svg") or "logo" in low or "icon" in low or "avatar" in low:
            continue
        seen.add(src)
        images.append(src)
        if len(images) >= limit:
            break
    return images


def scrape_category(category: str, limit: int = 30) -> list:
    """Scrape nowfashion.com galleries for one of our categories
    ("women" | "men" | "haute-couture"). Best-effort per item — a gallery
    page that fails to fetch/parse is skipped, not fatal to the whole run.
    """
    param = CATEGORY_TO_PARAM[category]
    try:
        listing_html = _fetch(f"/search?collection={param}")
    except Exception as exc:  # noqa: BLE001
        logger.error("nowfashion: listing fetch failed for %s: %s", category, exc)
        return []

    slugs = _extract_gallery_links(listing_html, limit)
    items = []
    for slug in slugs:
        parsed = _parse_slug(slug)
        url = f"{BASE}/{slug}"
        try:
            html = _fetch(url)
        except Exception as exc:  # noqa: BLE001
            logger.warning("nowfashion: gallery fetch failed %s: %s", url, exc)
            continue
        images = _extract_images(html)
        if not images:
            continue
        items.append(
            {
                "source_id": f"nowfashion-{slug}",
                "url": url,
                "image": images[0],
                "images": images,
                "brand_tr": parsed["brand"] or slug.replace("-", " ").title(),
                "season": parsed["season"] or "",
                "city": parsed["city"],
                "category": parsed["category"] or category,
                "source": "nowfashion",
            }
        )
    logger.info("nowfashion: scraped %d %s galleries", len(items), category)
    return items
