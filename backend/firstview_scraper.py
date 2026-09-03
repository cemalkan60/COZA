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
"""
import re
import logging

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


_SEASON_RE = re.compile(r"\b(Spring/Summer|Fall/Winter|Resort|Pre-?[Ff]all)\s*((?:19|20)\d{2})\b")


def _parse_title(title: str) -> dict:
    """firstview page titles read like 'Brand - Ready-to-Wear - Fall 2026 - Women'."""
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


def scrape_category(category: str, limit: int = 30) -> list:
    """Scrape firstview.com galleries for one of our categories
    ("women" | "men" | "haute-couture"). Best-effort per item.
    """
    gender, s_n = CATEGORY_TO_QUERY[category]
    query = f"/collection_results.php?s_g={gender}&b=date&clear=1"
    if s_n:
        query += f"&s_n={s_n}"
    try:
        listing_html = _fetch(query)
    except Exception as exc:  # noqa: BLE001
        logger.error("firstview: listing fetch failed for %s: %s", category, exc)
        return []

    collection_ids = _extract_collection_ids(listing_html, limit)
    items = []
    for cid in collection_ids:
        url = f"{BASE}/collection_images.php?id={cid}"
        try:
            html = _fetch(url)
        except Exception as exc:  # noqa: BLE001
            logger.warning("firstview: collection fetch failed %s: %s", url, exc)
            continue
        images = _extract_images(html, cid)
        if not images:
            continue
        soup = BeautifulSoup(html, "html.parser")
        title = (soup.title.string if soup.title and soup.title.string else "").strip()
        parsed = _parse_title(title)
        items.append(
            {
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
        )
    logger.info("firstview: scraped %d %s collections", len(items), category)
    return items
