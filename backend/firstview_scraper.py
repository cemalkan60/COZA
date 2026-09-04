"""
COZA Fashion — firstview.com scraper (large runway photo archive since 1995).

Structure (confirmed by manual inspection, 2026-09):
  - Listing: /collection_results.php?s_g={Women|Men}&b=date&clear=1
    optionally &s_n=2 to filter to Haute Couture (1=Ready-to-Wear, 3=Swim).
  - Each result links to /collection_images.php?id={collection_id}, a photo
    grid for one brand's one season/show.
  - Photo files: /files/{collection_id}/{image_id}-{hash}.jpg — grid
    thumbnails are sometimes watermarked ("THE ATELIER"); the same image is
    clean on its closeup page (collection_image_closeup.php?...), but we
    don't crawl every closeup individually here (too many requests per
    collection) — grid images are used as-is, watermark or not, same as any
    other best-effort source.
  - Viewing is free; FirstView requires contacting them for hi-res/licensed
    use, which doesn't apply to this personal-use aggregation.
  - The listing also takes `&filter_year={YYYY}` (the year a show actually
    took place, confirmed against the site's own "Year:" filter) and
    `&page={N}` for pagination (~20 results/page) — used by scrape_category's
    `year`/`max_pages` args for a full historical pull; the regular scrape
    doesn't set them and keeps fetching just page 1 of the unfiltered
    "newest first" listing.
"""
import re
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger("coza.firstview_scraper")

BASE = "https://www.firstview.com"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

# Our category -> (gender query value, haute-couture filter value or None).
CATEGORY_TO_QUERY = {
    "women": ("Women", None),
    "men": ("Men", None),
    "haute-couture": ("Women", 2),
}

_COLLECTION_HREF_RE = re.compile(r"collection_images\.php\?id=(\d+)")


def _fetch(path_or_url: str, timeout: int = 30) -> str:
    url = path_or_url if path_or_url.startswith("http") else BASE + path_or_url
    resp = requests.get(url, headers=HEADERS, timeout=timeout)
    resp.raise_for_status()
    return resp.text


def _extract_collection_ids(html: str, limit: int) -> list:
    seen = set()
    ids = []
    for m in _COLLECTION_HREF_RE.finditer(html):
        cid = m.group(1)
        if cid in seen:
            continue
        seen.add(cid)
        ids.append(cid)
        if len(ids) >= limit:
            break
    return ids


# The site's own titles space the slash out ("Fall / Winter 2026", "Spring /
# Summer 2027" — confirmed by browsing the live listing), which the original
# `Fall/Winter` (no spaces) pattern never matched — every firstview item was
# silently coming back with an empty `season`, all along. `\s*/\s*` covers
# both spaced and unspaced forms.
_SEASON_RE = re.compile(r"\b(Spring\s*/\s*Summer|Fall\s*/\s*Winter|Resort|Pre-?[Ff]all)\s*((?:19|20)\d{2})\b")


def _parse_title(title: str) -> dict:
    """firstview page titles read like 'Brand - Fall / Winter 2026 - Women'."""
    parts = [p.strip() for p in title.split("-") if p.strip()]
    brand = parts[0] if parts else None
    season = None
    m = _SEASON_RE.search(title)
    if m:
        kind, year = m.group(1).lower(), m.group(2)
        if "fall" in kind or "winter" in kind:
            season = f"{year}AW"
        elif "spring" in kind or "summer" in kind:
            season = f"{year}SS"
        elif "resort" in kind:
            season = f"{year}RESORT"
        elif "pre" in kind:
            season = f"{year}PREFALL"
    return {"brand": brand, "season": season}


def _extract_images(html: str, collection_id: str, limit: int = 40) -> list:
    soup = BeautifulSoup(html, "html.parser")
    seen = set()
    images = []
    for img in soup.find_all("img"):
        src = img.get("src") or img.get("data-src") or ""
        if f"/files/{collection_id}/" not in src:
            continue
        if src.startswith("//"):
            src = "https:" + src
        elif src.startswith("/"):
            src = BASE + src
        if src in seen:
            continue
        seen.add(src)
        images.append(src)
        if len(images) >= limit:
            break
    return images


def _fetch_one_collection(cid: str, category: str) -> Optional[dict]:
    """Fetch and parse a single collection's gallery page. Returns None on
    any failure or an empty gallery — best-effort, same as before.
    """
    url = f"{BASE}/collection_images.php?id={cid}"
    try:
        html = _fetch(url)
    except Exception as exc:  # noqa: BLE001
        logger.warning("firstview: collection fetch failed %s: %s", url, exc)
        return None
    images = _extract_images(html, cid)
    if not images:
        return None
    soup = BeautifulSoup(html, "html.parser")
    title = (soup.title.string if soup.title and soup.title.string else "").strip()
    parsed = _parse_title(title)
    return {
        "source_id": f"firstview-{cid}",
        "url": url,
        "image": images[0],
        "images": images,
        "brand_tr": parsed["brand"] or f"FirstView #{cid}",
        "season": parsed["season"] or "",
        "city": None,  # not confirmed to be shown on the gallery page itself
        "category": category,
        "source": "firstview",
    }


def scrape_category(
    category: str, limit: int = 30, year: Optional[int] = None, max_pages: int = 1, workers: int = 1
) -> list:
    """Scrape firstview.com galleries for one of our categories
    ("women" | "men" | "haute-couture"). Best-effort per item.

    Without `year`, this is the original fast path: a single fetch of the
    unfiltered "newest first" listing, capped at `limit` — what the regular
    twice-weekly scrape uses to pick up new additions quickly.

    With `year` set, the listing is filtered to that calendar year (matching
    firstview's own "Year:" search filter — the year a show actually took
    place, not a season name) and walked page by page (`max_pages`, ~20
    items per page) to collect every id, up to `limit`. That's how a full
    historical pull for a given year (a backfill) is done. `workers` > 1
    fetches that year's individual collection galleries concurrently (a
    small thread pool, not one request at a time) — with hundreds of
    collections in a backfill, doing them one by one would take far too
    long.
    """
    gender, s_n = CATEGORY_TO_QUERY[category]
    base_query = f"/collection_results.php?s_g={gender}&b=date&clear=1"
    if s_n:
        base_query += f"&s_n={s_n}"
    if year:
        base_query += f"&filter_year={year}"

    collection_ids: list = []
    seen_ids = set()
    for page in range(1, max_pages + 1):
        page_query = base_query if page == 1 else f"{base_query}&page={page}"
        try:
            listing_html = _fetch(page_query)
        except Exception as exc:  # noqa: BLE001
            logger.error("firstview: listing fetch failed for %s page %d: %s", category, page, exc)
            break
        page_ids = _extract_collection_ids(listing_html, limit=limit - len(collection_ids))
        new_ids = [cid for cid in page_ids if cid not in seen_ids]
        if not new_ids:
            break  # past the last page — stop
        for cid in new_ids:
            seen_ids.add(cid)
            collection_ids.append(cid)
        if len(collection_ids) >= limit:
            break

    items: list = []
    if workers > 1 and len(collection_ids) > 1:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for result in pool.map(lambda cid: _fetch_one_collection(cid, category), collection_ids):
                if result:
                    items.append(result)
    else:
        for cid in collection_ids:
            result = _fetch_one_collection(cid, category)
            if result:
                items.append(result)

    logger.info(
        "firstview: scraped %d %s collections%s", len(items), category, f" (year {year}, {page} page(s))" if year else ""
    )
    return items
