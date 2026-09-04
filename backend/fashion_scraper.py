"""
COZA Fashion — fashion-press.net scraper (runway collections & seasonal trends).

This module powers the *separate* "COZA Fashion" section of the app. It ONLY
collects corporate / editorial fashion data — women's runway collections with
brand, season and title — never user-generated or personal content.

Source: https://www.fashion-press.net (Japanese). Titles are translated JA -> TR
at scrape time via deep-translator (free Google endpoint). Runs Mondays and
Wednesdays (see the scheduled job in server.py).
"""
import re
import time
import logging
from typing import Optional

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

# Runway collections feeds, by gender path segment. No dedicated haute-couture
# search path exists on this site — those are reached via the brand index
# instead (see HAUTE_COUTURE_BRANDS_PATH below).
COLLECTIONS_PATH_BY_GENDER = {
    "women": "/collections/search/womens",
    "men": "/collections/search/mens",
}

# Index of haute-couture houses; each brand's own profile page lists that
# house's collections directly (same <a href="/collections/{id}" title="...">
# markup as the gender search pages), so it's crawled to find their couture
# collections specifically (a house's profile can still mix in ready-to-wear
# seasons, so results are filtered by the couture marker in the title — see
# scrape_haute_couture()).
HAUTE_COUTURE_BRANDS_PATH = "/brands/all/haute"
BRAND_PROFILE_PATH = "/brands/{brand_id}"
HAUTE_COUTURE_MARKER = "オートクチュール"  # "haute couture" in Japanese

# Coordinate search ("kombin arama") — single runway photos tagged by item,
# color, material and pattern. Query params match the site's own filter form
# (gender/season/item/color/material/pattern) so we can proxy filtered
# searches straight through instead of re-deriving tags ourselves.
LOOKS_PATH = "/collections/looks"


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


def _parse_collection_links(html: str, limit: int) -> list:
    """Extract {source_id, url, image, title_ja} from any page that lists
    collections via <a href="/collections/{id}" title="..."> — the same markup
    shape is used on the gender search pages and on a brand's own archive page.
    """
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
    return raw


def _brand_tr_from_title(title_tr: str) -> str:
    brand_tr = title_tr
    for token in ["Koleksiyonu", "Koleksiyon", "Kadın & Erkek", "Kadın", "Erkek", "Haute couture", "Haute Couture"]:
        brand_tr = brand_tr.replace(token, "")
    brand_tr = re.sub(r"\d{4}(?:-\d{2})?\s*(AW|SS)?", "", brand_tr, flags=re.IGNORECASE)
    brand_tr = re.sub(r"(Sonbahar/Kış|İlkbahar/Yaz|Resort|Rezort)", "", brand_tr)
    # Fallback: strip leftover Japanese collection words if translation failed.
    for jp in ["コレクション", "ウィメンズ&メンズ", "ウィメンズ", "メンズ", "オートクチュール", "年秋冬", "年春夏", "秋冬", "春夏", "年"]:
        brand_tr = brand_tr.replace(jp, "")
    return re.sub(r"\s{2,}", " ", brand_tr).strip(" -–—&・").strip()


def _finish_items(raw: list, category: str) -> list:
    """Translate titles JA->TR and shape raw link dicts into full fashion items.

    NOTE: only the listing-page thumbnail is captured here — an earlier
    version of this function also fetched each collection's full gallery
    inline (one extra page fetch + N image downloads per item), which made a
    ~80-collection scrape take so long the app sat empty for over an hour
    (compounded by the legacy-doc purge in server.py wiping the old data
    first). Reverted: the full gallery is still fetched and R2-cached, just
    lazily on first view via GET /fashion/collections/{source_id} (see
    fetch_collection_images() below and its caller in server.py).
    """
    titles_tr = _translate_batch([r["title_ja"] for r in raw])
    items = []
    for r, title_tr in zip(raw, titles_tr):
        season = _normalize_season(r["title_ja"])
        items.append(
            {
                "source_id": r["source_id"],
                "url": r["url"],
                "image": r["image"],
                "title_ja": r["title_ja"],
                "title_tr": title_tr,
                "brand_tr": _brand_tr_from_title(title_tr),
                "season": season,
                "season_label": _season_label_tr(season),
                "category": category,
                "city": None,  # not exposed anywhere on this site
                "source": "fashion-press",
            }
        )
    return items


