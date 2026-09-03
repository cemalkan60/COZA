import os
import io
import re
import asyncio
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, Annotated
from urllib.parse import urlparse

import jwt
import bcrypt
import requests
from fastapi import FastAPI, APIRouter, HTTPException, Depends, status, Query
from fastapi.responses import Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, EmailStr, Field
from dotenv import load_dotenv
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

import scraper
import fashion_scraper
import nowfashion_scraper
import firstview_scraper
import image_store

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("coza")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALGORITHM = os.environ["JWT_ALGORITHM"]
ACCESS_TOKEN_DAYS = int(os.environ.get("ACCESS_TOKEN_DAYS", "30"))

app = FastAPI(title="COZA API")
api = APIRouter(prefix="/api")
security = HTTPBearer(auto_error=True)
scheduler = AsyncIOScheduler(timezone="Europe/Istanbul")

_scrape_lock = asyncio.Lock()
_enrich_lock = asyncio.Lock()
_fashion_lock = asyncio.Lock()


# ----------------------------- Models -----------------------------
def normalize_ident(value: str) -> str:
    return (value or "").strip().casefold()


class LoginBody(BaseModel):
    email: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=128)


class FavoriteBody(BaseModel):
    product_id: str = Field(min_length=1, max_length=64)


class RemovedBody(BaseModel):
    removed: bool


class ProxyKeyBody(BaseModel):
    proxy_api_key: str = Field(min_length=8, max_length=256)
    storage_note: str = Field(default="", max_length=200)


# ----------------------------- Auth helpers -----------------------------
def hash_pw(pw: str) -> str:
    return bcrypt.hashpw(pw.encode("utf-8")[:72], bcrypt.gensalt()).decode("utf-8")


def verify_pw(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode("utf-8")[:72], hashed.encode("utf-8"))
    except Exception:  # noqa: BLE001
        return False


def create_token(user_id: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": user_id, "iat": now, "exp": now + timedelta(days=ACCESS_TOKEN_DAYS)}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


async def get_current_user(
    creds: Annotated[HTTPAuthorizationCredentials, Depends(security)]
) -> dict:
    err = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Geçersiz veya süresi dolmuş oturum.",
    )
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        uid = payload.get("sub")
        if not uid:
            raise err
    except jwt.PyJWTError:
        raise err
    user = await db.users.find_one({"id": uid}, {"_id": 0, "password_hash": 0})
    if not user:
        raise err
    return user


async def require_admin(user: Annotated[dict, Depends(get_current_user)]) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Bu işlem için yönetici yetkisi gerekli.")
    return user

async def get_proxy_key() -> str:
    """Always use the current ScraperAPI key from Railway variables."""
    return os.environ["SCRAPER_API_KEY"].strip()


# ----------------------------- Scrape orchestration -----------------------------
async def run_scrape(reason: str = "manual") -> dict:
    if _scrape_lock.locked():
        return {"status": "already_running"}
    async with _scrape_lock:
        logger.info("Scrape started (%s)", reason)
        started = datetime.now(timezone.utc)
        proxy_key = await get_proxy_key()
        products, stats = await asyncio.to_thread(scraper.collect_products, proxy_key)
        now_iso = datetime.now(timezone.utc).isoformat()

        existing_ids = set(await db.products.distinct("product_id"))
        first_load = len(existing_ids) == 0
        for p in products:
            p["updated_at"] = now_iso
            p["is_new"] = (not first_load) and (p["product_id"] not in existing_ids)
            await db.products.update_one(
                {"product_id": p["product_id"]},
                {"$set": p, "$setOnInsert": {"first_seen": now_iso, "origin": "Belirleniyor…"}},
                upsert=True,
            )

        meta = {
            "last_scrape": now_iso,
            "product_count": await db.products.count_documents({}),
            "categories_ok": stats["categories_ok"],
            "categories_failed": stats["categories_failed"],
            "reason": reason,
        }
        await db.meta.update_one({"_id": "scrape"}, {"$set": meta}, upsert=True)
        logger.info(
            "Scrape done (%s): %d products, %d cats ok / %d failed, %.1fs",
            reason, len(products), stats["categories_ok"], stats["categories_failed"],
            (datetime.now(timezone.utc) - started).total_seconds(),
        )
        # Enrich real manufacturing origins in the background (per manufacturer code).
        asyncio.create_task(enrich_origins(proxy_key))
        return {"status": "ok", **meta}


