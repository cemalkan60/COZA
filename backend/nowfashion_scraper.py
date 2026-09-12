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
import time
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

KNOWN_CITIES = ["new-york", "paris", "milan", "london", "gran-canaria"]

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
        # A plain (non-rendered) proxy request still 500s here -- the block is
        # a JS challenge, not just an IP/UA check, so it needs ScraperAPI to
        # actually run a browser (render=true). Costs ~10x a normal request;
        # accepted since this scraper only runs twice a week (see its call
        # site in server.py).
        #
        # render=true alone can return /fashion-week-schedules (a client-
        # rendered/Next.js page) before its own client-side data fetch has
        # populated the schedule cards -- confirmed live, an empty DOM.
        # Both of ScraperAPI's own "wait longer" mechanisms misbehaved on
        # this account rather than helping: wait_for_selector (the simple
        # ?wait_for_selector=... param) got a flat 403 from ScraperAPI
        # itself, with or without a comma in the value; the Render
        # Instruction Set's time-based wait (sent via the
        # x-sapi-instruction_set header) got a slow ~55s 500 instead. Both
        # abandoned -- see scrape_schedule_dates's own retry loop, which
        # just calls this plain path a few times instead.
        resp = requests.get(
            SCRAPER_PROXY_BASE,
            params={"api_key": SCRAPER_API_KEY, "url": url, "render": "true"},
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


def _scrape_from_listing(listing_html: str, limit: int, default_category: str) -> list:
    """Shared by scrape_category and scrape_schedules: given a listing
    page's HTML, pull out gallery links and fetch/parse each one.
    Best-effort per item — a gallery page that fails to fetch/parse is
    skipped, not fatal to the whole run."""
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
                "category": parsed["category"] or default_category,
                "source": "nowfashion",
            }
        )
    return items


def scrape_category(category: str, limit: int = 30) -> list:
    """Scrape nowfashion.com galleries for one of our categories
    ("women" | "men" | "haute-couture"), via its per-category /search
    listing."""
    param = CATEGORY_TO_PARAM[category]
    try:
        listing_html = _fetch(f"/search?collection={param}")
    except Exception as exc:  # noqa: BLE001
        logger.error("nowfashion: listing fetch failed for %s: %s", category, exc)
        return []
    items = _scrape_from_listing(listing_html, limit, category)
    logger.info("nowfashion: scraped %d %s galleries", len(items), category)
    return items


#  ------------------ Fashion week CALENDAR (dates only, no photos) ------
#
# Cem specifically asked for just this — city/season/date-range/collection
# count from /fashion-week-schedules, WITHOUT following every show's own
# gallery page and pulling its photos (that's scrape_category above, still
# there but not wired into the regular scrape). This is the actual
# forward-looking calendar the app never had a data source for (see the
# note on GET /fashion/fashion-weeks in server.py) — nowfashion is the only
# source that publishes real show dates at all, retrospective or upcoming.
_SCHEDULE_HREF_RE = re.compile(r"^/fashion-week/([a-z0-9-]+)/?$")
_COLLECTIONS_COUNT_RE = re.compile(r"([\d.,]+)\s+collections?", re.IGNORECASE)
_STARTS_IN_RE = re.compile(r"Starts in\s+(\d+)\s+days?", re.IGNORECASE)

# Type comes right after the city in the slug (e.g.
# "paris-ready-to-wear-spring-summer-2027") — same 3 values as
# CATEGORY_TO_PARAM's, just spelled out with hyphens in the URL.
_SCHEDULE_TYPE_MARKERS = [("ready-to-wear", "women"), ("menswear", "men"), ("couture", "haute-couture")]


def _parse_schedule_slug(slug: str) -> "Optional[dict]":
    """'paris-ready-to-wear-spring-summer-2027' -> city/category/season.
    Unlike _parse_slug (brand galleries), the city comes FIRST here and
    there's no brand name to strip."""
    rest = slug
    city = None
    for c in sorted(KNOWN_CITIES, key=len, reverse=True):
        if rest.startswith(c + "-"):
            city = c.replace("-", " ").title()
            rest = rest[len(c) + 1:]
            break
    if not city:
        return None
    category = None
    for marker, cat in _SCHEDULE_TYPE_MARKERS:
        if rest.startswith(marker + "-"):
            category = cat
            rest = rest[len(marker) + 1:]
            break
    year_m = re.search(r"(19|20)\d{2}$", rest)
    if not year_m:
        return None
    year = year_m.group(0)
    season_part = rest[: year_m.start()].rstrip("-")
    if "fall-winter" in season_part or "autumn-winter" in season_part:
        season = f"{year}AW"
    elif "spring-summer" in season_part:
        season = f"{year}SS"
    elif "resort" in season_part or "cruise" in season_part:
        season = f"{year}RESORT"
    elif "pre-fall" in season_part:
        season = f"{year}PREFALL"
    else:
        return None
    return {"city": city, "category": category, "season": season}