def scrape_collections(limit: int = 40, gender: str = "women", season: Optional[str] = None):
    """Scrape runway collections for one gender ("women" or "men").

    Without `season`, this is the original fast path: a single fetch of the
    unfiltered listing (sorted newest-first across whatever seasons are
    currently active), capped at `limit` — what the regular twice-weekly
    scrape uses to pick up new additions quickly.

    With `season` set to one of fashion-press.net's own season slugs (e.g.
    "2026-27aw", "2027ss" — same spelling as their URLs), this instead walks
    that season's own listing page by page (their pagination, ~42 items per
    page) until a page comes back empty, up to `limit`. That's how a full
    historical pull for a specific season (a backfill) is done — the
    unfiltered listing alone can't reach older items once enough newer ones
    have pushed them past page 1.
    """
    if season:
        gender_slug = "womens" if gender == "women" else "mens"
        path_root = f"/collections/search/{season}/{gender_slug}"
    else:
        path_root = COLLECTIONS_PATH_BY_GENDER[gender]

    raw: list = []
    page = 1
    while len(raw) < limit:
        suffix = "" if page == 1 else f"?page={page}"
        try:
            html = _fetch(path_root + suffix)
        except Exception as exc:  # noqa: BLE001
            logger.warning("fashion: page %d fetch failed for %s/%s: %s", page, season or "latest", gender, exc)
            break
        page_items = _parse_collection_links(html, limit=limit - len(raw))
        if not page_items:
            break  # past the last page (or nothing matched) — stop
        raw.extend(page_items)
        if not season:
            break  # unfiltered "latest" mode stays single-page, as before
        page += 1
        time.sleep(0.3)  # a backfill can be dozens of pages — be polite

    items = _finish_items(raw, category=gender)
    logger.info(
        "fashion: scraped %d %s collections%s", len(items), gender, f" ({season}, {page} page(s))" if season else ""
    )
    return items


def scrape_haute_couture(limit: int = 40, max_brands: int = 25):
    """Scrape haute-couture collections via the couture-house brand index.

    There's no dedicated couture search path, so this walks
    /brands/all/haute -> each house's own /brands/{id} profile page (which
    lists that house's collections directly), keeping only collections whose
    title carries the couture marker (a house's profile can otherwise mix in
    its ready-to-wear seasons too). Best-effort: a brand whose profile page
    doesn't parse is skipped rather than failing the whole run.
    """
    brand_href_re = re.compile(r"^/brands/(\d+)/?$")
    try:
        index_soup = BeautifulSoup(_fetch(HAUTE_COUTURE_BRANDS_PATH), "html.parser")
    except Exception as exc:  # noqa: BLE001
        logger.error("fashion: haute couture brand index failed: %s", exc)
        return []

    brand_ids = []
    seen_brands = set()
    for a in index_soup.find_all("a", href=True):
        m = brand_href_re.match(a["href"])
        if m and m.group(1) not in seen_brands:
            seen_brands.add(m.group(1))
            brand_ids.append(m.group(1))
        if len(brand_ids) >= max_brands:
            break

    raw = []
    for brand_id in brand_ids:
        try:
            path = BRAND_PROFILE_PATH.format(brand_id=brand_id)
            for link in _parse_collection_links(_fetch(path), limit=limit):
                if HAUTE_COUTURE_MARKER in link["title_ja"]:
                    raw.append(link)
        except Exception as exc:  # noqa: BLE001
            logger.warning("fashion: haute couture brand %s failed: %s", brand_id, exc)
        if len(raw) >= limit:
            break

    items = _finish_items(raw[:limit], category="haute-couture")
    logger.info("fashion: scraped %d haute couture collections from %d brands", len(items), len(brand_ids))
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