async def enrich_origins(proxy_key: str = ""):
    """Fetch REAL 'Made in X' origin from zara.es for EVERY product individually."""
    if _enrich_lock.locked():
        return
    async with _enrich_lock:
        proxy_key = proxy_key or await get_proxy_key()
        pending = await db.products.find(
            {"origin": "Belirleniyor…"}, {"product_id": 1}
        ).to_list(length=20000)
        logger.info("Origin enrichment started: %d products (per-product)", len(pending))
        sem = asyncio.Semaphore(5)

        async def one(pid: str):
            async with sem:
                origin = await asyncio.to_thread(scraper.fetch_origin, pid, proxy_key)
            if origin:
                await db.products.update_one(
                    {"product_id": pid}, {"$set": {"origin": origin}}
                )

        await asyncio.gather(*[one(p["product_id"]) for p in pending])
        known_count = await db.products.count_documents({"origin": {"$ne": "Belirleniyor…"}})
        await db.meta.update_one(
            {"_id": "scrape"},
            {"$set": {"origins_known": known_count}},
            upsert=True,
        )
        logger.info("Origin enrichment done: %d known", known_count)


async def _seed_if_empty():
    count = await db.products.count_documents({})
    if count == 0:
        logger.info("Product catalog empty — running initial scrape in background.")
        asyncio.create_task(run_scrape("initial_seed"))
    else:
        logger.info("Catalog present: %d products.", count)


# ----------------------------- COZA Fashion orchestration -----------------------------
# Only corporate / editorial data is collected across all sources below: brand,
# season, category, city, title/photos of the show itself. No user-generated
# or personal content.
FASHION_CATEGORIES = ("women", "men", "haute-couture")


def _brand_slug(brand: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (brand or "").strip().lower())


def _normalize_fashion_item(raw: dict) -> Optional[dict]:
    """Reshape one scraper's raw item into the common shape merging works on."""
    brand_tr = (raw.get("brand_tr") or "").strip()
    category = raw.get("category") or ""
    if not brand_tr or category not in FASHION_CATEGORIES:
        return None
    images = raw.get("images") or ([raw["image"]] if raw.get("image") else [])
    images = [u for u in images if u]
    season = raw.get("season") or ""
    return {
        "source": raw.get("source") or "",
        "raw_source_id": raw.get("source_id") or "",
        "url": raw.get("url") or "",
        "brand_tr": brand_tr,
        "title_tr": raw.get("title_tr") or brand_tr,
        "season": season,
        "season_label": raw.get("season_label") or fashion_scraper._season_label_tr(season),
        "category": category,
        "city": raw.get("city"),
        "images": images,
    }


def _fashion_merge_key(item: dict) -> str:
    key = f"{_brand_slug(item['brand_tr'])}-{(item['season'] or 'unk').lower()}-{item['category']}"
    key = re.sub(r"-+", "-", key).strip("-")
    return key or f"item-{abs(hash(item['url']))}"


def _dedupe_images_phash(urls: list, threshold: int = 6) -> list:
    """Drop near-duplicate photos (the same shot syndicated by two sources),
    keeping the higher-resolution copy. Downloads each candidate to hash it —
    only called for a merge group that actually mixes more than one source,
    so this stays bounded to the collections where it can matter.
    """
    if len(urls) <= 1:
        return urls
    try:
        from PIL import Image
        import imagehash
    except Exception:  # noqa: BLE001 - deps unavailable, fail open
        return urls

    entries = []  # (url, hash|None, byte_size)
    for u in urls:
        try:
            resp = requests.get(u, headers=fashion_scraper.HEADERS, timeout=15)
            resp.raise_for_status()
            content = resp.content
            h = imagehash.phash(Image.open(io.BytesIO(content)))
            entries.append((u, h, len(content)))
        except Exception:  # noqa: BLE001
            entries.append((u, None, 0))

    kept: list = []
    for u, h, size in entries:
        if h is None:
            kept.append([u, h, size])
            continue
        dup = next((k for k in kept if k[1] is not None and (h - k[1]) <= threshold), None)
        if dup is None:
            kept.append([u, h, size])
        elif size > dup[2]:
            dup[0], dup[1], dup[2] = u, h, size
    return [u for u, _, _ in kept]


def _merge_fashion_items(raw_items: list) -> list:
    """Group same brand+season+category across sources into one collection,
    combining photos and dropping near-duplicate shots between sources.
    """
    groups: dict = {}
    for raw in raw_items:
        item = _normalize_fashion_item(raw)
        if not item:
            continue
        key = _fashion_merge_key(item)
        g = groups.get(key)
        if g is None:
            g = {
                "source_id": key,
                "url": item["url"],
                "brand_tr": item["brand_tr"],
                "title_tr": item["title_tr"],
                "season": item["season"],
                "season_label": item["season_label"],
                "category": item["category"],
                "city": None,
                "images": [],
                "sources": [],
                "fp_source_id": None,
            }
            groups[key] = g
        g["images"].extend(item["images"])
        if item["city"] and not g["city"]:
            g["city"] = item["city"]
        if item["source"] and item["source"] not in g["sources"]:
            g["sources"].append(item["source"])
        if item["source"] == "fashion-press" and g["fp_source_id"] is None:
            g["fp_source_id"] = item["raw_source_id"]

    merged = []
    for g in groups.values():
        seen: set = set()
        unique_urls = [u for u in g["images"] if not (u in seen or seen.add(u))]
        if len(g["sources"]) > 1:
            unique_urls = _dedupe_images_phash(unique_urls)
        if image_store.ENABLED:
            # Re-host each photo on our own R2 bucket so the app serves it
            # instantly instead of live-proxying the source site per view.
            # No-op (returns the original URL) until R2 is configured.
            unique_urls = [image_store.cache_image(u) for u in unique_urls]
        g["images"] = unique_urls
        g["image"] = unique_urls[0] if unique_urls else None
        merged.append(g)
    return merged