def _collections_count(el) -> "Optional[int]":
    if not el:
        return None
    m = _COLLECTIONS_COUNT_RE.search(el.get_text(" ", strip=True))
    return int(m.group(1).replace(",", "").replace(".", "")) if m else None


def _add_schedule_entry(items: list, seen: set, a_tag, *, happening_now: bool, dates_sel: str, stats_sel: str, countdown_sel: "Optional[str]" = None) -> None:
    href = a_tag.get("href") or ""
    m = _SCHEDULE_HREF_RE.match(href)
    if not m:
        return
    slug = m.group(1)
    if slug in seen:
        return
    seen.add(slug)
    parsed = _parse_schedule_slug(slug)
    if not parsed:
        return
    dates_el = a_tag.select_one(dates_sel)
    starts_m = _STARTS_IN_RE.search(a_tag.select_one(countdown_sel).get_text(" ", strip=True)) if countdown_sel and a_tag.select_one(countdown_sel) else None
    items.append({
        "source_id": f"nowfashion-week-{slug}",
        "city": parsed["city"],
        "category": parsed["category"],
        "season": parsed["season"],
        "date_range": dates_el.get_text(" ", strip=True) if dates_el else None,
        "collections_count": _collections_count(a_tag.select_one(stats_sel)),
        "happening_now": happening_now,
        "starts_in_days": int(starts_m.group(1)) if starts_m else None,
        "url": f"{BASE}{href}",
    })


def scrape_schedule_dates() -> list:
    """The fashion-week CALENDAR only — no gallery pages fetched, no
    photos. Confirmed live (2026-09, via a real browser DOM inspection —
    plain requests only gets an empty client-rendered shell, which is why
    this goes through _fetch's render=true path) markup:
      - the single "happening now" card: a.schedule-card-now, with
        h3.schedule-card-city / p.schedule-card-type (combined "Ready To
        Wear · Spring Summer") / p.schedule-card-dates / p.schedule-card-stats
      - each "coming up" row: a.schedule-upcoming-card, with
        span.schedule-upcoming-city / -type / -season (type and season
        split into two spans here, unlike the now-card) /
        -dates / -shows / -countdown ("Starts in N days")
    City/category/season come from the URL slug instead of that visible
    text (_parse_schedule_slug) since the season's YEAR in the slug is the
    fashion-industry one (e.g. "spring-summer-2027"), which is routinely a
    full year AHEAD of the calendar year the show actually happens in (the
    visible date text) — parsing the season year from the date instead
    would silently mislabel it.
    Only "happening now" + "coming up" are scraped — "past seasons" needs
    a "Load older seasons" click to paginate further and use a different,
    unconfirmed markup; skipped for now (Cem mainly wants current/upcoming
    anyway)."""
    # Both of ScraperAPI's own "wait longer" mechanisms misbehaved on this
    # account: wait_for_selector got a flat 403 (twice, with a fresh working
    # key too -- so genuinely rejected, not a credits issue), and the
    # instruction-set time-based wait got a slow 500 after ~55s. Falling
    # back to the simplest thing confirmed to actually work (plain
    # render=true, no extra params) and just retrying THAT a few times with
    # a short pause -- a fresh render attempt each time gets its own shot at
    # nowfashion's client-side data fetch finishing in time.
    html = None
    last_exc: "Optional[Exception]" = None
    for attempt in range(3):
        try:
            html = _fetch("/fashion-week-schedules")
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            html = None
        else:
            if "schedule-upcoming-card" in html:
                break
            last_exc = None
        if attempt < 2:
            time.sleep(5)
    if html is None:
        logger.error("nowfashion: schedule-dates fetch failed after retries: %s", last_exc)
        return []
    if "schedule-upcoming-card" not in html:
        # Diagnostic: still didn't find the expected content after 3 tries
        # -- log what we actually got instead of guessing again.
        logger.error(
            "nowfashion: schedule-dates fetched %d chars after retries, still no "
            "'schedule-upcoming-card'; has 'Just a moment'=%s has 'cf-browser-verification'=%s; head=%r",
            len(html), "Just a moment" in html, "cf-browser-verification" in html, html[:400],
        )
    soup = BeautifulSoup(html, "html.parser")
    seen: set = set()
    items: list = []

    now_card = soup.select_one("a.schedule-card-now")
    if now_card:
        _add_schedule_entry(items, seen, now_card, happening_now=True, dates_sel="p.schedule-card-dates", stats_sel="p.schedule-card-stats")

    for card in soup.select("a.schedule-upcoming-card"):
        _add_schedule_entry(
            items, seen, card, happening_now=False,
            dates_sel="span.schedule-upcoming-dates", stats_sel="span.schedule-upcoming-shows",
            countdown_sel="span.schedule-upcoming-countdown",
        )

    logger.info("nowfashion: parsed %d fashion week schedule entries", len(items))
    return items