# ----------------------------- Coordinate search (kıyafet/kombin arama) -----------------------------
# Static filter taxonomy for /collections/looks — (query value, Turkish label[, hex]).
# Values mirror the site's own <option>/<a href> query params exactly; only the
# labels are ours (hand-translated — the site's own JA labels aren't reliable
# to machine-translate one at a time without heavy rate-limiting).
LOOKS_ITEM_GROUPS = [
    ("Ceket", [
        ("biker jacket", "Biker Ceket"),
        ("bomber jacket", "Bomber Ceket"),
        ("collarless jacket", "Yakasız Ceket"),
        ("double jacket", "Kruvaze Ceket"),
        ("field jacket", "Saha Ceketi"),
        ("puffer jacket", "Şişme (Puffer) Ceket"),
        ("shirt jacket", "Gömlek Ceket"),
        ("stadium jumper", "Stadyum Ceketi"),
        ("tailored jacket", "Blazer"),
        ("track jacket", "Eşofman Ceketi"),
        ("work jacket", "İş Ceketi"),
    ]),
    ("Üstler", [
        ("bustier", "Büstiyer"),
        ("camisole", "Askılı Bluz"),
        ("cardigan", "Hırka"),
        ("hoodie", "Kapüşonlu Sweatshirt"),
        ("polo", "Polo Yaka"),
        ("shirt", "Gömlek"),
        ("sweater", "Kazak / Triko"),
        ("sweatshirt", "Sweatshirt"),
        ("t shirt", "Tişört"),
        ("tank top", "Atlet"),
        ("tube top", "Straplez Bluz"),
        ("tunic", "Tunik"),
        ("vest", "Yelek"),
    ]),
    ("Alt Kısımlar", [
        ("cargo pants", "Kargo Pantolon"),
        ("chino pants", "Chino Pantolon"),
        ("cropped pants", "Kısa Boy Pantolon"),
        ("denim pants", "Kot Pantolon"),
        ("jogger pants", "Jogger Pantolon"),
        ("mini skirt", "Mini Etek"),
        ("shorts", "Şort"),
        ("skirt", "Etek"),
        ("slacks", "Kumaş Pantolon"),
    ]),
    ("Elbise / Tulum", [
        ("formal dress", "Elbise"),
        ("jumpsuit", "Tulum"),
        ("kimono", "Kimono"),
        ("one piece", "Tek Parça Elbise"),
    ]),
    ("Kaban", [
        ("cape coat", "Pelerin"),
        ("chesterfield coat", "Chesterfield Palto"),
        ("duffle coat", "Duffle Kaban"),
        ("fur coat", "Kürk Palto"),
        ("military coat", "Askeri Palto"),
        ("mods coat", "Mod Ceket"),
        ("mountain parka", "Dağ Parkası"),
        ("pea coat", "Kalın Yün Palto"),
        ("poncho coat", "Panço"),
        ("rain coat", "Yağmurluk"),
        ("soutien collar coat", "Şal Yaka Palto"),
        ("stand collar coat", "Dik Yaka Palto"),
        ("trench coat", "Trençkot"),
        ("wrap coat", "Kruvaze Palto"),
    ]),
]

LOOKS_COLORS = [
    ("white", "Beyaz", "#FFFFFF"),
    ("silver", "Gümüş", "#C0C0C0"),
    ("grey", "Gri", "#808080"),
    ("black", "Siyah", "#000000"),
    ("red", "Kırmızı", "#D32F2F"),
    ("burgundy", "Bordo", "#800020"),
    ("pink", "Pembe", "#FFC0CB"),
    ("purple", "Mor", "#6A1B9A"),
    ("navy", "Lacivert", "#001F5B"),
    ("blue", "Mavi", "#1976D2"),
    ("light_blue", "Açık Mavi", "#87CEFA"),
    ("green", "Yeşil", "#2E7D32"),
    ("olive", "Zeytin Yeşili", "#6B8E23"),
    ("khaki", "Haki", "#C3B091"),
    ("yellow", "Sarı", "#FFEB3B"),
    ("mustard", "Hardal", "#D3A51C"),
    ("gold", "Altın", "#D4AF37"),
    ("orange", "Turuncu", "#FF9800"),
    ("beige", "Bej", "#F5F5DC"),
    ("ivory", "Fildişi", "#FFF8E1"),
    ("brown", "Kahverengi", "#795548"),
]

LOOKS_MATERIALS = [
    ("denim", "Kot Kumaşı"),
    ("leather_suede", "Deri / Süet"),
    ("fleece", "Kürk / Boa"),
    ("velvet", "Kadife"),
    ("sheer", "Şeffaf / Tül"),
    ("rubber", "Kauçuk / PVC"),
    ("knit", "Triko"),
    ("wool", "Yün"),
    ("cotton", "Pamuk / Keten"),
    ("nylon", "Naylon / Polyester"),
    ("corduroy", "Fitilli Kadife"),
    ("silk", "İpek / Saten"),
    ("feather", "Tüy"),
]

