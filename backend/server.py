import os
import re
import asyncio
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, Annotated

import jwt
import bcrypt
from fastapi import FastAPI, APIRouter, HTTPException, Depends, status, Query
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, EmailStr, Field
from dotenv import load_dotenv
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

import scraper

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


# ----------------------------- Models -----------------------------
def normalize_ident(value: str) -> str:
    return (value or "").strip().casefold()


class LoginBody(BaseModel):
    email: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=128)


class FavoriteBody(BaseModel):
    product_id: str = Field(min_length=1, max_length=64)


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
        await db.origins.update_one(
            {"_id": p.get("manufacturer_code")},
            {"$set": {"origin": extra["origin"]}},
            upsert=True,
        )
    await db.products.update_one({"product_id": product_id}, {"$set": update})
    return {"composition": comp}


@api.get("/filters")
async def filters():
    categories = await db.products.distinct("category")
    departments = await db.products.distinct("department")
    origins = await db.products.distinct("origin")
    bounds = await db.products.aggregate([
        {"$group": {"_id": None, "min": {"$min": "$price"}, "max": {"$max": "$price"}}}
    ]).to_list(length=1)
    price = bounds[0] if bounds else {"min": 0, "max": 0}
    return {
        "categories": sorted(c for c in categories if c),
        "departments": sorted(d for d in departments if d),
        "origins": sorted(o for o in origins if o),
        "price_min": price.get("min", 0) or 0,
        "price_max": price.get("max", 0) or 0,
    }


@api.get("/analytics")
async def analytics(department: Optional[str] = None, category: Optional[str] = None):
    match: dict = {}
    if department:
        match["department"] = department
    if category:
        match["category"] = category
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
    ps = price_stats[0] if price_stats else {"avg": 0, "min": 0, "max": 0}
    meta = await db.meta.find_one({"_id": "scrape"}, {"_id": 0}) or {}
    real_origins = [o for o in origin_dist if o["_id"] and o["_id"] != "Belirleniyor…"]
    return {
        "total_products": total,
        "supplier_count": supplier_count,
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
    match: dict = {"manufacturer_code": {"$ne": ""}}
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
    match = {"manufacturer_code": code}
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
    """On-demand: fetch REAL origins for manufacturer codes still 'Belirleniyor…'."""
    if _enrich_lock.locked():
        return {"status": "already_running"}
    known = set(await db.origins.distinct("_id"))
    codes = [c for c in await db.products.distinct("manufacturer_code") if c]
    pending = len([c for c in codes if c not in known])
    asyncio.create_task(enrich_origins(await get_proxy_key()))
    return {"status": "started", "pending_codes": pending}


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
    await seed_users()
    scheduler.add_job(
        run_scrape, CronTrigger(day_of_week="mon,thu", hour=8, minute=0),
        args=["scheduled_mon_thu_08:00"],
        id="scheduled_scrape", replace_existing=True,
    )
    scheduler.start()
    await _seed_if_empty()


@app.on_event("shutdown")
async def on_shutdown():
    scheduler.shutdown(wait=False)
    client.close()