async def run_fashion_scrape(reason: str = "manual") -> dict:
    """Scrape runway collections (women / men / haute couture) from
    fashion-press.net and firstview.com (nowfashion.com temporarily disabled,
    see below), merging the same brand+season+category found across sources
    into one entry.
    """
    if _fashion_lock.locked():
        return {"status": "already_running"}
    async with _fashion_lock:
        logger.info("Fashion scrape started (%s)", reason)
        started = datetime.now(timezone.utc)
        raw_items: list = []

        async def collect(label: str, fn, *args):
            try:
                got = await asyncio.to_thread(fn, *args)
                raw_items.extend(got or [])
            except Exception:
                logger.exception("Fashion scrape source failed (%s)", label)

        await collect("fashion-press/women", fashion_scraper.scrape_collections, 40, "women")
        await collect("fashion-press/men", fashion_scraper.scrape_collections, 40, "men")
        await collect("fashion-press/haute-couture", fashion_scraper.scrape_haute_couture, 40)
        # nowfashion.com is disabled for now: it blocks direct requests (403) and
        # also fails through the plain ScraperAPI proxy (500), which points to a
        # JS-based bot challenge — fixable with ScraperAPI's render=true mode, but
        # that costs ~10x credits per request, so left off pending a decision.
        # for cat in FASHION_CATEGORIES:
        #     await collect(f"nowfashion/{cat}", nowfashion_scraper.scrape_category, cat, 30)
        for cat in FASHION_CATEGORIES:
            await collect(f"firstview/{cat}", firstview_scraper.scrape_category, cat, 30)

        merged = await asyncio.to_thread(_merge_fashion_items, raw_items)
        now_iso = datetime.now(timezone.utc).isoformat()
        for it in merged:
            it["updated_at"] = now_iso
            await db.fashion.update_one(
                {"source_id": it["source_id"]},
                {"$set": it, "$setOnInsert": {"first_seen": now_iso}},
                upsert=True,
            )
        meta = {
            "last_scrape": now_iso,
            "item_count": await db.fashion.count_documents({}),
            "raw_item_count": len(raw_items),
            "reason": reason,
        }
        await db.meta.update_one({"_id": "fashion"}, {"$set": meta}, upsert=True)
        logger.info(
            "Fashion scrape done (%s): %d raw items -> %d merged collections, %.1fs",
            reason, len(raw_items), len(merged),
            (datetime.now(timezone.utc) - started).total_seconds(),
        )
        return {"status": "ok", **meta}


async def _seed_fashion_if_empty():
    count = await db.fashion.count_documents({})
    if count == 0:
        logger.info("Fashion feed empty — running initial fashion scrape in background.")
        asyncio.create_task(run_fashion_scrape("initial_seed"))
    else:
        logger.info("Fashion feed present: %d items.", count)


async def seed_users():
    """Converge db.users to EXACTLY the fixed 5-user allow-list (closed auth wall).

    Idempotent: preserves existing id, only rehashes when the configured
    password no longer verifies, and deletes any user outside the allow-list so
    no one else can authenticate.
    """
    import uuid
    fixed = [
        (os.environ["SEED_ADMIN_EMAIL"], os.environ["SEED_ADMIN_PASSWORD"], "admin", "Cem"),
        (os.environ["SEED_VIEWER1_EMAIL"], os.environ["SEED_VIEWER1_PASSWORD"], "viewer", "Ece"),
        (os.environ["SEED_VIEWER2_EMAIL"], os.environ["SEED_VIEWER2_PASSWORD"], "viewer", "Burak"),
        (os.environ["SEED_VIEWER3_EMAIL"], os.environ["SEED_VIEWER3_PASSWORD"], "viewer", "Beyza"),
        (os.environ["SEED_VIEWER4_EMAIL"], os.environ["SEED_VIEWER4_PASSWORD"], "viewer", "Ferdi"),
    ]
    allowed = [normalize_ident(e) for e, *_ in fixed]
    for email, pw, role, name in fixed:
        email = normalize_ident(email)
        existing = await db.users.find_one({"email": email})
        pw_hash = existing.get("password_hash") if existing else None
        if not pw_hash or not verify_pw(pw, pw_hash):
            pw_hash = hash_pw(pw)
        await db.users.update_one(
            {"email": email},
            {
                "$set": {
                    "email": email,
                    "name": name,
                    "role": role,
                    "disabled": False,
                    "password_hash": pw_hash,
                },
                "$setOnInsert": {
                    "id": str(uuid.uuid4()),
                    "created_at": datetime.now(timezone.utc).isoformat(),
                },
            },
            upsert=True,
        )
    # Destructive by design: remove every account outside the fixed allow-list.
    result = await db.users.delete_many({"email": {"$nin": allowed}})
    logger.info(
        "Auth wall: %d fixed users, removed %d stale users.",
        len(allowed), result.deleted_count,
    )