LOOKS_PATTERNS = [
    ("animal", "Hayvan Deseni"),
    ("floral", "Çiçekli"),
    ("dot", "Puantiyeli"),
    ("stripes", "Çizgili (Dikey)"),
    ("border", "Çizgili (Yatay)"),
    ("check", "Ekose / Kareli"),
    ("camouflage", "Kamuflaj"),
    ("geometric", "Geometrik"),
    ("color_block", "Renk Bloklu"),
    ("gradient", "Degrade / Batik"),
    ("paisley", "Paisley"),
    ("nordic", "İskandinav Deseni"),
    ("monogram", "Monogram"),
    ("logo", "Logo / Yazı Baskılı"),
    ("graphic", "Grafik Baskılı"),
    ("heart", "Kalp Desenli"),
    ("cross", "Haç Desenli"),
    ("print", "Baskılı"),
    ("abstract", "Soyut Desen"),
    ("solid", "Düz Renk"),
    ("one_spot", "Tek Nokta Desenli"),
]

LOOKS_SEASONS = [
    "2027ss", "2026-27aw", "2026ss", "2025-26aw", "2025ss", "2024-25aw",
    "2024ss", "2023-24aw", "2023ss", "2022-23aw", "2022ss", "2021-22aw", "2021ss",
]


def looks_filters() -> dict:
    """Static filter option lists for the coordinate-search UI (season/gender/item/color/material/pattern)."""
    return {
        "genders": [
            {"value": "", "label": "Tümü"},
            {"value": "female", "label": "Bayanlar"},
            {"value": "male", "label": "Erkekler"},
        ],
        "seasons": [
            # LOOKS_SEASONS values are lowercase query params (e.g. "2026-27aw");
            # _season_label_tr expects the AW/SS suffix uppercase.
            {"value": s, "label": _season_label_tr(s[:-2] + s[-2:].upper())}
            for s in LOOKS_SEASONS
        ],
        "items": [{"group": g, "options": [{"value": v, "label": l} for v, l in opts]} for g, opts in LOOKS_ITEM_GROUPS],
        "colors": [{"value": v, "label": l, "hex": h} for v, l, h in LOOKS_COLORS],
        "materials": [{"value": v, "label": l} for v, l in LOOKS_MATERIALS],
        "patterns": [{"value": v, "label": l} for v, l in LOOKS_PATTERNS],
    }


def fetch_looks(params: dict, limit: int = 40) -> list:
    """Live-query fashion-press.net's coordinate search and parse the result cards.

    `params` may contain any of: gender, season, item, color, material, pattern
    (empty/omitted values are dropped, matching the site's own filter form).
    Each returned item: {source_id, url, image, brand_tr, season_text_tr}.
    """
    from urllib.parse import urlencode

    qs = {k: v for k, v in (params or {}).items() if v}
    query = urlencode(qs)
    path = LOOKS_PATH + (f"?{query}" if query else "")
    html = _fetch(path)
    soup = BeautifulSoup(html, "html.parser")

    raw = []
    seen = set()
    for art in soup.select("section.fp_look_list article"):
        a = art.find("a", class_="mount_gallery")
        if not a:
            continue
        href = a.get("href", "")
        if not href or href in seen:
            continue
        img = a.find("img")
        if not img:
            continue
        src = img.get("data-src") or img.get("src")
        if src and src.startswith("/"):
            src = BASE + src
        caption = a.find(class_="caption")
        brand = ""
        season_text = ""
        if caption:
            parts = [p.strip() for p in caption.stripped_strings if p.strip()]
            if parts:
                brand = parts[0]
            if len(parts) > 1:
                season_text = " ".join(parts[1:])
        seen.add(href)
        raw.append(
            {
                "source_id": a.get("data-imgid") or href.rsplit("/", 1)[-1],
                "url": BASE + href if href.startswith("/") else href,
                "image": src,
                "brand_ja": brand,
                "season_text_ja": season_text,
            }
        )
        if len(raw) >= limit:
            break

    # Translate brand + season caption text JA -> TR in one batch each.
    brands_tr = _translate_batch([r["brand_ja"] for r in raw])
    seasons_tr = _translate_batch([r["season_text_ja"] for r in raw])

    items = [
        {
            "source_id": r["source_id"],
            "url": r["url"],
            "image": r["image"],
            "brand_tr": brand_tr,
            "season_text_tr": season_tr,
        }
        for r, brand_tr, season_tr in zip(raw, brands_tr, seasons_tr)
    ]
    logger.info("fashion: fetched %d looks for %r", len(items), qs)
    return items


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    data = scrape_collections(limit=8)
    import json

    print(json.dumps(data, ensure_ascii=False, indent=2))
