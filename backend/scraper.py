"""
COZA — Zara Woman (ZW) scraper, sourced from zara.com/es/en (Spain store).

The Spain store exposes REAL manufacturing origin ("Made in X") and material
composition via the product `extra-detail` endpoint, which the Turkish store does not.
We therefore scrape the ES/EN catalog and enrich each product with its genuine origin.
"""
import os
import re
import logging
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

logger = logging.getLogger("coza.scraper")

SCRAPER_API_KEY = os.environ["SCRAPER_API_KEY"]
SCRAPER_BASE = "http://api.scraperapi.com/"
MARKET = "es/en"  # Spain store, English labels + real origin data.

CATEGORIES = [
    (2420896, "Elbise & Tulum"),
    (2635766, "Top & Body"),
    (2420417, "Tişört"),
    (2420369, "Gömlek"),
    (2420795, "Pantolon"),
    (2420480, "Şort & Bermuda"),
    (2420454, "Etek"),
    (2419185, "Jean"),
    (2420506, "Yelek"),
    (2664773, "Ceket"),
    (2420306, "Triko"),
    (2420942, "Blazer"),
    (2467841, "Sweatshirt & Eşofman"),
    (2419160, "Ayakkabı"),
    (2417728, "Çanta"),
    (2418989, "Aksesuar & Takı"),
]

# English (ES/EN store) country names -> Turkish.
COUNTRY_MAP = {
    "turkey": "Türkiye", "türkiye": "Türkiye",
    "morocco": "Fas", "portugal": "Portekiz", "spain": "İspanya",
    "china": "Çin", "bangladesh": "Bangladeş", "india": "Hindistan",
    "vietnam": "Vietnam", "cambodia": "Kamboçya", "pakistan": "Pakistan",
    "tunisia": "Tunus", "egypt": "Mısır", "myanmar": "Myanmar",
    "italy": "İtalya", "bulgaria": "Bulgaristan", "romania": "Romanya",
    "sri lanka": "Sri Lanka", "indonesia": "Endonezya", "brazil": "Brezilya",
    "albania": "Arnavutluk", "north macedonia": "Kuzey Makedonya",
    "macedonia": "Kuzey Makedonya", "ukraine": "Ukrayna", "greece": "Yunanistan",
    "poland": "Polonya", "lithuania": "Litvanya", "moldova": "Moldova",
}


def map_country(name: str) -> str:
    key = (name or "").strip().rstrip(".").lower()
    return COUNTRY_MAP.get(key, name.strip().rstrip("."))


def _proxy_get(url: str, api_key: str = "", timeout: int = 80) -> requests.Response:
    resp = requests.get(
        SCRAPER_BASE,
        params={"api_key": api_key or SCRAPER_API_KEY, "url": url},
        timeout=timeout,
    )
    resp.raise_for_status()
    return resp


def _fetch_category(cat_id: int, api_key: str = ""):
    url = f"https://www.zara.com/{MARKET}/category/{cat_id}/products?ajax=true"
    data = _proxy_get(url, api_key).json()
    out = []
    for group in data.get("productGroups", []):
        for element in group.get("elements", []):
            for comp in element.get("commercialComponents", []):
                out.append(comp)
    return out


def _parse_product(comp: dict, category_name: str):
    name = (comp.get("name") or "").strip()
    price = comp.get("price")
    if not name or not price:
        return None
    detail = comp.get("detail") or {}
    reference = detail.get("reference") or comp.get("reference") or str(comp.get("id"))
    display_reference = detail.get("displayReference") or ""

    images, color_name, color_id = [], "", ""
    colors = detail.get("colors") or []
    if colors:
        color = colors[0]
        color_name = color.get("name", "")
        color_id = str(color.get("id", "") or "")
        for media in (color.get("xmedia") or []):
            u = media.get("url")
            if u and media.get("type") == "image":
                images.append(u.replace("{width}", "750"))
    if not images:
        for media in (comp.get("xmedia") or []):
            u = media.get("url")
            if u:
                images.append(u.replace("{width}", "750"))
    seen, clean = set(), []
    for u in images:
        if u not in seen:
            seen.add(u)
            clean.append(u)
        if len(clean) >= 6:
            break

    ref_digits = re.sub(r"\D", "", display_reference) or re.sub(r"\D", "", reference)
    manufacturer_code = ref_digits[:4]
    full_code = f"{display_reference}/{color_id}" if display_reference and color_id else display_reference
    seo = comp.get("seo") or {}

    return {
        "product_id": str(comp.get("id")),
        "name": name,
        "price": round(price / 100.0, 2),
        "currency": "€",
        "category": category_name,
        "family": comp.get("familyName", "") or "",
        "department": comp.get("sectionName", "") or "Basic",
        "color": color_name,
        "images": clean,
        "reference": reference,
        "display_reference": display_reference,
        "full_code": full_code,
        "manufacturer_code": manufacturer_code,
        "supplier_code": manufacturer_code,
        "seo_keyword": seo.get("keyword", ""),
        "seo_product_id": str(seo.get("seoProductId", "")),
    }


def _collect_texts(node, acc):
    if isinstance(node, dict):
        if node.get("datatype") == "text" and "value" in node:
            acc.append(node["value"])
        for v in node.values():
            _collect_texts(v, acc)
    elif isinstance(node, list):
        for x in node:
            _collect_texts(x, acc)


def fetch_extra(product_id: str, api_key: str = ""):
    """Return {'origin': str|None, 'composition': [{area, materials}]} from ES/EN extra-detail."""
    url = f"https://www.zara.com/{MARKET}/product/{product_id}/extra-detail?ajax=true"
    try:
        data = _proxy_get(url, api_key, timeout=60).json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("extra-detail failed %s: %s", product_id, exc)
        return {"origin": None, "composition": []}
    if not isinstance(data, list):
        return {"origin": None, "composition": []}

    origin, composition = None, []
    for section in data:
        st = section.get("sectionType")
        if st == "origin":
            texts = []
            _collect_texts(section, texts)
            for t in texts:
                m = re.search(r"(?:Made in|Hecho en|Fabriqué en)\s+([A-Za-zÀ-ÿĞğİıŞşÇçÖöÜü .]+)", t)
                if m:
                    origin = map_country(m.group(1))
                    break
        elif st == "materials":
            texts = []
            _collect_texts(section, texts)
            cur = None
            for t in texts[1:]:  # skip the "COMPOSITION" title
                t = (t or "").strip()
                if not t:
                    continue
                if "%" in t:
                    composition.append({"area": cur or "", "materials": t})
                    cur = None
                else:
                    cur = t
    return {"origin": origin, "composition": composition}


def fetch_origin(product_id: str, api_key: str = ""):
    return fetch_extra(product_id, api_key).get("origin")


def collect_products(api_key: str = ""):
    """Synchronous. Returns (products, stats). Deduped by product_id."""
    products = {}
    stats = {"categories_ok": 0, "categories_failed": 0}
    for cat_id, cat_name in CATEGORIES:
        try:
            for comp in _fetch_category(cat_id, api_key):
                parsed = _parse_product(comp, cat_name)
                if not parsed:
                    continue
                if parsed["product_id"] not in products:
                    products[parsed["product_id"]] = parsed
            stats["categories_ok"] += 1
            logger.info("Scraped %s (%s)", cat_name, cat_id)
        except Exception as exc:  # noqa: BLE001
            stats["categories_failed"] += 1
            logger.error("Failed category %s (%s): %s", cat_name, cat_id, exc)
    return list(products.values()), stats