# ----------------------------- Auth routes -----------------------------
@api.post("/auth/login")
async def login(body: LoginBody):
    email = normalize_ident(body.email)
    user = await db.users.find_one({"email": email})
    if not user or user.get("disabled") or not verify_pw(body.password, user["password_hash"]):
        raise HTTPException(401, "Kullanıcı adı veya şifre hatalı.")
    return {
        "token": create_token(user["id"]),
        "user": {
            "id": user["id"],
            "email": user["email"],
            "name": user.get("name", ""),
            "role": user.get("role", "viewer"),
        },
    }


@api.get("/auth/me")
async def me(user: Annotated[dict, Depends(get_current_user)]):
    return user


# ----------------------------- Catalog routes -----------------------------
@api.get("/products")
async def list_products(
    category: Optional[str] = None,
    department: Optional[str] = None,
    origin: Optional[str] = None,
    supplier: Optional[str] = None,
    code: Optional[str] = None,
    q: Optional[str] = None,
    is_new: Optional[bool] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
    sort: str = "featured",
    skip: int = Query(0, ge=0),
    limit: int = Query(24, ge=1, le=60),
):
    query: dict = {}
    if category:
        query["category"] = category
    if department:
        query["department"] = department
    if origin:
        query["origin"] = origin
    if is_new:
        query["is_new"] = True
    # Manufacturer code = first 4 digits shown in the product code. Prefix match.
    manu = (code or supplier or "").strip()
    if manu:
        query["manufacturer_code"] = {"$regex": "^" + re.escape(manu), "$options": "i"}
    if q:
        qs = q.strip()
        query["$or"] = [
            {"name": {"$regex": re.escape(qs), "$options": "i"}},
            {"category": {"$regex": re.escape(qs), "$options": "i"}},
            {"origin": {"$regex": re.escape(qs), "$options": "i"}},
            {"color": {"$regex": re.escape(qs), "$options": "i"}},
            {"manufacturer_code": {"$regex": "^" + re.escape(qs), "$options": "i"}},
            {"full_code": {"$regex": re.escape(qs), "$options": "i"}},
        ]
    if min_price is not None or max_price is not None:
        pr: dict = {}
        if min_price is not None:
            pr["$gte"] = min_price
        if max_price is not None:
            pr["$lte"] = max_price
        query["price"] = pr

    sort_map = {
        "price_asc": [("price", 1)],
        "price_desc": [("price", -1)],
        "name": [("name", 1)],
        "featured": [("_id", 1)],
    }
    cursor = (
        db.products.find(query, {"_id": 0})
        .sort(sort_map.get(sort, sort_map["featured"]))
        .skip(skip)
        .limit(limit)
    )
    items = await cursor.to_list(length=limit)
    total = await db.products.count_documents(query)
    return {"items": items, "total": total, "skip": skip, "limit": limit}


