"""
COZA Fashion — fashion-press.net scraper (runway collections & seasonal trends).

This module powers the *separate* "COZA Fashion" section of the app. It ONLY
collects corporate / editorial fashion data — women's runway collections with
brand, season and title — never user-generated or personal content.

Source: https://www.fashion-press.net (Japanese). Titles are translated JA -> TR
at scrape time via deep-translator (free Google endpoint). Runs weekly (Mondays).
"""
import re
import time
import logging

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger("coza.fashion_scraper")

BASE = "https://www.fashion-press.net"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"
    ),
    "Accept-Language": "ja,en;q=0.8",
}

# Women's runway collections feed (clean, corporate, on-topic for Zara Woman).
COLLECTIONS_PATH = "/collections/search/womens"


def _normalize_season(title: str) -> str:
    """Extract & normalize a season code (e.g. 2026-27AW, 2027SS) from a title."""
    # Already-normalized latin season codes: 2026-27AW / 2027SS / 2026AW ...
    m = re.search(r"(\d{4}(?:-\d{2})?)\s*(AW|SS)", title, re.IGNORECASE)
    if m:
        return f"{m.group(1)}{m.group(2).upper()}"
    # Japanese season words: 年秋冬 (autumn/winter -> AW), 年春夏 (spring/summer -> SS)
    m = re.search(r"(\d{4}(?:-\d{2})?)\s*年?\s*秋冬", title)
    if m:
        return f"{m.group(1)}AW"
    m = re.search(r"(\d{4}(?:-\d{2})?)\s*年?\s*春夏", title)
    if m:
        return f"{m.group(1)}SS"
    # Bare 秋冬 / 春夏 with a leading year captured elsewhere
    m = re.search(r"(\d{4}(?:-\d{2})?)", title)
    if m and "秋冬" in title:
        return f"{m.group(1)}AW"
    if m and "春夏" in title:
        return f"{m.group(1)}SS"
    return ""


def _season_label_tr(season: str) -> str:
    """Human-friendly Turkish label for a season code (e.g. '2027 İlkbahar/Yaz')."""
    if not season:
        return ""
    m = re.match(r"(\d{4}(?:-\d{2})?)(AW|SS)", season)
    if not m:
        return season
    year, tag = m.group(1), m.group(2)
    return f"{year} {'Sonbahar/Kış' if tag == 'AW' else 'İlkbahar/Yaz'}"


def _fetch(path: str) -> str:
    url = BASE + path
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.text


def _translate_batch(texts, source="ja", target="tr"):
    """Translate a list of strings JA->TR. Falls back to original on any error."""
    try:
        from deep_translator import GoogleTranslator
    except Exception as exc:  # pragma: no cover - dependency guard
        logger.warning("deep-translator unavailable (%s); keeping original text", exc)
        return list(texts)

    out = []
    translator = GoogleTranslator(source=source, target=target)
    for t in texts:
        if not t:
            out.append(t)
            continue
        result = None
        # Retry a few times — the free endpoint occasionally rate-limits and
        # returns the original (untranslated) string.
        for attempt in range(3):
            try:
                cand = translator.translate(t)
            except Exception as exc:
                logger.warning("translate attempt %d failed for %r: %s", attempt + 1, t, exc)
                cand = None
            # Reject a result that is still (mostly) Japanese.
            if cand and not _looks_japanese(cand):
                result = cand
                break
            time.sleep(0.6 * (attempt + 1))
        out.append(result or t)
        time.sleep(0.15)  # be polite to the free endpoint
    return out


_JP_RE = re.compile(r"[\u3040-\u30ff\u4e00-\u9faf]")


def _looks_japanese(text: str) -> bool:
    """True if the string still contains Japanese kana/kanji."""
    return bool(_JP_RE.search(text))


def scrape_collections(limit: int = 40):
    """Scrape women's runway collections. Returns a list of dicts.

    Each item: {source_id, url, image, title_ja, title_tr, brand_tr, season, season_label}
    """
    html = _fetch(COLLECTIONS_PATH)
    soup = BeautifulSoup(html, "html.parser")

    href_re = re.compile(r"^/collections/\d+$")
    seen = set()
    raw = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        title = a.get("title")
        if not href_re.match(href) or not title:
            continue
        if href in seen:
            continue
        seen.add(href)
        img = a.find("img")
        src = None
        if img:
            # Many thumbnails are lazy-loaded (class "lozad") via data-src.
            src = img.get("src") or img.get("data-src")
            if src and src.startswith("/img") and "w300" not in src:
                src = src.replace("/top.jpg", "/w300_top.jpg")
        if src and src.startswith("/"):
            src = BASE + src
        raw.append(
            {
                "source_id": href.rsplit("/", 1)[-1],
                "url": BASE + href,
                "image": src,
                "title_ja": title.strip(),
            }
        )
        if len(raw) >= limit:
            break

    # Translate titles JA -> TR in one pass.
    titles_tr = _translate_batch([r["title_ja"] for r in raw])

    items = []
    for r, title_tr in zip(raw, titles_tr):
        season = _normalize_season(r["title_ja"])
        # Brand = title with the season/collection words stripped.
        brand_tr = title_tr
        for token in ["Koleksiyonu", "Koleksiyon", "Kadın & Erkek", "Kadın", "Erkek"]:
            brand_tr = brand_tr.replace(token, "")
        brand_tr = re.sub(r"\d{4}(?:-\d{2})?\s*(AW|SS)?", "", brand_tr, flags=re.IGNORECASE)
        brand_tr = re.sub(r"(Sonbahar/Kış|İlkbahar/Yaz|Resort|Rezort)", "", brand_tr)
        # Fallback: strip leftover Japanese collection words if translation failed.
        for jp in ["コレクション", "ウィメンズ&メンズ", "ウィメンズ", "メンズ", "年秋冬", "年春夏", "秋冬", "春夏", "年"]:
            brand_tr = brand_tr.replace(jp, "")
        brand_tr = re.sub(r"\s{2,}", " ", brand_tr).strip(" -–—&・").strip()
        items.append(
            {
                "source_id": r["source_id"],
                "url": r["url"],
                "image": r["image"],
                "title_ja": r["title_ja"],
                "title_tr": title_tr,
                "brand_tr": brand_tr,
                "season": season,
                "season_label": _season_label_tr(season),
            }
        )
    logger.info("fashion: scraped %d collections", len(items))
    return items


def fetch_collection_images(source_id: str):
    """Fetch the FULL runway gallery (all photos) for one collection's detail page.

    Each real photo on the detail page appears inside a "mount_gallery" link
    with a plain (un-prefixed) /img/news/<id>/<name>.jpg src — the smaller
    preview variants are always prefixed with w<digits>_, so excluding those
    keeps only the full-resolution originals. The number of photos varies
    per collection (no fixed count).
    """
    html = _fetch(f"/collections/{source_id}")
    pattern = re.compile(r'src="(/img/news/\d+/(?!w\d+_)[^"]+\.jpg)"')
    seen = set()
    images = []
    for m in pattern.finditer(html):
        path = m.group(1)
        if path in seen:
            continue
        seen.add(path)
        images.append(BASE + path)
    return images


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    data = scrape_collections(limit=8)
    import json

    print(json.dumps(data, ensure_ascii=False, indent=2))
