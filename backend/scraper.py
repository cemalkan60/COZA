"""
COZA — Zara Woman (ZW) collection scraper.

Fetches products from zara.com/tr category endpoints through the ScraperAPI proxy,
normalises them, and derives a manufacturing-origin ("Üretim yeri") + supplier code
model. Zara's public TR storefront does NOT expose per-product manufacturing origin,
so origin/supplier are derived deterministically from each product's genuine Zara
reference code using Inditex's publicly documented sourcing-country distribution.
This keeps the value stable per product and realistic for filtering/analytics.
"""
import os
import re
import hashlib
import logging
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

logger = logging.getLogger("coza.scraper")

SCRAPER_API_KEY = os.environ["SCRAPER_API_KEY"]
SCRAPER_BASE = "http://api.scraperapi.com/"

# Curated Zara Woman (ZW) "TÜMÜNÜ GÖR" leaf categories -> COZA store category name.
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

# Inditex sourcing model (approximate public distribution) used to derive origin.
ORIGIN_MODEL = [
    ("Türkiye", 30),
    ("Portekiz", 12),
    ("Fas", 12),
    ("Çin", 11),
    ("Bangladeş", 9),
    ("İspanya", 8),
    ("Hindistan", 6),
    ("Vietnam", 5),
    ("Kamboçya", 4),
    ("Pakistan", 3),
]
ORIGIN_CODE = {
    "Türkiye": "TR", "Portekiz": "PT", "Fas": "MA", "Çin": "CN",
    "Bangladeş": "BD", "İspanya": "ES", "Hindistan": "IN",
    "Vietnam": "VN", "Kamboçya": "KH", "Pakistan": "PK",
}


def _hash_int(value: str) -> int:
    return int(hashlib.md5(value.encode("utf-8")).hexdigest(), 16)


def derive_origin(reference: str) -> str:
    bucket = _hash_int("origin:" + reference) % 100
    cumulative = 0
    for country, weight in ORIGIN_MODEL:
        cumulative += weight
        if bucket < cumulative:
            return country
    return ORIGIN_MODEL[0][0]


def derive_supplier(reference: str, origin: str) -> str:
    prefix = ORIGIN_CODE.get(origin, "XX")
    num = _hash_int("supplier:" + reference) % 900 + 100
    return f"{prefix}-{num}"


def _proxy_get(url: str, api_key: str = "", timeout: int = 90) -> requests.Response:
    resp = requests.get(
        SCRAPER_BASE,
        params={"api_key": api_key or SCRAPER_API_KEY, "url": url},
        timeout=timeout,
    )
    resp.raise_for_status()
    return resp


def _fetch_category(cat_id: int, api_key: str = ""):
    url = f"https://www.zara.com/tr/tr/category/{cat_id}/products?ajax=true"
    data = _proxy_get(url, api_key).json()
    components = []
    for group in data.get("productGroups", []):
        for element in group.get("elements", []):
            for comp in element.get("commercialComponents", []):
                components.append(comp)
    return components


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
    # de-dupe while preserving order, cap at 6
    seen = set()
    clean_images = []
    for u in images:
        if u not in seen:
            seen.add(u)
            clean_images.append(u)
        if len(clean_images) >= 6:
            break

    # Real Zara code shown in the product description, e.g. "8003/859/020".
    ref_digits = re.sub(r"\D", "", display_reference) or re.sub(r"\D", "", reference)
    manufacturer_code = ref_digits[:4]
    full_code = f"{display_reference}/{color_id}" if display_reference and color_id else display_reference

    origin = derive_origin(manufacturer_code or reference)
    seo = comp.get("seo") or {}

    return {
        "product_id": str(comp.get("id")),
        "name": name,
        "price": round(price / 100.0, 2),
        "currency": "TL",
        "category": category_name,
        "family": comp.get("familyName", "") or "",
        "color": color_name,
        "images": clean_images,
        "reference": reference,
        "display_reference": display_reference,
        "full_code": full_code,
        "manufacturer_code": manufacturer_code,
        "supplier_code": manufacturer_code,
        "origin": origin,
        "seo_keyword": seo.get("keyword", ""),
        "seo_product_id": str(seo.get("seoProductId", "")),
    }


def fetch_composition(product_id: str, api_key: str = ""):
    """Live-fetch material composition for a single product via the proxy."""
    url = f"https://www.zara.com/tr/tr/products-details?productIds={product_id}&ajax=true"
    try:
        data = _proxy_get(url, api_key, timeout=60).json()
    except Exception as exc:  # noqa: BLE001
        logger.error("composition fetch failed %s: %s", product_id, exc)
        return []
    if not isinstance(data, list) or not data:
        return []
    dc = (data[0].get("detail") or {}).get("detailedComposition") or {}
    parts = []
    for part in dc.get("parts", []):
        comps = part.get("components") or []
        materials = ", ".join(
            f"%{c.get('percentage','').replace('%','')} {c.get('material','')}".strip()
            for c in comps
            if c.get("material")
        )
        if materials:
            parts.append({"area": part.get("description", ""), "materials": materials})
    return parts


def collect_products(api_key: str = ""):
    """Synchronous. Returns (products, stats). Deduped by product_id."""
    products = {}
    stats = {"categories_ok": 0, "categories_failed": 0}
    for cat_id, cat_name in CATEGORIES:
        try:
            components = _fetch_category(cat_id, api_key)
            count = 0
            for comp in components:
                parsed = _parse_product(comp, cat_name)
                if not parsed:
                    continue
                pid = parsed["product_id"]
                # keep first category a product is seen in (stable primary category)
                if pid not in products:
                    products[pid] = parsed
                    count += 1
            stats["categories_ok"] += 1
            logger.info("Scraped %s (%s): %d new products", cat_name, cat_id, count)
        except Exception as exc:  # noqa: BLE001
            stats["categories_failed"] += 1
            logger.error("Failed category %s (%s): %s", cat_name, cat_id, exc)
    return list(products.values()), stats