@api.get("/products/{product_id}")
async def get_product(product_id: str):
    p = await db.products.find_one({"product_id": product_id}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Ürün bulunamadı.")
    return p


@api.post("/products/{product_id}/removed")
async def set_product_removed(
    product_id: str,
    body: RemovedBody,
    user: Annotated[dict, Depends(get_current_user)],
):
    """Ürünü 'mağazadan kalktı' olarak işaretle/işareti kaldır.

    Kalktı olarak işaretlenen ürünler katalogda görünmeye devam eder
    ama hiçbir analiz değerine dahil edilmez.
    """
    result = await db.products.update_one(
        {"product_id": product_id},
        {"$set": {
            "removed": body.removed,
            "removed_at": datetime.now(timezone.utc).isoformat() if body.removed else None,
            "removed_by": user.get("email") if body.removed else None,
        }},
    )
    if result.matched_count == 0:
        raise HTTPException(404, "Ürün bulunamadı.")
    p = await db.products.find_one({"product_id": product_id}, {"_id": 0})
    return p


@api.get("/products/{product_id}/composition")
async def product_composition(product_id: str):
    p = await db.products.find_one({"product_id": product_id})
    if p is None:
        raise HTTPException(404, "Ürün bulunamadı.")
    if p.get("composition") is not None:
        return {"composition": p["composition"]}
    key = await get_proxy_key()
    extra = await asyncio.to_thread(scraper.fetch_extra, product_id, key)
    comp = extra.get("composition", [])
    update = {"composition": comp}
    if extra.get("origin"):
        update["origin"] = extra["origin"]
    await db.products.update_one({"product_id": product_id}, {"$set": update})
    return {"composition": comp}


@api.get("/filters")
async def filters():
    not_removed = {"removed": {"$ne": True}}
    categories = await db.products.distinct("category", not_removed)
    departments = await db.products.distinct("department", not_removed)
    families = await db.products.distinct("family", not_removed)
    origins = await db.products.distinct("origin", not_removed)
    bounds = await db.products.aggregate([
        {"$match": not_removed},
        {"$group": {"_id": None, "min": {"$min": "$price"}, "max": {"$max": "$price"}}}
    ]).to_list(length=1)
    price = bounds[0] if bounds else {"min": 0, "max": 0}
    return {
        "categories": sorted(c for c in categories if c),
        "departments": sorted(d for d in departments if d),
        "families": sorted(f for f in families if f),
        "origins": sorted(o for o in origins if o),
        "price_min": price.get("min", 0) or 0,
        "price_max": price.get("max", 0) or 0,
    }


@api.get("/analytics")
async def analytics(
    department: Optional[str] = None,
    category: Optional[str] = None,
    family: Optional[str] = None,
    origin: Optional[str] = None,
):
    # Mağazadan kalkan ürünler hiçbir analiz değerine dahil edilmez.
    match: dict = {"removed": {"$ne": True}}
    if department:
        match["department"] = department
    if category:
        match["category"] = category
    if family:
        match["family"] = family
    if origin:
        match["origin"] = origin
    total = await db.products.count_documents(match)
    origin_dist = await db.products.aggregate([
        {"$match": match},
        {"$group": {"_id": "$origin", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]).to_list(length=100)
    category_dist = await db.products.aggregate([
        {"$match": match},
        {"$group": {"_id": "$category", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]).to_list(length=100)
    price_stats = await db.products.aggregate([
        {"$match": match},
        {"$group": {"_id": None, "avg": {"$avg": "$price"},
                    "min": {"$min": "$price"}, "max": {"$max": "$price"}}}
    ]).to_list(length=1)
    supplier_count = len(await db.products.distinct("supplier_code", match))
    # Üretici kodu dökümü: seçili filtreye giren her üreticinin kodu ve ürün adedi.
    manufacturer_dist = await db.products.aggregate([
        {"$match": {**match, "manufacturer_code": {"$ne": ""}}},
        {"$group": {"_id": "$manufacturer_code", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]).to_list(length=500)
    manufacturer_breakdown = [
        {"code": m["_id"], "count": m["count"]} for m in manufacturer_dist if m["_id"]
    ]
    ps = price_stats[0] if price_stats else {"avg": 0, "min": 0, "max": 0}
    meta = await db.meta.find_one({"_id": "scrape"}, {"_id": 0}) or {}
    real_origins = [o for o in origin_dist if o["_id"] and o["_id"] != "Belirleniyor…"]
    return {
        "total_products": total,
        "supplier_count": supplier_count,
        "manufacturer_count": len(manufacturer_breakdown),
        "manufacturer_breakdown": manufacturer_breakdown,
        "origin_count": len(real_origins),
        "category_count": len([c for c in category_dist if c["_id"]]),
        "avg_price": round(ps.get("avg") or 0, 2),
        "min_price": ps.get("min") or 0,
        "max_price": ps.get("max") or 0,
        "origin_distribution": [
            {"label": o["_id"], "count": o["count"]} for o in real_origins
        ],
        "category_distribution": [
            {"label": c["_id"], "count": c["count"]} for c in category_dist if c["_id"]
        ],
        "origins_known": meta.get("origins_known", await db.products.count_documents({"origin": {"$ne": "Belirleniyor…"}})),
        "last_scrape": meta.get("last_scrape"),
    }


@api.get("/manufacturers")
async def manufacturers(q: Optional[str] = None, limit: int = Query(30, ge=1, le=100)):
    match: dict = {"manufacturer_code": {"$ne": ""}, "removed": {"$ne": True}}
    if q:
        match["manufacturer_code"] = {"$regex": "^" + re.escape(q.strip()), "$options": "i"}
    pipeline = [
        {"$match": match},
        {"$group": {
            "_id": "$manufacturer_code",
            "count": {"$sum": 1},
            "origins": {"$addToSet": "$origin"},
        }},
        {"$sort": {"count": -1}},
        {"$limit": limit},
    ]
    rows = await db.products.aggregate(pipeline).to_list(length=limit)
    return {
        "items": [
            {
                "code": r["_id"],
                "count": r["count"],
                "origins": [o for o in r["origins"] if o and o != "Belirleniyor…"],
            }
            for r in rows
        ]
    }


@api.get("/analytics/manufacturer/{code}")
async def manufacturer_analytics(code: str):
    match = {"manufacturer_code": code, "removed": {"$ne": True}}
    total = await db.products.count_documents(match)
    if total == 0:
        raise HTTPException(404, "Bu koda ait ürün bulunamadı.")
    origin_dist = await db.products.aggregate([
        {"$match": match},
        {"$group": {"_id": "$origin", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]).to_list(length=50)
    category_dist = await db.products.aggregate([
        {"$match": match},
        {"$group": {"_id": "$category", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]).to_list(length=50)
    price_stats = await db.products.aggregate([
        {"$match": match},
        {"$group": {"_id": None, "avg": {"$avg": "$price"},
                    "min": {"$min": "$price"}, "max": {"$max": "$price"}}},
    ]).to_list(length=1)
    ps = price_stats[0] if price_stats else {"avg": 0, "min": 0, "max": 0}
    real_origins = [o for o in origin_dist if o["_id"] and o["_id"] != "Belirleniyor…"]
    sample = await db.products.find_one(match, {"_id": 0, "images": 1, "name": 1})
    return {
        "code": code,
        "total": total,
        "avg_price": round(ps.get("avg") or 0, 2),
        "min_price": ps.get("min") or 0,
        "max_price": ps.get("max") or 0,
        "primary_origin": real_origins[0]["_id"] if real_origins else "Belirleniyor…",
        "origin_distribution": [{"label": o["_id"], "count": o["count"]} for o in real_origins],
        "category_distribution": [
            {"label": c["_id"], "count": c["count"]} for c in category_dist if c["_id"]
        ],
        "sample_image": (sample or {}).get("images", [None])[0],
    }


@api.get("/meta")
async def get_meta():
    meta = await db.meta.find_one({"_id": "scrape"}, {"_id": 0}) or {}
    meta["product_count"] = await db.products.count_documents({})
    meta["origins_known"] = await db.products.count_documents({"origin": {"$ne": "Belirleniyor…"}})
    return meta


@api.post("/admin/scrape")
async def admin_scrape(admin: Annotated[dict, Depends(require_admin)]):
    result = await run_scrape("manual")
    return result


@api.post("/admin/enrich-origins")
async def admin_enrich(admin: Annotated[dict, Depends(require_admin)]):
    """On-demand: fetch REAL origins for products still 'Belirleniyor…'."""
    if _enrich_lock.locked():
        return {"status": "already_running"}
    pending = await db.products.count_documents({"origin": "Belirleniyor…"})
    asyncio.create_task(enrich_origins(await get_proxy_key()))
    return {"status": "started", "pending_products": pending}


@api.get("/admin/settings")
async def get_settings(admin: Annotated[dict, Depends(require_admin)]):
    cfg = await db.settings.find_one({"_id": "scraper"}) or {}
    key = cfg.get("proxy_api_key") or os.environ["SCRAPER_API_KEY"]
    masked = (key[:4] + "•" * 6 + key[-4:]) if len(key) > 8 else "••••"
    return {
        "proxy_api_key_masked": masked,
        "storage_note": cfg.get("storage_note", ""),
        "db_name": os.environ["DB_NAME"],
        "product_count": await db.products.count_documents({}),
        "updated_at": cfg.get("updated_at"),
        "updated_by": cfg.get("updated_by"),
    }


@api.put("/admin/settings")
async def update_settings(body: ProxyKeyBody, admin: Annotated[dict, Depends(require_admin)]):
    await db.settings.update_one(
        {"_id": "scraper"},
        {"$set": {
            "proxy_api_key": body.proxy_api_key,
            "storage_note": body.storage_note,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "updated_by": admin["email"],
        }},
        upsert=True,
    )
    return {"status": "ok"}


# ----------------------------- Favorites -----------------------------
@api.get("/favorites")
async def list_favorites(user: Annotated[dict, Depends(get_current_user)]):
    favs = await db.favorites.find({"user_id": user["id"]}, {"_id": 0}).to_list(length=500)
    ids = [f["product_id"] for f in favs]
    if not ids:
        return {"items": [], "product_ids": []}
    products = await db.products.find({"product_id": {"$in": ids}}, {"_id": 0}).to_list(length=500)
    return {"items": products, "product_ids": ids}


@api.get("/favorites/ids")
async def favorite_ids(user: Annotated[dict, Depends(get_current_user)]):
    favs = await db.favorites.find(
        {"user_id": user["id"]}, {"_id": 0, "product_id": 1}
    ).to_list(length=500)
    return {"product_ids": [f["product_id"] for f in favs]}


@api.post("/favorites")
async def add_favorite(body: FavoriteBody, user: Annotated[dict, Depends(get_current_user)]):
    await db.favorites.update_one(
        {"user_id": user["id"], "product_id": body.product_id},
        {"$setOnInsert": {
            "user_id": user["id"],
            "product_id": body.product_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )
    return {"status": "ok", "product_id": body.product_id}


@api.delete("/favorites/{product_id}")
async def remove_favorite(product_id: str, user: Annotated[dict, Depends(get_current_user)]):
    await db.favorites.delete_one({"user_id": user["id"], "product_id": product_id})
    return {"status": "ok", "product_id": product_id}


# ----------------------------- COZA Fashion routes -----------------------------
def _fashion_image_host_allowed(hostname: str) -> bool:
    hostname = (hostname or "").lower()
    return hostname == "fashion-press.net" or hostname.endswith(".fashion-press.net")


@api.get("/fashion/image-proxy")
async def fashion_image_proxy(url: str):
    """Streams a fashion-press.net photo through our own origin.

    fashion-press.net rejects image requests that carry a foreign Referer
    header, which browsers attach automatically on every <img> — that's why
    Fashion tab photos loaded fine on native (RN doesn't send one) but not on
    web. Fetching the bytes server-side (same requests/headers the scraper
    already uses successfully) and re-serving them from our own domain
    sidesteps the browser's Referer/CORS behavior entirely. No auth
    dependency here on purpose: an <img> tag can't attach our Bearer token,
    and the host allowlist below keeps this from being an open relay.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not _fashion_image_host_allowed(parsed.hostname or ""):
        raise HTTPException(400, "Desteklenmeyen görsel kaynağı.")
    try:
        resp = await asyncio.to_thread(requests.get, url, headers=fashion_scraper.HEADERS, timeout=15)
        resp.raise_for_status()
    except Exception:
        raise HTTPException(502, "Görsel alınamadı.")
    return Response(
        content=resp.content,
        media_type=resp.headers.get("Content-Type", "image/jpeg"),
        headers={"Cache-Control": "public, max-age=604800, immutable"},
    )


@api.get("/fashion/collections")
async def fashion_collections(
    user: Annotated[dict, Depends(get_current_user)],
    season: Optional[str] = None,
    category: Optional[str] = None,
    city: Optional[str] = None,
    q: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(30, ge=1, le=60),
):
    """Runway collections (women/men/haute couture), aggregated from
    multiple sources and merged by brand+season+category."""
    query: dict = {}
    if season:
        query["season"] = season
    if category:
        query["category"] = category
    if city:
        query["city"] = city
    if q:
        qs = q.strip()
        query["$or"] = [
            {"brand_tr": {"$regex": re.escape(qs), "$options": "i"}},
            {"title_tr": {"$regex": re.escape(qs), "$options": "i"}},
        ]
    cursor = (
        db.fashion.find(query, {"_id": 0})
        .sort([("updated_at", -1), ("source_id", -1)])
        .skip(skip)
        .limit(limit)
    )
    items = await cursor.to_list(length=limit)
    total = await db.fashion.count_documents(query)
    return {"items": items, "total": total, "skip": skip, "limit": limit}


@api.get("/fashion/collections/{source_id}")
async def fashion_collection_detail(source_id: str):
    """Full runway gallery (all photos) for one collection, fetched on demand and cached.

    nowfashion.com and firstview.com items already carry their full photo
    set from the scrape itself; only fashion-press.net's search-page listing
    is thumbnail-only, so the on-demand fallback below is specific to that
    source (fp_source_id is its raw numeric collection id).
    """
    doc = await db.fashion.find_one({"source_id": source_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Koleksiyon bulunamadı.")
    if doc.get("images"):
        return {"images": doc["images"]}
    fp_id = doc.get("fp_source_id")
    if not fp_id:
        return {"images": []}
    try:
        images = await asyncio.to_thread(fashion_scraper.fetch_collection_images, fp_id)
        if image_store.ENABLED:
            images = await asyncio.to_thread(lambda: [image_store.cache_image(u) for u in images])
    except Exception:
        images = []
    if images:
        await db.fashion.update_one({"source_id": source_id}, {"$set": {"images": images}})
    return {"images": images}


@api.get("/fashion/looks/filters")
async def fashion_looks_filters(user: Annotated[dict, Depends(get_current_user)]):
    """Static filter option lists (season/gender/item/color/material/pattern) for coordinate search."""
    return fashion_scraper.looks_filters()


_LOOKS_CACHE_TTL = timedelta(hours=6)


@api.get("/fashion/looks")
async def fashion_looks(
    user: Annotated[dict, Depends(get_current_user)],
    gender: Optional[str] = None,
    season: Optional[str] = None,
    item: Optional[str] = None,
    color: Optional[str] = None,
    material: Optional[str] = None,
    pattern: Optional[str] = None,
):
    """Coordinate search ("kombin arama"): live-filtered single runway photos.

    Proxies fashion-press.net's own /collections/looks filter, cached briefly
    per unique filter combination so repeated searches don't re-hit the source
    site on every request.
    """
    params = {
        "gender": gender,
        "season": season,
        "item": item,
        "color": color,
        "material": material,
        "pattern": pattern,
    }
    params = {k: v for k, v in params.items() if v}
    cache_key = "&".join(f"{k}={v}" for k, v in sorted(params.items())) or "_all"

    cached = await db.fashion_looks_cache.find_one({"_id": cache_key})
    if cached and cached.get("fetched_at"):
        fetched_at = datetime.fromisoformat(cached["fetched_at"])
        if datetime.now(timezone.utc) - fetched_at < _LOOKS_CACHE_TTL:
            return {"items": cached["items"]}

    try:
        items = await asyncio.to_thread(fashion_scraper.fetch_looks, params)
    except Exception:
        logger.exception("fashion looks fetch failed for %r", params)
        if cached:
            return {"items": cached["items"]}
        raise HTTPException(502, "Kıyafet arama şu anda kullanılamıyor.")

    await db.fashion_looks_cache.update_one(
        {"_id": cache_key},
        {"$set": {"items": items, "fetched_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    return {"items": items}


@api.get("/fashion/analytics")
async def fashion_analytics(user: Annotated[dict, Depends(get_current_user)]):
    """COZA-style aggregates over the fashion feed: seasons & top brands."""
    total = await db.fashion.count_documents({})
    season_dist = await db.fashion.aggregate([
        {"$match": {"season_label": {"$nin": ["", None]}}},
        {"$group": {"_id": "$season_label", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]).to_list(length=50)
    brand_dist = await db.fashion.aggregate([
        {"$match": {"brand_tr": {"$nin": ["", None]}}},
        {"$group": {"_id": "$brand_tr", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
        {"$limit": 12},
    ]).to_list(length=12)
    meta = await db.meta.find_one({"_id": "fashion"}, {"_id": 0}) or {}
    return {
        "total": total,
        "seasons": [{"label": r["_id"], "count": r["count"]} for r in season_dist],
        "brands": [{"label": r["_id"], "count": r["count"]} for r in brand_dist],
        "brand_count": len(await db.fashion.distinct("brand_tr")),
        "last_scrape": meta.get("last_scrape"),
    }


@api.get("/fashion/meta")
async def fashion_meta(user: Annotated[dict, Depends(get_current_user)]):
    meta = await db.meta.find_one({"_id": "fashion"}, {"_id": 0}) or {}
    meta["item_count"] = await db.fashion.count_documents({})
    return meta


@api.post("/admin/fashion-scrape")
async def admin_fashion_scrape(admin: Annotated[dict, Depends(require_admin)]):
    # Fire-and-forget: with three sources plus per-collection photo dedup this
    # can now run well past typical HTTP client/proxy timeouts if awaited inline.
    if _fashion_lock.locked():
        return {"status": "already_running"}
    asyncio.create_task(run_fashion_scrape("manual"))
    return {"status": "started"}


@api.get("/")
async def root():
    return {"app": "COZA", "status": "ok"}


app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def on_startup():
    await db.users.create_index("email", unique=True)
    await db.users.create_index("id", unique=True)
    await db.products.create_index("product_id", unique=True)
    await db.products.create_index("category")
    await db.products.create_index("origin")
    await db.products.create_index("manufacturer_code")
    await db.products.create_index("is_new")
    await db.favorites.create_index([("user_id", 1), ("product_id", 1)], unique=True)
    await db.fashion.create_index("source_id", unique=True)
    await db.fashion.create_index("season")
    await db.fashion.create_index("category")
    await db.fashion.create_index("city")
    await seed_users()
    # A CronTrigger built standalone (as below) does NOT inherit the
    # scheduler's `timezone=` — it defaults to the host's local system time,
    # which is UTC on Railway. Without `timezone=` here these jobs silently
    # fired at 08:00/07:00 UTC (11:00/10:00 Istanbul), not the advertised time.
    scheduler.add_job(
        run_scrape, CronTrigger(day_of_week="mon,thu", hour=8, minute=0, timezone="Europe/Istanbul"),
        args=["scheduled_mon_thu_08:00"],
        id="scheduled_scrape", replace_existing=True,
    )
    # COZA Fashion: refresh runway collections every day at 07:00. Re-scraping
    # daily doesn't create duplicates — items upsert by brand+season+category,
    # so an unchanged collection just gets its updated_at bumped and only
    # genuinely new collections add a new entry.
    scheduler.add_job(
        run_fashion_scrape, CronTrigger(hour=7, minute=0, timezone="Europe/Istanbul"),
        args=["scheduled_daily_07:00"],
        id="scheduled_fashion_scrape", replace_existing=True,
    )
    scheduler.start()
    await _seed_if_empty()
    await _seed_fashion_if_empty()


@app.on_event("shutdown")
async def on_shutdown():
    scheduler.shutdown(wait=False)
    client.close()
