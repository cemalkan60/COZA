import os
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


# ----------------------------- Models -----------------------------
class SignupBody(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)
    name: str = Field(default="", max_length=80)


class LoginBody(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class FavoriteBody(BaseModel):
    product_id: str = Field(min_length=1, max_length=64)


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


# ----------------------------- Scrape orchestration -----------------------------
async def run_scrape(reason: str = "manual") -> dict:
    if _scrape_lock.locked():
        return {"status": "already_running"}
    async with _scrape_lock:
        logger.info("Scrape started (%s)", reason)
        started = datetime.now(timezone.utc)
        products, stats = await asyncio.to_thread(scraper.collect_products)
        now_iso = datetime.now(timezone.utc).isoformat()
        for p in products:
            p["updated_at"] = now_iso
            await db.products.update_one(
                {"product_id": p["product_id"]},
                {"$set": p, "$setOnInsert": {"first_seen": now_iso}},
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
        return {"status": "ok", **meta}


async def _seed_if_empty():
    count = await db.products.count_documents({})
    if count == 0:
        logger.info("Product catalog empty — running initial scrape in background.")
        asyncio.create_task(run_scrape("initial_seed"))
    else:
        logger.info("Catalog present: %d products.", count)


# ----------------------------- Auth routes -----------------------------
@api.post("/auth/signup")
async def signup(body: SignupBody):
    email = body.email.lower()
    if await db.users.find_one({"email": email}):
        raise HTTPException(409, "Bu e-posta zaten kayıtlı.")
    import uuid
    uid = str(uuid.uuid4())
    doc = {
        "id": uid,
        "email": email,
        "name": body.name.strip(),
        "password_hash": hash_pw(body.password),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.users.insert_one(doc)
    return {
        "token": create_token(uid),
        "user": {"id": uid, "email": email, "name": doc["name"]},
    }


@api.post("/auth/login")
async def login(body: LoginBody):
    email = body.email.lower()
    user = await db.users.find_one({"email": email})
    if not user or not verify_pw(body.password, user["password_hash"]):
        raise HTTPException(401, "E-posta veya şifre hatalı.")
    return {
        "token": create_token(user["id"]),
        "user": {"id": user["id"], "email": user["email"], "name": user.get("name", "")},
    }


@api.get("/auth/me")
async def me(user: Annotated[dict, Depends(get_current_user)]):
    return user


# ----------------------------- Catalog routes -----------------------------
@api.get("/products")
async def list_products(
    category: Optional[str] = None,
    origin: Optional[str] = None,
    supplier: Optional[str] = None,
    q: Optional[str] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
    sort: str = "featured",
    skip: int = Query(0, ge=0),
    limit: int = Query(24, ge=1, le=60),
):
    query: dict = {}
    if category:
        query["category"] = category
    if origin:
        query["origin"] = origin
    if supplier:
        query["supplier_code"] = {"$regex": supplier, "$options": "i"}
    if q:
        query["$or"] = [
            {"name": {"$regex": q, "$options": "i"}},
            {"reference": {"$regex": q, "$options": "i"}},
            {"display_reference": {"$regex": q, "$options": "i"}},
            {"supplier_code": {"$regex": q, "$options": "i"}},
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


@api.get("/filters")
async def filters():
    categories = await db.products.distinct("category")
    origins = await db.products.distinct("origin")
    bounds = await db.products.aggregate([
        {"$group": {"_id": None, "min": {"$min": "$price"}, "max": {"$max": "$price"}}}
    ]).to_list(length=1)
    price = bounds[0] if bounds else {"min": 0, "max": 0}
    return {
        "categories": sorted(c for c in categories if c),
        "origins": sorted(o for o in origins if o),
        "price_min": price.get("min", 0) or 0,
        "price_max": price.get("max", 0) or 0,
    }


@api.get("/analytics")
async def analytics():
    total = await db.products.count_documents({})
    origin_dist = await db.products.aggregate([
        {"$group": {"_id": "$origin", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]).to_list(length=100)
    category_dist = await db.products.aggregate([
        {"$group": {"_id": "$category", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]).to_list(length=100)
    price_stats = await db.products.aggregate([
        {"$group": {"_id": None, "avg": {"$avg": "$price"},
                    "min": {"$min": "$price"}, "max": {"$max": "$price"}}}
    ]).to_list(length=1)
    supplier_count = len(await db.products.distinct("supplier_code"))
    ps = price_stats[0] if price_stats else {"avg": 0, "min": 0, "max": 0}
    meta = await db.meta.find_one({"_id": "scrape"}, {"_id": 0}) or {}
    return {
        "total_products": total,
        "supplier_count": supplier_count,
        "origin_count": len([o for o in origin_dist if o["_id"]]),
        "category_count": len([c for c in category_dist if c["_id"]]),
        "avg_price": round(ps.get("avg") or 0, 2),
        "min_price": ps.get("min") or 0,
        "max_price": ps.get("max") or 0,
        "origin_distribution": [
            {"label": o["_id"], "count": o["count"]} for o in origin_dist if o["_id"]
        ],
        "category_distribution": [
            {"label": c["_id"], "count": c["count"]} for c in category_dist if c["_id"]
        ],
        "last_scrape": meta.get("last_scrape"),
    }


@api.get("/meta")
async def get_meta():
    meta = await db.meta.find_one({"_id": "scrape"}, {"_id": 0}) or {}
    meta["product_count"] = await db.products.count_documents({})
    return meta


@api.post("/admin/scrape")
async def admin_scrape(user: Annotated[dict, Depends(get_current_user)]):
    result = await run_scrape("manual")
    return result


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
    await db.favorites.create_index([("user_id", 1), ("product_id", 1)], unique=True)
    scheduler.add_job(
        run_scrape, CronTrigger(hour=8, minute=0), args=["daily_08:00"],
        id="daily_scrape", replace_existing=True,
    )
    scheduler.start()
    await _seed_if_empty()


@app.on_event("shutdown")
async def on_shutdown():
    scheduler.shutdown(wait=False)
    client.close()
