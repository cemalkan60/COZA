import os
import io
import re
import time
import uuid
import secrets
import asyncio
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, Annotated
from urllib.parse import urlparse

import jwt
import bcrypt
import requests
from fastapi import FastAPI, APIRouter, HTTPException, Depends, status, Query, File, UploadFile
from fastapi.responses import Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import UpdateOne
from pydantic import BaseModel, EmailStr, Field
from dotenv import load_dotenv
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

import scraper
import fashion_scraper
import nowfashion_scraper
import firstview_scraper
import image_store
import gemini_client
import fashion_tag_map

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

_PROCESS_START = datetime.now(timezone.utc)

_scrape_lock = asyncio.Lock()
_enrich_lock = asyncio.Lock()
_fashion_lock = asyncio.Lock()

_JOB_LABELS = {
    "catalog_scrape": "Katalog taraması",
    "fashion_scrape": "Fashion taraması",
    "fashion_backfill": "Fashion taraması (2026'dan beri)",
    "fashion_tag_photos": "Fotoğraf etiketleme",
    "fashion_repair_urls": "Fotoğraf adreslerini onarma",
    "fashion_drop_dead_images": "Ölü fotoğraf adreslerini temizleme",
    "fashion_cover_fix": "Kapak düzeltme",
    "fashion_thumbnails": "Küçük resimler",
    "fashion_blurhash": "Kapak bulanık önizlemesi",
    "fashion_merge_duplicates": "Yinelenen birleştirme",
    "fashion_clean_cruft": "Bozuk kayıt temizliği",
    "fashion_prune_old": "Eski kayıt temizliği",
}


async def _record_job_run(
    job: str, *, status: str, started_at: str, detail: str = "", reason: str = "",
    done: "int | None" = None, total: "int | None" = None,
) -> None:
    """Append one entry to the Admin panel's "son işlemler" history (db.meta
    _id "job_runs", newest first, capped to 40) — see admin.tsx. `status` is
    one of "ok" / "partial" / "error". Before this, a job's outcome only
    ever showed up as a live progress bar WHILE it ran; the moment it
    stopped (finished, ran out of quota, or crashed) that information was
    gone, so "it just stopped" had no answer anywhere in the app.
    """
    entry = {
        "job": job,
        "label": _JOB_LABELS.get(job, job),
        "status": status,
        "detail": detail,
        "reason": reason,
        "done": done,
        "total": total,
        "pct": round(100 * done / total) if (done is not None and total) else None,
        "started_at": started_at,
        "finished_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.meta.update_one(
        {"_id": "job_runs"},
        {"$push": {"items": {"$each": [entry], "$position": 0, "$slice": 40}}},
        upsert=True,
    )


async def _run_tracked(job: str, coro) -> None:
    """Fire-and-forget wrapper for every admin sweep launched via
    asyncio.create_task (and every scheduled job — see on_startup). Each
    run_fashion_* function already records its own success/partial outcome
    at its return points; this only exists to catch the case none of them
    handle: the coroutine raising outright (a DB hiccup, a bug). Without
    this, `scraping` stays stuck true with a frozen progress bar until the
    next process restart (see the old "Clear stale scraping:true on
    startup" band-aid), and nothing ever explains why.
    """
    started_at = datetime.now(timezone.utc).isoformat()
    try:
        await coro
    except Exception as exc:
        logger.exception("%s crashed", job)
        if job != "catalog_scrape":  # this job's live state lives in db.meta._id "fashion"
            await db.meta.update_one({"_id": "fashion"}, {"$set": {"scraping": False, "phase": "interrupted"}})
        await _record_job_run(
            job, status="error", started_at=started_at,
            reason=f"Beklenmeyen hata: {type(exc).__name__}: {exc}"[:300],
        )


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


# --- COZA Lens "boards" (Pinterest-style saved photos in nested folders) ---
class BoardCreateBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    parent_id: Optional[str] = Field(default=None, max_length=64)
    # A8: "akıllı board" — the Lens filter this board tracks (gender/season/
    # item/color/material/pattern/q), so it can be refreshed with newly
    # matching photos later. None for a normal, manually-curated board.
    smart_filter: Optional[dict] = Field(default=None)


class BoardUpdateBody(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    parent_id: Optional[str] = Field(default=None, max_length=64)  # "" / "root" -> move to root


class SavePhotoBody(BaseModel):
    source_id: str = Field(min_length=1, max_length=200)
    photo_index: int = Field(ge=0, le=2000)
    image: str = Field(min_length=1, max_length=1000)
    image_thumb: str = Field(default="", max_length=1000)
    brand_tr: str = Field(default="", max_length=200)
    season: str = Field(default="", max_length=40)
    season_label: str = Field(default="", max_length=80)
    url: str = Field(default="", max_length=1000)


class SavedPhotoNoteBody(BaseModel):
    """A1: personal note + custom tags on a saved photo (not the AI's tags —
    the user's own, editable freely)."""
    note: Optional[str] = Field(default=None, max_length=500)
    tags: Optional[list[str]] = Field(default=None, max_length=20)


class FashionReportBody(BaseModel):
    """G2: "bu kapak/marka yanlış" — a user flag, routed to an admin queue."""
    reason: str = Field(min_length=1, max_length=30)  # "wrong_cover" | "wrong_brand" | "other"
    note: str = Field(default="", max_length=300)


class AddUserPhotoBody(BaseModel):
    image_url: str = Field(min_length=1, max_length=2000)


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
    _touch_last_active(uid)
    return user


# H2: "kim kullanıyor, ne sıklıkta" — last-seen timestamp per user, updated
# at most once a minute per user (in-memory throttle) so this doesn't turn
# every authenticated request into an extra DB write; fine to lose on a
# redeploy, it just means one user's dot goes a minute stale.
_LAST_ACTIVE_WRITTEN: dict = {}


def _touch_last_active(user_id: str) -> None:
    now = time.time()
    if now - _LAST_ACTIVE_WRITTEN.get(user_id, 0) < 60:
        return
    _LAST_ACTIVE_WRITTEN[user_id] = now
    asyncio.create_task(
        db.users.update_one({"id": user_id}, {"$set": {"last_active": datetime.now(timezone.utc).isoformat()}})
    )


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
        started_at = started.isoformat()
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
        await _record_job_run(
            "catalog_scrape",
            status="ok" if not stats["categories_failed"] else "partial",
            started_at=started_at,
            done=stats["categories_ok"], total=stats["categories_ok"] + stats["categories_failed"],
            detail=f"{len(products)} ürün, {stats['categories_ok']}/{stats['categories_ok'] + stats['categories_failed']} kategori",
            reason="Bazı kategoriler taranamadı (kaynak/proxy hatası)." if stats["categories_failed"] else "",
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
        asyncio.create_task(_run_tracked("catalog_scrape", run_scrape("initial_seed")))
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
    # Canonicalize here, once, so every downstream consumer (the merge key,
    # season_label, season_rank, the saved doc's own `season` field) sees
    # the same spelling regardless of which source this item came from —
    # see _season_merge_code.
    season = _season_merge_code(raw.get("season") or "")
    return {
        "source": raw.get("source") or "",
        "raw_source_id": raw.get("source_id") or "",
        "url": raw.get("url") or "",
        "brand_tr": brand_tr,
        "title_tr": raw.get("title_tr") or brand_tr,
        # Kept on the doc so a later season-parser fix can be re-applied
        # without re-scraping (see _reparse_seasons_if_needed).
        "title_ja": raw.get("title_ja") or "",
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


# Chronological sort key for a season code, higher = shown more recently.
#
# fashion-press writes fall/winter as a year-span ("2026-27AW") and
# firstview writes it as a single year ("2026AW") -- both name the same
# real show, so only the first year in the code matters. Within one label
# year Y, real-world show months run Resort Y (~May/Jun of Y-1) -> Spring/
# Summer Y (~Sept/Oct of Y-1) -> Pre-Fall Y (~Nov/Dec of Y-1) -> Fall/
# Winter Y (~Feb/Mar of Y itself, the only one of the four actually shown
# in calendar year Y) -- so *10 + this offset stays monotonic in show-date
# order across year boundaries too (e.g. Fall/Winter 2026 = 20263 sorts
# below Resort 2027 = 20270, matching Feb 2026 < May 2026).
_SEASON_RANK_RE = re.compile(r"^(\d{4})(?:-\d{2})?(AW|SS|RESORT|PREFALL)$", re.IGNORECASE)
_SEASON_ERA_OFFSET = {"RESORT": 0, "SS": 1, "PREFALL": 2, "AW": 3}


def _season_rank(season: str) -> float:
    """Chronological sort key for `season` (see _SEASON_RANK_RE above).
    Unparseable/missing seasons rank lowest so they sink to the bottom of a
    "newest first" feed instead of landing in some arbitrary middle spot.
    """
    m = _SEASON_RANK_RE.match((season or "").strip())
    if not m:
        return -1.0
    year = int(m.group(1))
    return year * 10 + _SEASON_ERA_OFFSET.get(m.group(2).upper(), 0)


# The app is a rolling recent-runway window, not a growing archive: keep only
# collections whose show was presented within the last FASHION_RECENT_MONTHS
# months, and prune the rest (see run_fashion_prune_old + its scheduled job).
# 4 months to keep R2 storage under the free 10 GB with every photo tagged
# and re-hosted full-res.
FASHION_RECENT_MONTHS = int(os.environ.get("FASHION_RECENT_MONTHS", "4"))
# An undated collection (season didn't parse) that also hasn't been
# re-scraped in this many days is treated as stale cruft and pruned — it
# would otherwise be exempt from the window prune forever.
_UNDATED_STALE_DAYS = int(os.environ.get("FASHION_UNDATED_STALE_DAYS", "21"))


def _min_recent_season_rank(months: int | None = None, now: "datetime | None" = None) -> float:
    """The season_rank floor for "shown within the last `months` months".

    Ready-to-wear seasons are presented on a fixed ~quarterly calendar, so
    the cutoff CALENDAR month maps cleanly to whichever season was on the
    runway then:
      Feb-Apr -> Fall/Winter  (code year = that year)
      May-Jul -> Resort        (code year = next year)
      Aug-Oct -> Spring/Summer (code year = next year)
      Nov-Jan -> Pre-Fall      (code year = next year)
    Anything with season_rank >= this value is inside the window; a doc whose
    season doesn't parse (rank -1) is never pruned by rank alone.
    """
    months = FASHION_RECENT_MONTHS if months is None else months
    now = now or datetime.now(timezone.utc)
    total = now.year * 12 + (now.month - 1) - months
    cy, cm = divmod(total, 12)
    cm += 1
    if cm <= 4:
        return cy * 10 + _SEASON_ERA_OFFSET["AW"]
    if cm <= 7:
        return (cy + 1) * 10 + _SEASON_ERA_OFFSET["RESORT"]
    if cm <= 10:
        return (cy + 1) * 10 + _SEASON_ERA_OFFSET["SS"]
    return (cy + 1) * 10 + _SEASON_ERA_OFFSET["PREFALL"]


def _season_merge_code(season: str) -> str:
    """Canonical spelling of a season code, for both cross-source matching
    and display -- always fashion-press's richer year-span AW form
    ('2026-27AW'), even for a firstview-sourced show that only ever wrote
    the single-year form ('2026AW'). Both name the same real show (see
    _season_rank's docstring above), so collapsing them to one shared
    spelling is what lets a fashion-press and a firstview listing of the
    same show actually match in _fashion_merge_key -- before this, a
    firstview "Fall/Winter 2026" show and fashion-press's own listing of
    the identical show never merged, because "2026AW" != "2026-27AW" as
    plain strings. It's also what stops the feed's season filter from
    showing "2026-27 Sonbahar/Kış" and "2026 Sonbahar/Kış" side by side as
    if they were two different seasons.

    SS/RESORT/PREFALL are already single-year on both sides, so this only
    ever rewrites AW codes; anything already in span form, or unparseable,
    passes through unchanged (idempotent either way).
    """
    m = _SEASON_RANK_RE.match((season or "").strip())
    if not m:
        return (season or "").strip()
    year, era = m.group(1), m.group(2).upper()
    if era == "AW":
        next_yy = f"{(int(year) + 1) % 100:02d}"
        return f"{year}-{next_yy}AW"
    return f"{year}{era}"


async def _resolve_brand_names(raw_items: list) -> None:
    """Upgrade fashion-press items' brand_tr/title_tr from pykakasi's
    romanized guess (see fashion_scraper._romanize_ja) to the brand's real
    Latin-script name, via a cached Gemini text lookup — in place, on the
    raw items list, before _group_fashion_items runs (brand_tr feeds the
    merge key, so this has to happen first; a consistent resolved name
    across items also keeps different scrapes of the same collection
    merging together, the same invariant the old translate-based code
    depended on).

    Only fashion-press items carry a brand_ja (the original Japanese brand
    string) to look up — firstview items already have real English brand_tr
    text from their own parser and are left untouched. Results are cached
    in db.brand_names, keyed by brand_ja, so a given brand is only ever sent
    to Gemini once no matter how many collections/scrapes reference it
    (including a brand Gemini couldn't resolve — that's cached too, so a
    backfill re-scrape doesn't keep re-asking about it).

    Safe to call even when gemini_client.ENABLED is False (GEMINI_API_KEY
    not configured) — it's then a no-op and every item keeps its pykakasi
    fallback value, exactly as before this function existed.
    """
    if not gemini_client.ENABLED:
        return

    candidates: dict = {}
    for r in raw_items:
        brand_ja = (r.get("brand_ja") or "").strip()
        if brand_ja and r.get("source") == "fashion-press":
            candidates.setdefault(brand_ja, []).append(r)
    if not candidates:
        return

    resolved: dict = {}
    to_lookup = []
    # A cached NULL ("NONE" / low confidence) is worth re-asking occasionally
    # in case a later model gets it; a cached NULL from a quota-exhausted run
    # never got written at all now (see _lookup below), so this is just the
    # genuine-miss retry cadence.
    stale_before = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    for brand_ja in candidates:
        cached = await db.brand_names.find_one({"_id": brand_ja})
        if cached is None:
            to_lookup.append(brand_ja)
        elif cached.get("brand_tr"):
            resolved[brand_ja] = cached["brand_tr"]
        elif (cached.get("resolved_at") or "") < stale_before:
            to_lookup.append(brand_ja)

    if to_lookup:
        sem = asyncio.Semaphore(5)

        async def _lookup(brand_ja: str) -> None:
            async with sem:
                try:
                    name = await asyncio.to_thread(gemini_client.resolve_brand_name, brand_ja)
                except gemini_client.GeminiUnavailable:
                    return  # couldn't ask (quota/network) — don't cache, retry next scrape
            await db.brand_names.update_one(
                {"_id": brand_ja},
                {"$set": {"brand_tr": name, "resolved_at": datetime.now(timezone.utc).isoformat()}},
                upsert=True,
            )
            if name:
                resolved[brand_ja] = name

        await asyncio.gather(*(_lookup(b) for b in to_lookup))

    if not resolved:
        return

    upgraded = 0
    for brand_ja, items in candidates.items():
        new_brand = resolved.get(brand_ja)
        if not new_brand:
            continue
        for r in items:
            old_brand = r.get("brand_tr") or ""
            r["brand_tr"] = new_brand
            # title_tr is set equal to brand_tr in fashion_scraper's
            # _finish_items (fashion-press items have no other title text
            # of their own), so it upgrades the same way.
            if r.get("title_tr") == old_brand:
                r["title_tr"] = new_brand
            upgraded += 1
    logger.info(
        "Fashion scrape: resolved %d brand name(s) via Gemini, applied to %d item(s)",
        len(resolved), upgraded,
    )


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
            im = Image.open(io.BytesIO(content))
            # phash only needs a 32x32 — let the JPEG decoder downscale
            # while reading so a big runway photo isn't a full bitmap in RAM.
            if (im.format or "").upper() == "JPEG":
                im.draft("L", (128, 128))
            h = imagehash.phash(im)
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


def _looks_better_text(a: str, b: str) -> str:
    """Pick the better of two candidate strings for the same field, when
    merging two scrapes of what turns out to be the same source collection
    (see _group_fashion_items). The free translate endpoint occasionally
    hands back the original Japanese untranslated on one pass but not
    another, so prefer whichever isn't still Japanese; if both (or
    neither) are, prefer the longer/more complete one.
    """
    a, b = a or "", b or ""
    a_jp = fashion_scraper._looks_japanese(a)
    b_jp = fashion_scraper._looks_japanese(b)
    if a_jp and not b_jp:
        return b
    if b_jp and not a_jp:
        return a
    return a if len(a) >= len(b) else b


# Which category "wins" when the same real-world show turns out to be
# filed under more than one (see _group_fashion_items) — fashion-press
# lists some shows as a combined "Kadın & Erkek" (women+men) collection,
# which gets scraped once per gender search page it's listed on. "women"
# winning is an arbitrary but stable choice, not a judgment about which
# listing is more "correct".
_FASHION_CATEGORY_PRIORITY = {"women": 0, "men": 1, "haute-couture": 2}


def _group_fashion_items(raw_items: list) -> tuple:
    """Group same brand+season+category across sources into one collection.

    Pure, in-memory, no network calls — safe to run synchronously up front.
    Each group's photo list still needs _finalize_fashion_group() (phash
    dedup + R2 caching) before it's ready to save; that part is what's slow,
    so it's kept separate and run with bounded concurrency per group instead
    of sequentially for the whole batch (see run_fashion_scrape).

    A second pass then folds together groups that are actually the same
    real-world collection under a different identity — the two cases seen
    in practice are a fashion-press "Kadın & Erkek" (combined women+men)
    show, scraped once from the women listing and once from the men
    listing (same page, different category), and a title whose JA->TR
    translation drifted between scrapes (came back untranslated once),
    landing under a different brand_tr and therefore a different merge
    key. Both share the same source `url`, which is what this pass keys
    on to catch them. Returns (groups, obsolete_keys) — obsolete_keys are
    merge keys that existed before this pass but got folded into another
    group, so the caller must delete any DB document still sitting under
    one of those keys or the old duplicate lingers forever.
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
                "title_ja": item.get("title_ja") or "",
                "season": item["season"],
                "season_label": item["season_label"],
                "season_rank": _season_rank(item["season"]),
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

    by_url: dict = {}
    for key, g in groups.items():
        if g["url"]:
            by_url.setdefault(g["url"], []).append(key)

    obsolete: set = set()
    for url, keys in by_url.items():
        if len(keys) <= 1:
            continue
        # Sorted for a deterministic pick — otherwise which key "wins" could
        # flip between daily scrapes and needlessly churn the DB doc id.
        canonical_key, *dup_keys = sorted(keys)
        canonical = groups[canonical_key]
        for dup_key in dup_keys:
            other = groups.pop(dup_key)
            obsolete.add(dup_key)
            canonical["images"].extend(other["images"])
            for s in other["sources"]:
                if s not in canonical["sources"]:
                    canonical["sources"].append(s)
            if other["city"] and not canonical["city"]:
                canonical["city"] = other["city"]
            if canonical["fp_source_id"] is None:
                canonical["fp_source_id"] = other["fp_source_id"]
            canonical["brand_tr"] = _looks_better_text(canonical["brand_tr"], other["brand_tr"])
            canonical["title_tr"] = _looks_better_text(canonical["title_tr"], other["title_tr"])
            if not canonical["season"] and other["season"]:
                canonical["season"] = other["season"]
                canonical["season_label"] = other["season_label"]
                canonical["season_rank"] = other.get("season_rank", _season_rank(other["season"]))
            if _FASHION_CATEGORY_PRIORITY.get(other["category"], 9) < _FASHION_CATEGORY_PRIORITY.get(
                canonical["category"], 9
            ):
                canonical["category"] = other["category"]

    # Global newest-first ordering for the whole feed / look search: season
    # DESC, then the source's own collection id DESC (higher = added more
    # recently — a reliable recency proxy). Stamped as feed_seq so a doc's
    # position is a single number to sort on, and consistent with
    # _backfill_feed_seq (which seeds the same order for docs no scrape has
    # re-listed yet).
    result = list(groups.values())
    result.sort(key=_source_collection_id, reverse=True)
    result.sort(key=lambda g: (g.get("season_rank") if g.get("season_rank") is not None else -1), reverse=True)
    for i, g in enumerate(result):
        g["feed_seq"] = i
    return result, obsolete


def _finalize_fashion_group(g: dict) -> dict:
    """Resolve one merge group's final photo list: drop cross-source
    duplicate shots (phash) then re-host each photo on R2. Blocking/network
    work — always called via asyncio.to_thread, bounded by a semaphore so
    only a handful of groups do this at once (see run_fashion_scrape).
    """
    seen: set = set()
    unique_urls = [u for u in g["images"] if not (u in seen or seen.add(u))]
    if len(g["sources"]) > 1:
        unique_urls = _dedupe_images_phash(unique_urls)
    thumb_urls = list(unique_urls)
    if image_store.ENABLED:
        # Re-host each photo on our own R2 bucket so the app serves it
        # instantly instead of live-proxying the source site per view, and
        # also generate a small thumbnail alongside it for grid/list display
        # (see image_store._THUMB_MAX_WIDTH) -- grids were downloading full
        # runway-resolution photos just to paint a ~180px tile, which is
        # what made the feed feel slow/blank on first load. No-op (returns
        # the original URL for both) until R2 is configured.
        cached = image_store.cache_images_with_thumb(unique_urls)
        unique_urls = [full for full, _ in cached]
        thumb_urls = [thumb for _, thumb in cached]
    g["images"] = unique_urls
    g["image"] = unique_urls[0] if unique_urls else None
    g["images_thumb"] = thumb_urls
    g["image_thumb"] = thumb_urls[0] if thumb_urls else None
    return g


_FINALIZE_TIMEOUT_S = 90
# How many collections' photo sets are downloaded + PIL-processed + uploaded
# at once. Each of those runs its own small pool inside image_store
# (_CACHE_WORKERS), so real concurrent image decodes ≈ this × that. Kept
# low: the box OOM-killed itself mid-backfill at 8. Env-tunable.
_IMG_WORK_CONCURRENCY = int(os.environ.get("FASHION_IMG_CONCURRENCY", "3"))


async def _finalize_and_save_group(g: dict, sem: asyncio.Semaphore, now_iso: str) -> bool:
    """Finish one merge group and upsert it immediately — so collections
    show up in the feed as each one finishes instead of only after every
    single one of the ~90+ groups in a scrape is done. `sem` caps how many
    of these run at once (each is a blocking thread doing network I/O).

    Wrapped in a hard wall-clock timeout (_FINALIZE_TIMEOUT_S): `requests`'
    own `timeout=` (used throughout _dedupe_images_phash/image_store) only
    resets on each byte received, so a source server that trickles data
    very slowly — rather than dropping the connection outright — can stall
    a download indefinitely without ever raising its own timeout error.
    Seen live on a since-Jan-2026 backfill: 906 of 908 groups finished in
    ~2 hours, then the last 2 sat stuck for 5+ hours with zero log output
    (no exception, because nothing ever technically timed out). This outer
    `asyncio.wait_for` guarantees the whole scrape can always finish within
    a bounded time regardless of what a single misbehaving connection does
    — the abandoned group just gets skipped and naturally retried on the
    next scrape. (The orphaned worker thread itself can't be force-killed
    and keeps running until its underlying call eventually gives up on its
    own; harmless — it holds no lock afterward and is thrown away.)
    """
    ok = False
    try:
        async with sem:
            try:
                finalized = await asyncio.wait_for(
                    asyncio.to_thread(_finalize_fashion_group, g), timeout=_FINALIZE_TIMEOUT_S
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "Fashion scrape: group %s timed out finalizing (>%ds, likely a "
                    "stalled download) — skipping, will retry next scrape",
                    g.get("source_id"), _FINALIZE_TIMEOUT_S,
                )
                return False
        finalized["updated_at"] = now_iso
        await db.fashion.update_one(
            {"source_id": finalized["source_id"]},
            {"$set": finalized, "$setOnInsert": {"first_seen": now_iso}},
            upsert=True,
        )
        ok = True
    except Exception:
        logger.exception("Fashion scrape: group %s failed to finalize/save", g.get("source_id"))
    finally:
        # Counts every attempt (success or fail) so a progress indicator
        # ("N / total taranıyor") advances even past a handful of failures.
        await db.meta.update_one({"_id": "fashion"}, {"$inc": {"groups_done": 1}})
    return ok


#  The fashion-press.net season slugs, and the firstview.com show-years, that
# between them cover "everything shown since January 2026": ready-to-wear
# runway/lookbook seasons are announced roughly 6 months ahead of their name,
# so a collection actually shown Jan-Sep 2026 carries the season name
# "2026-27 Autumn/Winter" (shown Feb/Mar 2026) or "2027 Spring/Summer" (shown
# Sept/Oct 2026 — the latter still ongoing as of this writing, so a backfill
# run today won't yet have all of it; re-running later picks up the rest).
# 2027-28aw / show-year 2027 are listed ahead of time: their listings 404 /
# come back empty until those shows happen (handled gracefully), and then
# a backfill starts collecting them without a code change.
BACKFILL_FASHION_PRESS_SEASONS = ("2026-27aw", "2027ss", "2027-28aw")
BACKFILL_FIRSTVIEW_YEARS = (2026, 2027)

# Sites a regular (non-backfill) scrape always hits. _check_scrape_yield
# watches each one's item count run-over-run and warns when it craters —
# the signature of a scraper whose CSS selectors / URL patterns broke
# against a site redesign (how the firstview season-format change went
# unnoticed for weeks, only ever logged, never surfaced in the app).
async def _bump_usage_counter(kind: str, n: int = 1) -> None:
    """H1: monthly usage counters (photos tagged, R2 uploads) — NOT real
    billing (we have no Google Cloud / Cloudflare billing API access), just
    what our own backend actually did this month. Keyed per-month so it
    resets naturally without a cron job."""
    if n <= 0:
        return
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    await db.meta.update_one({"_id": f"usage:{month}"}, {"$inc": {kind: n}}, upsert=True)


_SCRAPE_YIELD_SITES = ("fashion-press", "firstview")


async def _check_scrape_yield(by_source: dict) -> list:
    """Fold this run's per-site counts into a rolling baseline (meta doc
    `fashion_scrape_yield`) and return a list of plain-language warnings for
    any site whose yield just collapsed vs. its recent norm. A run that
    already looks broken is NOT folded into the baseline, so the alarm keeps
    tripping instead of quietly redefining "normal" as zero."""
    doc = await db.meta.find_one({"_id": "fashion_scrape_yield"}) or {}
    stats = dict(doc.get("sites") or {})
    warnings: list = []
    for site in _SCRAPE_YIELD_SITES:
        got = int(by_source.get(site, 0))
        s = stats.get(site) or {}
        ewma = float(s.get("ewma", 0.0))
        samples = int(s.get("samples", 0))
        if samples >= 3 and ewma >= 10 and got < max(2, 0.2 * ewma):
            warnings.append(
                f"{site}: bu taramada yalnızca {got} kayıt geldi (son ortalama ~{round(ewma)}). "
                f"Sitenin sayfa yapısı değişip kazıyıcı bozulmuş olabilir — kontrol edilmeli."
            )
        else:
            stats[site] = {
                "ewma": float(got) if samples == 0 else round(0.4 * got + 0.6 * ewma, 1),
                "samples": samples + 1,
            }
    await db.meta.update_one(
        {"_id": "fashion_scrape_yield"}, {"$set": {"sites": stats}}, upsert=True,
    )
    return warnings


async def run_fashion_scrape(reason: str = "manual", backfill: bool = False) -> dict:
    """Scrape runway collections (women / men / haute couture) from
    fashion-press.net and firstview.com (nowfashion.com temporarily disabled,
    see below), merging the same brand+season+category found across sources
    into one entry.

    Regular runs (`backfill=False`, the twice-weekly schedule and the manual
    "tara" button) only fetch each source's single "newest first" page —
    fast, and enough to catch new additions since the last run. `backfill=True`
    (see /admin/fashion-backfill) instead walks every source's full
    pagination for the seasons/year defined above, to pull in everything
    published since January 2026 — not just what's still on page 1 by the
    time this runs. It's slower (many more requests) but only needs to run
    once; afterwards the regular scrape keeps things current.
    """
    if _fashion_lock.locked():
        return {"status": "already_running"}
    async with _fashion_lock:
        logger.info("Fashion scrape started (%s, backfill=%s)", reason, backfill)
        started = datetime.now(timezone.utc)
        raw_items: list = []

        # Build the list of sources to hit up front (instead of firing each
        # collect() inline) so the total is known *before* any fetching
        # starts — that's what lets the "scraping" meta doc below report
        # real progress through this whole phase. A plain backfill run can
        # spend 30-60+ minutes just fetching listings/galleries before a
        # single collection is ready to save; without this, the Settings
        # screen showed nothing at all until that entire phase finished,
        # which looked identical to the button having silently failed.
        if backfill:
            tasks = []
            for season in BACKFILL_FASHION_PRESS_SEASONS:
                for gender in ("women", "men"):
                    tasks.append((
                        f"fashion-press/{gender}/{season}",
                        fashion_scraper.scrape_collections, (3000, gender, season),
                    ))
            # Deep unfiltered pass too — Resort / Pre-Fall / Cruise have no
            # dedicated season slug on fashion-press, so they only appear in
            # the newest-first listing (which paginates for a big limit).
            for gender in ("women", "men"):
                tasks.append((
                    f"fashion-press/{gender}/latest-deep",
                    fashion_scraper.scrape_collections, (600, gender),
                ))
            tasks.append(("fashion-press/haute-couture", fashion_scraper.scrape_haute_couture, (500, 200)))
            for year in BACKFILL_FIRSTVIEW_YEARS:
                for cat in FASHION_CATEGORIES:
                    tasks.append((
                        f"firstview/{cat}/{year}",
                        firstview_scraper.scrape_category, (cat, 3000, year, 60, 6),
                    ))
        else:
            tasks = [
                ("fashion-press/women", fashion_scraper.scrape_collections, (40, "women")),
                ("fashion-press/men", fashion_scraper.scrape_collections, (40, "men")),
                ("fashion-press/haute-couture", fashion_scraper.scrape_haute_couture, (40,)),
                # nowfashion.com is disabled for now: it blocks direct requests (403) and
                # also fails through the plain ScraperAPI proxy (500), which points to a
                # JS-based bot challenge — fixable with ScraperAPI's render=true mode, but
                # that costs ~10x credits more per request, so left off pending a decision.
                # *[(f"nowfashion/{cat}", nowfashion_scraper.scrape_category, (cat, 30)) for cat in FASHION_CATEGORIES],
            ]
            tasks += [(f"firstview/{cat}", firstview_scraper.scrape_category, (cat, 30)) for cat in FASHION_CATEGORIES]

        start_iso = started.isoformat()
        await db.meta.update_one(
            {"_id": "fashion"},
            {
                "$set": {
                    "scraping": True,
                    "phase": "collecting",
                    "scrape_started_at": start_iso,
                    "reason": reason,
                    "sources_total": len(tasks),
                    "sources_done": 0,
                    "groups_total": 0,
                    "groups_done": 0,
                }
            },
            upsert=True,
        )

        for label, fn, args in tasks:
            try:
                got = await asyncio.to_thread(fn, *args)
                raw_items.extend(got or [])
            except Exception:
                logger.exception("Fashion scrape source failed (%s)", label)
            await db.meta.update_one({"_id": "fashion"}, {"$inc": {"sources_done": 1}})

        # Drop anything already outside the rolling window BEFORE the
        # expensive finalize / R2-cache / tag steps — a backfill's season
        # slugs and firstview year filter still pull in older shows that the
        # nightly prune would just delete hours later. Items whose season
        # doesn't parse (rank < 0) pass through, same rule as the prune.
        _floor = _min_recent_season_rank()
        _pre = len(raw_items)
        raw_items = [
            r for r in raw_items
            if (lambda rk: rk < 0 or rk >= _floor)(_season_rank(r.get("season") or ""))
        ]
        if _pre != len(raw_items):
            logger.info(
                "Fashion scrape (%s): dropped %d raw item(s) older than the %d-month window",
                reason, _pre - len(raw_items), FASHION_RECENT_MONTHS,
            )

        by_source: dict = {}
        for r in raw_items:
            by_source[r.get("source", "?")] = by_source.get(r.get("source", "?"), 0) + 1
        logger.info("Fashion scrape (%s): %d raw items collected (%s)", reason, len(raw_items), by_source)

        # Broken-scraper alarm (regular scrapes only — backfill volume swings
        # too wildly for a baseline). Surfaces in the job-run history below.
        scrape_warnings: list = []
        if not backfill:
            try:
                scrape_warnings = await _check_scrape_yield(by_source)
                for w in scrape_warnings:
                    logger.warning("Fashion scrape (%s): %s", reason, w)
            except Exception:
                logger.exception("Fashion scrape (%s): yield check failed", reason)

        try:
            await _resolve_brand_names(raw_items)
        except Exception:
            # Best-effort upgrade only — every item already has its pykakasi
            # fallback value from fashion_scraper, so a failure here should
            # never stop the scrape itself.
            logger.exception("Fashion scrape (%s): brand-name resolution failed", reason)

        now_iso = datetime.now(timezone.utc).isoformat()
        try:
            groups, obsolete_keys = _group_fashion_items(raw_items)
            if obsolete_keys:
                # These merge keys used to be their own saved collection but
                # just got folded into another one above (see
                # _group_fashion_items) — delete the old doc so the same
                # show doesn't keep showing up twice in the feed.
                result = await db.fashion.delete_many({"source_id": {"$in": list(obsolete_keys)}})
                if result.deleted_count:
                    logger.info(
                        "Fashion scrape (%s): removed %d duplicate collection(s) merged into another entry",
                        reason, result.deleted_count,
                    )
            await db.meta.update_one(
                {"_id": "fashion"},
                {
                    "$set": {
                        "scraping": True,
                        "phase": "finalizing",
                        "groups_total": len(groups),
                        "groups_done": 0,
                    }
                },
                upsert=True,
            )
            # Finalize (phash dedup + R2 cache) and save each group as soon
            # as it's ready. Bounded concurrency (not 90+ at once, not one
            # at a time) — sequential per-photo network calls here are what
            # made a full scrape take 30-90+ minutes before, with nothing
            # visible in the app until every single group was done.
            sem = asyncio.Semaphore(_IMG_WORK_CONCURRENCY)
            results = await asyncio.gather(
                *(_finalize_and_save_group(g, sem, now_iso) for g in groups)
            )
            saved = sum(1 for ok in results if ok)
            # Belt-and-suspenders: also sweep the DB itself for duplicates
            # this scrape's own url-merge pass couldn't see (a doc saved by
            # an earlier scrape, before this dedup logic existed, whose
            # merge key this run's raw items no longer reproduce at all).
            await _dedupe_existing_fashion_docs()
            # Keep the feed a rolling recent window — drop anything now older
            # than FASHION_RECENT_MONTHS (also runs as its own nightly job).
            await run_fashion_prune_old()
            meta = {
                "last_scrape": now_iso,
                "item_count": await db.fashion.count_documents({}),
                "raw_item_count": len(raw_items),
                "reason": reason,
                "scraping": False,
                "groups_total": len(groups),
                "groups_done": saved,
            }
            await db.meta.update_one({"_id": "fashion"}, {"$set": meta}, upsert=True)
        except Exception as exc:
            logger.exception("Fashion scrape (%s): merge/save failed", reason)
            meta = {
                "last_scrape": now_iso,
                "item_count": await db.fashion.count_documents({}),
                "raw_item_count": len(raw_items),
                "reason": reason,
                "error": "merge_or_save_failed",
                "scraping": False,
            }
            await db.meta.update_one({"_id": "fashion"}, {"$set": meta}, upsert=True)
            await _record_job_run(
                "fashion_backfill" if backfill else "fashion_scrape",
                status="error", started_at=start_iso,
                detail=f"{len(raw_items)} ham kayıt tarandı ama kaydedilemedi",
                reason=f"Birleştirme/kayıt aşamasında hata: {type(exc).__name__}: {exc}"[:300],
            )
            return {"status": "error", **meta}

        logger.info(
            "Fashion scrape done (%s): %d raw items -> %d/%d groups saved, %.1fs",
            reason, len(raw_items), saved, len(groups),
            (datetime.now(timezone.utc) - started).total_seconds(),
        )
        saved_all = saved >= len(groups)
        reason_bits = []
        if not saved_all:
            reason_bits.append("Bazı koleksiyonlar zaman aşımı/hata nedeniyle kaydedilemedi; bir sonraki taramada tekrar denenecek.")
        reason_bits.extend(scrape_warnings)
        await _record_job_run(
            "fashion_backfill" if backfill else "fashion_scrape",
            status="ok" if (saved_all and not scrape_warnings) else "partial",
            started_at=start_iso, done=saved, total=len(groups),
            detail=f"{saved}/{len(groups)} koleksiyon kaydedildi ({len(raw_items)} ham kayıt)",
            reason=" · ".join(reason_bits),
        )
        return {"status": "ok", **meta}


async def _seed_fashion_if_empty():
    count = await db.fashion.count_documents({})
    if count == 0:
        logger.info("Fashion feed empty — running initial fashion scrape in background.")
        asyncio.create_task(_run_tracked("fashion_scrape", run_fashion_scrape("initial_seed")))
    else:
        logger.info("Fashion feed present: %d items.", count)


async def _backfill_fashion_if_needed():
    """One-time: pull everything since January 2026 (run_fashion_scrape's
    `backfill=True` path), not just whatever was on each source's front page
    the day the regular scrape happened to run. Guarded by a marker doc in
    `meta` so this only ever fires once — a later restart/redeploy won't
    kick it off again. (The Settings screen's "2026 Ocak'tan İtibaren
    Tümünü Tara" button / POST /admin/fashion-backfill runs the same thing
    on demand, e.g. to pick up the rest of 2027SS once more of it airs — that
    path doesn't touch this marker, so it's always available regardless.)
    """
    marker = await db.meta.find_one({"_id": "fashion_backfill_2026"})
    if marker and marker.get("done"):
        return
    logger.info("Fashion backfill (everything since Jan 2026) hasn't run yet — starting it in the background.")
    await db.meta.update_one(
        {"_id": "fashion_backfill_2026"},
        {"$set": {"started_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )

    async def _run():
        result = await run_fashion_scrape("auto_backfill_2026", backfill=True)
        if result.get("status") == "already_running":
            # Something else (the regular scrape, a manual trigger) was
            # already running at startup — don't mark this done, so it's
            # retried on the next restart instead of being skipped forever.
            logger.info("Fashion backfill: deferred, another scrape was already running.")
            return
        await db.meta.update_one(
            {"_id": "fashion_backfill_2026"},
            {"$set": {"done": True, "finished_at": datetime.now(timezone.utc).isoformat()}},
            upsert=True,
        )

    asyncio.create_task(_run_tracked("fashion_backfill", _run()))


async def _migrate_fashion_schema():
    """One-time cleanup: drop leftover documents from before the multi-source
    merge system (this session's split of COZA into MadeIn + Fashion). Those
    were keyed by the raw fashion-press numeric id directly, carry no
    "sources" field (only ever set by _group_fashion_items), and can never be
    upserted-over again since the merge key format changed — so they'd
    otherwise sit forever as orphaned, stale, image-less entries mixed into
    the feed.
    """
    result = await db.fashion.delete_many({"sources": {"$exists": False}})
    if result.deleted_count:
        logger.info("Fashion: removed %d pre-migration legacy documents.", result.deleted_count)

    # firstview.com's collection pages used to carry "Brand - Season - Category"
    # in their <title> tag; as of 2026-09 that tag is just the generic site
    # title "firstVIEW" on every page (site markup change, see
    # firstview_scraper._parse_collection_page), so every firstview item
    # silently parsed with no real brand/season and collapsed into the same
    # few garbage documents, upserting over themselves forever instead of
    # ever accumulating real collections. Precise match on the exact
    # signature those garbage docs share (confirmed live: exactly 3 of them,
    # one per category) so this can never touch a real, correctly-parsed
    # collection.
    result_fv = await db.fashion.delete_many(
        {"sources": ["firstview"], "brand_tr": "firstVIEW", "season": {"$in": ["", None]}}
    )
    if result_fv.deleted_count:
        logger.info(
            "Fashion: removed %d stale firstview placeholder document(s) "
            "(pre brand/season-parsing fix).", result_fv.deleted_count,
        )

    # One-time backfill for season_rank (added for the unified newest-first
    # feed sort) on any doc saved before this field existed, bounded by a
    # hard timeout: this runs inline in app startup, and Uvicorn won't
    # finish "startup complete" -- meaning the app serves NO requests at
    # all, not even login -- until the startup handler returns. A slow or
    # stuck DB round-trip here must never be able to take the whole app
    # down with it; a doc that misses this pass just sorts to the bottom
    # of "newest first" until the next startup or scrape touches it.
    try:
        await asyncio.wait_for(_backfill_season_rank(), timeout=20)
    except asyncio.TimeoutError:
        logger.warning("Fashion: season_rank backfill timed out (>20s) — skipping, will retry next startup.")
    except Exception:
        logger.exception("Fashion: season_rank backfill failed.")
    try:
        await asyncio.wait_for(_reparse_seasons_if_needed(), timeout=20)
    except asyncio.TimeoutError:
        logger.warning("Fashion: season re-parse timed out (>20s) — skipping, will retry next startup.")
    except Exception:
        logger.exception("Fashion: season re-parse failed.")
    try:
        flag = await db.meta.find_one({"_id": "feed_seq_migration_v2"})
        if not flag:
            await asyncio.wait_for(_backfill_feed_seq(), timeout=25)
            await db.meta.update_one({"_id": "feed_seq_migration_v2"}, {"$set": {"done_at": datetime.now(timezone.utc).isoformat()}}, upsert=True)
    except asyncio.TimeoutError:
        logger.warning("Fashion: feed_seq backfill timed out — skipping, will retry next startup.")
    except Exception:
        logger.exception("Fashion: feed_seq backfill failed.")
    try:
        # One-time: older code cached a quota-failed brand lookup as a
        # permanent NULL, so those brands were stuck on the raw pykakasi
        # romanization forever (e.g. "Rui • viton"). Drop the NULLs once so
        # the next scrape re-asks Gemini for them.
        flag = await db.meta.find_one({"_id": "brand_names_null_purge_v1"})
        if not flag:
            res = await db.brand_names.delete_many({"brand_tr": {"$in": [None, ""]}})
            await db.meta.update_one({"_id": "brand_names_null_purge_v1"}, {"$set": {"done_at": datetime.now(timezone.utc).isoformat()}}, upsert=True)
            logger.info("Fashion: cleared %d null brand-name cache entr(ies) for re-lookup.", res.deleted_count)
    except Exception:
        logger.exception("Fashion: brand-name null purge failed.")


async def _backfill_season_rank():
    stale = await db.fashion.find(
        {"season_rank": {"$exists": False}}, {"_id": 0, "source_id": 1, "season": 1}
    ).to_list(length=None)
    if stale:
        ops = [
            UpdateOne({"source_id": d["source_id"]}, {"$set": {"season_rank": _season_rank(d.get("season"))}})
            for d in stale
        ]
        await db.fashion.bulk_write(ops, ordered=False)
        logger.info("Fashion: backfilled season_rank on %d document(s).", len(stale))


def _source_collection_id(doc: dict) -> int:
    """The source site's own monotonically-increasing collection id (higher
    = added more recently). fashion-press stores it as fp_source_id;
    firstview's is the ?id= in the collection URL. 0 if neither is found."""
    fp = doc.get("fp_source_id")
    if fp is not None and str(fp).isdigit():
        return int(fp)
    m = re.search(r"[?&]id=(\d+)", doc.get("url") or "")
    return int(m.group(1)) if m else 0


async def _backfill_feed_seq():
    """(Re)assign feed_seq to EVERY doc so "newest first" isn't alphabetical
    until scrapes re-list them with a real listing position. Ranks by
    season DESC, then the source's own collection id DESC (a reliable
    recency proxy — unlike first_seen, which a full backfill stamps
    uniformly). A later scrape overwrites the newest docs with their true
    listing index."""
    docs = await db.fashion.find(
        {}, {"_id": 0, "source_id": 1, "season_rank": 1, "fp_source_id": 1, "url": 1},
    ).to_list(length=None)
    if not docs:
        return
    docs.sort(key=_source_collection_id, reverse=True)
    docs.sort(key=lambda d: (d.get("season_rank") if d.get("season_rank") is not None else -1), reverse=True)
    ops = [
        UpdateOne({"source_id": d["source_id"]}, {"$set": {"feed_seq": i}})
        for i, d in enumerate(docs)
    ]
    await db.fashion.bulk_write(ops, ordered=False)
    logger.info("Fashion: (re)assigned feed_seq on %d document(s).", len(ops))


async def _reparse_seasons_if_needed():
    """Re-derive `season` for docs that have a Japanese title but no season —
    lets a fix to fashion_scraper._normalize_season (e.g. adding Resort /
    Pre-Fall) reach already-saved collections without a re-scrape. Only
    touches docs where the parser now produces something."""
    undated = await db.fashion.find(
        {"season": {"$in": ["", None]}, "title_ja": {"$nin": ["", None]}},
        {"_id": 0, "source_id": 1, "title_ja": 1},
    ).to_list(length=None)
    ops = []
    for d in undated:
        season = _season_merge_code(fashion_scraper._normalize_season(d.get("title_ja") or ""))
        if not season:
            continue
        ops.append(UpdateOne(
            {"source_id": d["source_id"]},
            {"$set": {
                "season": season,
                "season_label": fashion_scraper._season_label_tr(season),
                "season_rank": _season_rank(season),
            }},
        ))
    if ops:
        await db.fashion.bulk_write(ops, ordered=False)
        logger.info("Fashion: re-parsed season on %d previously-undated document(s).", len(ops))


async def _dedupe_existing_fashion_docs():
    """Sweep db.fashion for duplicate collections that are already saved,
    catching cases _group_fashion_items' url-merge pass can't: two docs
    that were never grouped together in the SAME scrape (e.g. one saved
    before this dedup logic existed, or a scrape where a translation only
    drifted on one of two runs) still won't get merged by that pass, since
    it only ever sees one scrape's raw items at a time. This runs against
    whatever is actually in the DB instead, so it catches those too —
    idempotent and cheap (the collection is small), safe to run on every
    startup and after every scrape.
    """
    docs = await db.fashion.find({}, {"_id": 0}).to_list(length=None)
    by_url: dict = {}
    for d in docs:
        if d.get("url"):
            by_url.setdefault(d["url"], []).append(d)

    merged_count = 0
    for url, group in by_url.items():
        if len(group) <= 1:
            continue
        # Keep the one with the most photos already cached (best signal of
        # "most complete"); ties broken by source_id for determinism.
        group.sort(key=lambda d: (-len(d.get("images") or []), d["source_id"]))
        canonical, *dups = group
        images = list(canonical.get("images") or [])
        seen = set(images)
        sources = list(canonical.get("sources") or [])
        brand_tr, title_tr = canonical.get("brand_tr", ""), canonical.get("title_tr", "")
        category = canonical.get("category", "")
        city = canonical.get("city")
        fp_source_id = canonical.get("fp_source_id")
        season, season_label = canonical.get("season"), canonical.get("season_label")
        for d in dups:
            for u in d.get("images") or []:
                if u not in seen:
                    seen.add(u)
                    images.append(u)
            for s in d.get("sources") or []:
                if s not in sources:
                    sources.append(s)
            if d.get("city") and not city:
                city = d["city"]
            if not fp_source_id:
                fp_source_id = d.get("fp_source_id")
            if not season and d.get("season"):
                season, season_label = d["season"], d.get("season_label")
            brand_tr = _looks_better_text(brand_tr, d.get("brand_tr", ""))
            title_tr = _looks_better_text(title_tr, d.get("title_tr", ""))
            if _FASHION_CATEGORY_PRIORITY.get(d.get("category", ""), 9) < _FASHION_CATEGORY_PRIORITY.get(category, 9):
                category = d["category"]

        await db.fashion.update_one(
            {"source_id": canonical["source_id"]},
            {
                "$set": {
                    "images": images,
                    "image": images[0] if images else None,
                    "sources": sources,
                    "brand_tr": brand_tr,
                    "title_tr": title_tr,
                    "category": category,
                    "city": city,
                    "fp_source_id": fp_source_id,
                    "season": season,
                    "season_label": season_label,
                    "season_rank": _season_rank(season),
                }
            },
        )
        dup_ids = [d["source_id"] for d in dups]
        await db.fashion.delete_many({"source_id": {"$in": dup_ids}})
        merged_count += len(dup_ids)

    if merged_count:
        logger.info("Fashion: merged %d duplicate collection(s) already sitting in the DB.", merged_count)


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


@api.get("/admin/gemini-check")
async def admin_gemini_check(admin: Annotated[dict, Depends(require_admin)]):
    """Fire one tiny live call per configured GEMINI_API_KEYS entry and
    report which work. Never returns key material (position + 4-char tail
    only). Blocking HTTP, so run it off the event loop.

    `verdict` is the bottom line the user actually cares about — whether
    tagging will do anything right now — computed the same way as the
    Settings button's tag_state, so a "keys OK" grid never sits next to a
    "quota full" tagging result without an explanation."""
    res = await asyncio.to_thread(gemini_client.check_keys)
    res["verdict"] = await _tagging_readiness()
    return res


@api.get("/admin/gemini-models")
async def admin_gemini_models(admin: Annotated[dict, Depends(require_admin)]):
    """Probe a list of candidate Gemini models (against key 1) so the
    operator can see which still work and add them to GEMINI_MODELS — every
    extra working model is another free-tier daily quota bucket across the
    same keys. Read-only; slow-ish (one request per candidate)."""
    return await asyncio.to_thread(gemini_client.discover_models)


@api.get("/admin/usage")
async def admin_usage(admin: Annotated[dict, Depends(require_admin)]):
    """H1 + H2. H1 is deliberately NOT a real cost panel — we have no
    Google Cloud / Cloudflare billing API access, so putting a TL/USD
    figure here would just be a guess dressed up as a fact. This shows
    what our own backend actually did (this month's Gemini calls/photos
    tagged, total photos cached in R2) — check Google Cloud Console /
    Cloudflare's own dashboards for the real bill."""
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    usage_doc = await db.meta.find_one({"_id": f"usage:{month}"}, {"_id": 0}) or {}
    r2_count = (await db.fashion.aggregate([
        {"$group": {"_id": None, "n": {"$sum": {"$size": {"$ifNull": ["$images", []]}}}}},
    ]).to_list(length=1))
    users = await db.users.find({}, {"_id": 0, "password_hash": 0}).sort("name", 1).to_list(length=200)
    return {
        "month": month,
        "gemini_calls_this_month": usage_doc.get("gemini_calls", 0),
        "gemini_photos_tagged_this_month": usage_doc.get("gemini_photos_tagged", 0),
        "r2_photos_cached": (r2_count[0]["n"] if r2_count else 0),
        "collections": await db.fashion.count_documents({}),
        "users": [
            {"name": u.get("name") or "", "email": u.get("email") or "", "role": u.get("role") or "",
             "last_active": u.get("last_active")}
            for u in users
        ],
    }


@api.get("/admin/dashboard")
async def admin_dashboard(admin: Annotated[dict, Depends(require_admin)]):
    """Everything the admin panel needs in one call. Admin-only (viewers get
    403 via require_admin). Read-only; no live Gemini probe here — that stays
    behind its own button (/admin/gemini-check)."""
    cap = _TAG_MAX_PHOTOS_PER_DOC

    facet = (await db.fashion.aggregate([{"$facet": {
        "total": [{"$count": "n"}],
        "by_source": [
            {"$unwind": {"path": "$sources", "preserveNullAndEmptyArrays": True}},
            {"$group": {"_id": {"$ifNull": ["$sources", "?"]}, "n": {"$sum": 1}}},
            {"$sort": {"n": -1}},
        ],
        "by_season": [
            {"$match": {"season_label": {"$nin": ["", None]}}},
            {"$group": {"_id": "$season_label", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}}, {"$limit": 16},
        ],
        "by_category": [
            {"$group": {"_id": {"$ifNull": ["$category", "?"]}, "n": {"$sum": 1}}},
            {"$sort": {"n": -1}},
        ],
        "by_city": [
            {"$match": {"city": {"$nin": ["", None]}}},
            {"$group": {"_id": "$city", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}}, {"$limit": 12},
        ],
        "photos_by_source": [
            {"$project": {
                "n": {"$size": {"$ifNull": ["$images", []]}},
                # clamp: a mid-backfill re-scrape can leave more tags than
                # photos, which showed as >100% tagged in the UI.
                "t": {"$min": [
                    {"$size": {"$ifNull": ["$image_tags", []]}},
                    {"$min": [{"$size": {"$ifNull": ["$images", []]}}, cap]},
                ]},
                "src": {"$ifNull": [{"$arrayElemAt": ["$sources", 0]}, "?"]},
            }},
            {"$group": {
                "_id": "$src",
                "photos": {"$sum": "$n"},
                "tagged": {"$sum": "$t"},
                "taggable": {"$sum": {"$min": ["$n", cap]}},
            }},
            {"$sort": {"taggable": -1}},
        ],
        "health": [
            {"$project": {
                "n": {"$size": {"$ifNull": ["$images", []]}},
                "t": {"$size": {"$ifNull": ["$image_tags", []]}},
                "thumbs": {"$size": {"$ifNull": ["$images_thumb", []]}},
                "is_fp": {"$ne": [{"$ifNull": ["$fp_source_id", None]}, None]},
                "gallery_fetched": {"$ifNull": ["$gallery_fetched", False]},
                "rank": {"$ifNull": ["$season_rank", -1]},
            }},
            {"$group": {
                "_id": None,
                "single_photo": {"$sum": {"$cond": [{"$lte": ["$n", 1]}, 1, 0]}},
                "missing_thumbs": {"$sum": {"$cond": [{"$and": [{"$gt": ["$n", 0]}, {"$eq": ["$thumbs", 0]}]}, 1, 0]}},
                "untagged": {"$sum": {"$cond": [{"$lt": ["$t", {"$min": ["$n", cap]}]}, 1, 0]}},
                "fp_thin_cover": {"$sum": {"$cond": [
                    {"$and": ["$is_fp", {"$or": [{"$not": "$gallery_fetched"}, {"$lte": ["$n", _THIN_GALLERY_MAX]}]}]}, 1, 0]}},
                "older_than_window": {"$sum": {"$cond": [
                    {"$and": [{"$gte": ["$rank", 0]}, {"$lt": ["$rank", _min_recent_season_rank()]}]}, 1, 0]}},
                "undated": {"$sum": {"$cond": [{"$lt": ["$rank", 0]}, 1, 0]}},
            }},
        ],
    }}]).to_list(1))[0]

    def _pairs(rows):
        return [{"label": (r["_id"] if r["_id"] not in (None, "") else "?"), "count": r["n"]} for r in rows]

    fmeta = await db.meta.find_one({"_id": "fashion"}, {"_id": 0}) or {}
    smeta = await db.meta.find_one({"_id": "scrape"}, {"_id": 0}) or {}
    job_runs = ((await db.meta.find_one({"_id": "job_runs"}, {"_id": 0})) or {}).get("items", [])

    ph = {"photos": 0, "tagged": 0, "taggable": 0}
    for r in facet.get("photos_by_source", []):
        for k in ph:
            ph[k] += r.get(k, 0)

    jobs = []
    for j in scheduler.get_jobs():
        nrt = getattr(j, "next_run_time", None)
        jobs.append({"id": j.id, "next_run": nrt.isoformat() if nrt else None})

    users = await db.users.find(
        {}, {"_id": 0, "password_hash": 0, "id": 0}
    ).to_list(length=50)

    cors_rows = await asyncio.to_thread(image_store.cors_status) if hasattr(image_store, "cors_status") else []
    yield_meta = (await db.meta.find_one({"_id": "fashion_scrape_yield"}, {"_id": 0}) or {}).get("sites", {})

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "collections": {
            "total": (facet["total"][0]["n"] if facet.get("total") else 0),
            "by_source": _pairs(facet.get("by_source", [])),
            "by_season": _pairs(facet.get("by_season", [])),
            "by_category": _pairs(facet.get("by_category", [])),
            "by_city": _pairs(facet.get("by_city", [])),
        },
        "photos": {
            **ph,
            "by_source": [
                {"label": r["_id"] if r["_id"] not in (None, "") else "?",
                 "photos": r.get("photos", 0), "tagged": r.get("tagged", 0), "taggable": r.get("taggable", 0)}
                for r in facet.get("photos_by_source", [])
            ],
            "cap_per_collection": cap,
        },
        "health": (facet["health"][0] if facet.get("health") else {}),
        "window": {
            "recent_months": FASHION_RECENT_MONTHS,
            "last_prune": fmeta.get("last_prune"),
        },
        "tagging": {
            "running": bool(fmeta.get("scraping")) and fmeta.get("phase") in ("tagging_photos", "tagging_firstview"),
            "phase": fmeta.get("phase"),
            "run_done": fmeta.get("tags_done", 0),
            "run_total": fmeta.get("tags_total", 0),
        },
        # Recent-history log for every admin sweep/scrape (newest first) —
        # what ran, when, how far it got, and why if it didn't finish. See
        # _record_job_run; this is what survives after a live run stops.
        "job_runs": job_runs,
        "scrape": {
            "fashion_last": fmeta.get("last_scrape"),
            "fashion_running": bool(fmeta.get("scraping")),
            "fashion_phase": fmeta.get("phase"),
            "catalog_last": smeta.get("last_scrape"),
            "scheduled_jobs": jobs,
            # Raw per-phase counters for a live progress %.
            "progress": {
                "sources_done": fmeta.get("sources_done", 0),
                "sources_total": fmeta.get("sources_total", 0),
                "groups_done": fmeta.get("groups_done", 0),
                "groups_total": fmeta.get("groups_total", 0),
                "covers_done": fmeta.get("covers_done", 0),
                "covers_total": fmeta.get("covers_total", 0),
                "thumbs_done": fmeta.get("thumbs_done", 0),
                "thumbs_total": fmeta.get("thumbs_total", 0),
                "merge_done": fmeta.get("merge_done", 0),
                "merge_total": fmeta.get("merge_total", 0),
                "repair_done": fmeta.get("repair_done", 0),
                "repair_total": fmeta.get("repair_total", 0),
            },
        },
        "gemini": {
            "enabled": gemini_client.ENABLED,
            "key_count": len(getattr(gemini_client, "_KEYS", [])),
            "models": list(getattr(gemini_client, "_MODELS", [])),
            "batch": _TAG_BATCH,
        },
        "users": users,
        "system": {
            "db_name": os.environ["DB_NAME"],
            "sources": {
                "active": ["fashion-press.net", "firstview.com"],
                "disabled": [
                    {"name": "nowfashion.com",
                     "reason": "Bot koruması (HTTP 403 / JS challenge). Aşmak ScraperAPI render=true (~10x kredi) gerektirdiği için kapalı."},
                ],
                # Rolling per-site item-count baseline the broken-scraper
                # alarm compares against (see _check_scrape_yield).
                "yield_baseline": yield_meta,
            },
            "r2": {
                "enabled": image_store.ENABLED,
                "buckets": len(getattr(image_store, "_ACCOUNTS", [])),
                "hosts": sorted(getattr(image_store, "PUBLIC_HOSTNAMES", set())),
                "fullres_max_px": getattr(image_store, "_FULLRES_MAX_WIDTH", None),
                "cors": cors_rows,
            },
            "counts": {
                "fashion": await db.fashion.count_documents({}),
                "products": await db.products.count_documents({}),
                "origins": await db.origins.count_documents({}),
                "brand_names": await db.brand_names.count_documents({}),
                "favorites": await db.favorites.count_documents({}),
                "users": await db.users.count_documents({}),
            },
        },
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
    """Hosts the proxy will fetch from. Originally fashion-press.net only
    (see docstring below) — extended to firstview.com (our other live
    source) and our own R2 public host, since a photo that failed to cache
    to R2 (image_store.cache_image() falls back to the original URL on any
    error) still needs to load through here on web. R2 URLs themselves
    don't actually need proxying — see fashionImageUri() on the frontend,
    which now only routes fashion-press.net/firstview.com through this
    endpoint and loads our own CDN URLs directly.
    """
    hostname = (hostname or "").lower()
    if hostname == "fashion-press.net" or hostname.endswith(".fashion-press.net"):
        return True
    if hostname == "firstview.com" or hostname.endswith(".firstview.com"):
        return True
    if hostname in image_store.PUBLIC_HOSTNAMES:
        return True
    return False


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


_LOOKS_SORTS = {
    # feed_seq = position in the source's newest-first listing (0 = newest),
    # so within a season the most recently shown collection lands on top.
    "newest": [("season_rank", -1), ("feed_seq", 1), ("updated_at", -1), ("source_id", 1)],
    "oldest": [("season_rank", 1), ("feed_seq", -1), ("updated_at", 1), ("source_id", 1)],
    "updated": [("updated_at", -1), ("season_rank", -1), ("source_id", -1)],
}


@api.get("/fashion/collections")
async def fashion_collections(
    user: Annotated[dict, Depends(get_current_user)],
    season: Optional[str] = None,
    category: Optional[str] = None,
    city: Optional[str] = None,
    source: Optional[str] = None,
    brand: Optional[str] = None,
    sort: str = "newest",
    q: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(30, ge=1, le=60),
):
    """Runway collections (women/men/haute couture), aggregated from
    multiple sources (fashion-press.net + firstview.com) and merged by
    brand+season+category into a single feed.

    `sort`: newest (default, by which show ran most recently — see
    _season_rank), oldest, or updated (most recently (re-)scraped).
    `source`: "firstview" or "fashion-press" to show only collections that
    include that source (a merged doc lists both)."""
    query: dict = {}
    if season:
        query["season"] = season
    if category:
        query["category"] = category
    if city:
        query["city"] = city
    if source:
        query["sources"] = source
    if brand and brand.strip():
        # exact house match (case-insensitive) — for the brand page
        query["brand_tr"] = {"$regex": f"^{re.escape(brand.strip())}$", "$options": "i"}
    if q:
        qs = q.strip()
        query["$or"] = [
            {"brand_tr": {"$regex": re.escape(qs), "$options": "i"}},
            {"title_tr": {"$regex": re.escape(qs), "$options": "i"}},
        ]
    cursor = (
        db.fashion.find(query, {"_id": 0})
        .sort(_LOOKS_SORTS.get(sort, _LOOKS_SORTS["newest"]))
        .skip(skip)
        .limit(limit)
    )
    items = await cursor.to_list(length=limit)
    total = await db.fashion.count_documents(query)
    return {"items": items, "total": total, "skip": skip, "limit": limit}


_TREND_FACETS = ("item", "color", "material", "pattern")
_TREND_IGNORE = {"unknown", "none", "n/a"}


@api.get("/fashion/trends")
async def fashion_trends(season: str, user: Annotated[dict, Depends(get_current_user)]):
    """B2: "Trend özeti metni" — the most common item/color/material/pattern
    words tagged across every collection of one season, for the frontend to
    weave into a sentence (no Gemini call: this is a straight count over
    already-tagged data, not something that needs generation)."""
    if not season:
        raise HTTPException(400, "season gerekli.")
    match = {"season": season, "image_tags": {"$exists": True, "$ne": []}}
    facet_stage = {
        facet: [
            {"$match": {f"image_tags.{facet}": {"$nin": list(_TREND_IGNORE)}}},
            {"$group": {"_id": f"$image_tags.{facet}", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}},
            {"$limit": 5},
        ]
        for facet in _TREND_FACETS
    }
    pipeline = [
        {"$match": match},
        {"$project": {"image_tags": 1}},
        {"$unwind": "$image_tags"},
        {"$facet": facet_stage},
    ]
    result = await db.fashion.aggregate(pipeline).to_list(length=1)
    facets = result[0] if result else {}
    collections = await db.fashion.count_documents(match)
    return {
        "season": season,
        "collections": collections,
        **{
            f"top_{facet}": [
                {"value": row["_id"], "label_tr": fashion_tag_map.tag_label_tr(facet, row["_id"]), "count": row["n"]}
                for row in facets.get(facet, [])
            ]
            for facet in _TREND_FACETS
        },
    }


@api.get("/fashion/brands")
async def fashion_brands_index(user: Annotated[dict, Depends(get_current_user)]):
    """C1: A–Z brand index — every distinct brand with a collection count
    and a cover photo (its most recent collection's cover)."""
    rows = await db.fashion.aggregate([
        {"$match": {"brand_tr": {"$nin": ["", None]}}},
        {"$sort": {"season_rank": -1}},
        {"$group": {
            "_id": "$brand_tr", "n": {"$sum": 1},
            "cover": {"$first": "$image_thumb"}, "cover_full": {"$first": "$image"},
        }},
        {"$sort": {"_id": 1}},
    ]).to_list(length=5000)
    return {"items": [
        {"name": r["_id"], "count": r["n"], "cover": r.get("cover") or r.get("cover_full")}
        for r in rows
    ]}


async def _finish_user_photo(user: dict, full_url: str, thumb_url: str) -> dict:
    """A5: cache one externally-added photo as its own tiny synthetic
    collection and auto-tag it, so it's searchable in Lens exactly like a
    scraped photo. season_rank is pinned absurdly high (always "newest")
    and fp_source_id gets a non-null placeholder specifically so
    run_fashion_prune_old's age window and run_fashion_clean_cruft's
    thin-fp-collection rule never sweep it up; category is deliberately
    NOT one of women/men/haute-couture so it stays out of the main
    Fashion tab feed (Lens has no such filter, so it's still findable
    there with no gender selected)."""
    tag = None
    if gemini_client.ENABLED:
        tag = await asyncio.to_thread(gemini_client.tag_image, full_url)
        if tag:
            await _bump_usage_counter("gemini_calls")
    now = datetime.now(timezone.utc).isoformat()
    source_id = f"user-{uuid.uuid4().hex[:12]}"
    doc = {
        "source_id": source_id,
        "url": full_url,
        "image": full_url,
        "image_thumb": thumb_url or full_url,
        "images": [full_url],
        "images_thumb": [thumb_url or full_url],
        "image_tags": [tag] if tag else [],
        "brand_tr": user.get("name") or "Kişisel",
        "title_tr": "Kişisel ekleme",
        "season": "",
        "season_label": "",
        "season_rank": 999999,
        "category": "user_upload",
        "sources": ["user"],
        "fp_source_id": "user_upload",
        "added_by": user["id"],
        "created_at": now,
        "updated_at": now,
    }
    await db.fashion.insert_one(doc)
    return {"source_id": source_id, "tagged": tag is not None}


@api.post("/fashion/user-photos")
async def add_user_photo_by_url(body: AddUserPhotoBody, user: Annotated[dict, Depends(get_current_user)]):
    """A5 (link path)."""
    if not image_store.ENABLED:
        raise HTTPException(503, "Fotoğraf deposu şu anda kullanılamıyor.")
    url = body.image_url.strip()
    full_url, thumb_url = await asyncio.to_thread(image_store.cache_image_with_thumb, url)
    if full_url == url:
        # cache_image_with_thumb degrades to (source, source) on failure.
        raise HTTPException(400, "Fotoğraf indirilemedi. Bağlantıyı kontrol et.")
    return await _finish_user_photo(user, full_url, thumb_url)


@api.post("/fashion/user-photos/upload")
async def add_user_photo_by_upload(
    user: Annotated[dict, Depends(get_current_user)], file: UploadFile = File(...),
):
    """A5 (device upload — web only on the frontend today, see the client
    note in fashion-frontend/src/api/client.ts)."""
    if not image_store.ENABLED:
        raise HTTPException(503, "Fotoğraf deposu şu anda kullanılamıyor.")
    content = await file.read()
    if not content:
        raise HTTPException(400, "Boş dosya.")
    if len(content) > 12 * 1024 * 1024:
        raise HTTPException(400, "Dosya çok büyük (12MB üzeri).")
    full_url, thumb_url = await asyncio.to_thread(
        image_store.cache_bytes_with_thumb, content, file.content_type or "image/jpeg", uuid.uuid4().hex,
    )
    if not full_url:
        raise HTTPException(400, "Yüklenemedi, tekrar dene.")
    return await _finish_user_photo(user, full_url, thumb_url)


# A gallery with this many photos or fewer is treated as suspiciously thin
# rather than trusted as final -- see fashion_collection_detail and
# run_fashion_cover_fix, both of which give a "gallery_fetched" doc this
# thin one more real attempt instead of skipping it forever.
_THIN_GALLERY_MAX = 2


def _tag_profile(image_tags: list, per_facet: int = 3) -> dict:
    """The few most common item/color/material words across a collection's
    photo tags — a cheap fingerprint for the "similar collections" match."""
    from collections import Counter
    counts = {"item": Counter(), "color": Counter(), "material": Counter()}
    for tg in image_tags or []:
        if not isinstance(tg, dict):
            continue
        for f in counts:
            v = (tg.get(f) or "").strip().lower()
            if v and v not in ("none", "n/a", "unknown", "plain", "solid"):
                counts[f][v] += 1
    return {f: [w for w, _ in c.most_common(per_facet)] for f, c in counts.items()}


@api.get("/fashion/collections/{source_id}/similar")
async def fashion_similar(source_id: str, user: Annotated[dict, Depends(get_current_user)]):
    """Up to 12 other collections that resemble this one — weighted by
    shared photo tags + same house + near season + same city."""
    src = await db.fashion.find_one(
        {"source_id": source_id},
        {"_id": 0, "brand_tr": 1, "season": 1, "season_rank": 1, "city": 1, "category": 1,
         "image_tags": {"$slice": 120}},
    )
    if not src:
        raise HTTPException(404, "Koleksiyon bulunamadı.")
    prof = _tag_profile(src.get("image_tags") or [])
    tag_words = {w for ws in prof.values() for w in ws}
    ors: list = []
    if src.get("brand_tr"):
        ors.append({"brand_tr": src["brand_tr"]})
    if src.get("season"):
        ors.append({"season": src["season"]})
    if src.get("city"):
        ors.append({"city": src["city"]})
    for f, ws in prof.items():
        if ws:
            ors.append({f"image_tags.{f}": {"$in": ws}})
    if not ors:
        return {"items": []}

    cands = await db.fashion.find(
        {"$and": [{"source_id": {"$ne": source_id}}, {"$or": ors}]},
        {"_id": 0, "source_id": 1, "brand_tr": 1, "season": 1, "season_label": 1, "season_rank": 1,
         "city": 1, "image": 1, "image_thumb": 1, "images": 1, "images_thumb": 1,
         "image_tags": {"$slice": 60}},
    ).limit(250).to_list(length=250)

    s_rank = src.get("season_rank")
    scored = []
    for c in cands:
        score = 0
        if src.get("brand_tr") and c.get("brand_tr") == src["brand_tr"]:
            score += 3
        if src.get("season") and c.get("season") == src["season"]:
            score += 2
        elif s_rank is not None and c.get("season_rank") is not None and abs(c["season_rank"] - s_rank) <= 1:
            score += 1
        if src.get("city") and c.get("city") == src["city"]:
            score += 1
        cprof = _tag_profile(c.get("image_tags") or [])
        cwords = {w for ws in cprof.values() for w in ws}
        score += min(4, len(tag_words & cwords))
        if score > 0:
            scored.append((score, c))
    scored.sort(key=lambda t: (t[0], t[1].get("season_rank") or -1), reverse=True)

    out = []
    for _, c in scored[:12]:
        out.append({
            "source_id": c["source_id"],
            "brand_tr": c.get("brand_tr", ""),
            "season": c.get("season", ""),
            "season_label": c.get("season_label", ""),
            "image": (c.get("image_thumb") or c.get("image")
                      or (c.get("images_thumb") or [None])[0] or (c.get("images") or [None])[0]),
        })
    return {"items": out}


@api.get("/fashion/collections/{source_id}/adjacent")
async def fashion_adjacent_collection(
    source_id: str, user: Annotated[dict, Depends(get_current_user)], direction: str = "next",
):
    """C5: "galeride koleksiyonlar arası kaydırma" — the next/previous
    collection in the same order as the main feed's "newest" sort, so
    swiping past a collection's last photo can hop straight into the next
    one's. Keyset (not skip/limit): cheap regardless of how deep the feed
    goes, and stable even if the feed changes between requests."""
    cur = await db.fashion.find_one(
        {"source_id": source_id}, {"_id": 0, "season_rank": 1, "feed_seq": 1, "updated_at": 1},
    )
    if not cur:
        raise HTTPException(404, "Koleksiyon bulunamadı.")
    sr = cur.get("season_rank") if cur.get("season_rank") is not None else -1
    fs = cur.get("feed_seq") if cur.get("feed_seq") is not None else 1000000
    ua = cur.get("updated_at") or ""

    if direction == "prev":
        # reverse of the "newest" order below
        match = {"$or": [
            {"season_rank": {"$gt": sr}},
            {"season_rank": sr, "feed_seq": {"$lt": fs}},
            {"season_rank": sr, "feed_seq": fs, "updated_at": {"$gt": ua}},
            {"season_rank": sr, "feed_seq": fs, "updated_at": ua, "source_id": {"$lt": source_id}},
        ]}
        sort = [("season_rank", 1), ("feed_seq", -1), ("updated_at", 1), ("source_id", -1)]
    else:
        match = {"$or": [
            {"season_rank": {"$lt": sr}},
            {"season_rank": sr, "feed_seq": {"$gt": fs}},
            {"season_rank": sr, "feed_seq": fs, "updated_at": {"$lt": ua}},
            {"season_rank": sr, "feed_seq": fs, "updated_at": ua, "source_id": {"$gt": source_id}},
        ]}
        sort = [("season_rank", -1), ("feed_seq", 1), ("updated_at", -1), ("source_id", 1)]

    nxt = await db.fashion.find_one(match, {"_id": 0, "source_id": 1, "brand_tr": 1, "season": 1}, sort=sort)
    if not nxt:
        return {"item": None}
    return {"item": {"source_id": nxt["source_id"], "brand_tr": nxt.get("brand_tr") or "", "season": nxt.get("season") or ""}}


@api.get("/fashion/collections/{source_id}")
async def fashion_collection_detail(source_id: str):
    """Full runway gallery (all photos) for one collection, fetched on demand and cached.

    nowfashion.com and firstview.com items already carry their full photo
    set from the scrape itself; only fashion-press.net's search-page listing
    is thumbnail-only (see fashion_scraper._finish_items), so the on-demand
    fallback below is specific to that source (fp_source_id is its raw
    numeric collection id).

    Bug fixed here: `doc["images"]` already holds that one listing
    thumbnail by the time this endpoint is hit (saved at scrape time by
    _finalize_fashion_group), so `if doc.get("images")` was always true and
    this fallback never actually ran — every fashion-press collection's
    detail page showed a single photo instead of the full runway gallery.
    Track whether the full-gallery fetch has been attempted with its own
    flag instead of inferring it from images being non-empty.
    """
    doc = await db.fashion.find_one({"source_id": source_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Koleksiyon bulunamadı.")
    # G4: tag coverage ("42/50 foto analiz edildi") — image_tags is always a
    # contiguous prefix of images (see _merge_one_doc_group_inner), so its
    # length alone is the tagged count; the denominator is capped the same
    # way the tagger itself caps a doc (_doc_taggable/_TAG_MAX_PHOTOS_PER_DOC).
    tagged_count = len(doc.get("image_tags") or [])
    fp_id = doc.get("fp_source_id")
    # Bug fixed here: `gallery_fetched` was being treated as permanent, but
    # fashion-press.net publishes a show's photos progressively -- a
    # collection opened right when it went up could get "fetched" with
    # just 1-2 photos, then sit stuck there forever even after the site
    # published the other 100+ (confirmed live: Yoshiokubo's fp gallery had
    # 121 photos on the live site while our doc had exactly 1, marked
    # gallery_fetched). A doc with a suspiciously thin gallery gets one more
    # real attempt instead of trusting the flag -- see _THIN_GALLERY_MAX's
    # other use in run_fashion_cover_fix.
    already_thin = len(doc.get("images") or []) <= _THIN_GALLERY_MAX
    if not fp_id or (doc.get("gallery_fetched") and not already_thin):
        imgs = doc.get("images") or []
        return {
            "images": imgs,
            "images_thumb": doc.get("images_thumb") or [],
            "tagged_count": tagged_count,
            "taggable_count": min(len(imgs), _TAG_MAX_PHOTOS_PER_DOC),
        }
    try:
        images = await asyncio.to_thread(fashion_scraper.fetch_collection_images, fp_id)
        images_thumb = images
        if image_store.ENABLED:
            cached = await asyncio.to_thread(image_store.cache_images_with_thumb, images)
            images = [full for full, _ in cached]
            images_thumb = [thumb for _, thumb in cached]
    except Exception:
        images = []
        images_thumb = []
    update = {"gallery_fetched": True}
    if images:
        update["images"] = images
        # doc["image"] (singular, the feed's cover photo) was never touched
        # here -- it stayed the low-res fashion-press listing-page thumbnail
        # from scrape time (see _parse_collection_links) forever, no matter
        # how many times a collection's full gallery got fetched. Use the
        # first real photo instead, same as a freshly-finalized scrape group
        # does (see _finalize_fashion_group).
        update["image"] = images[0]
        update["images_thumb"] = images_thumb
        update["image_thumb"] = images_thumb[0] if images_thumb else images[0]
    # Mark fetched even on failure/empty so a broken collection doesn't
    # re-trigger this fetch (and re-hit fashion-press.net) on every view —
    # the existing thumbnail stays as the fallback.
    await db.fashion.update_one({"source_id": source_id}, {"$set": update})
    final_images = images or doc.get("images") or []
    return {
        "images": final_images,
        "images_thumb": images_thumb or doc.get("images_thumb") or [],
        "tagged_count": tagged_count,
        "taggable_count": min(len(final_images), _TAG_MAX_PHOTOS_PER_DOC),
    }


@api.post("/fashion/collections/{source_id}/describe")
async def fashion_describe_photo(
    source_id: str,
    index: int,
    user: Annotated[dict, Depends(get_current_user)],
    lang: str = "tr",
):
    """B1: "Bu görünümü anlat" — one-sentence AI description of a single
    photo. Auth-gated (unlike the plain collection-detail GET above)
    because, unlike that endpoint, this one costs a real Gemini call —
    cached per (photo, language) in db.fashion.photo_descriptions so
    re-opening the same photo/language never calls Gemini twice."""
    if lang not in ("tr", "en", "es"):
        lang = "tr"
    doc = await db.fashion.find_one(
        {"source_id": source_id}, {"_id": 0, "images": 1, "photo_descriptions": 1}
    )
    if not doc:
        raise HTTPException(404, "Koleksiyon bulunamadı.")
    images = doc.get("images") or []
    if index < 0 or index >= len(images):
        raise HTTPException(400, "Geçersiz foto numarası.")
    cache_key = f"{index}:{lang}"
    cached = (doc.get("photo_descriptions") or {}).get(cache_key)
    if cached:
        return {"description": cached, "cached": True}
    if not gemini_client.ENABLED:
        raise HTTPException(503, "Yapay zeka şu anda kullanılamıyor.")
    text = await asyncio.to_thread(gemini_client.describe_image, images[index], lang)
    if not text:
        raise HTTPException(502, "Açıklama oluşturulamadı, tekrar dene.")
    await db.fashion.update_one(
        {"source_id": source_id}, {"$set": {f"photo_descriptions.{cache_key}": text}}
    )
    await _bump_usage_counter("gemini_calls")
    return {"description": text, "cached": False}


@api.post("/fashion/collections/{source_id}/report")
async def report_fashion_collection(
    source_id: str, body: FashionReportBody, user: Annotated[dict, Depends(get_current_user)],
):
    """G2: "Bu kapak/marka yanlış" — queued for an admin, not acted on
    automatically (a wrong report shouldn't be able to mess up the catalog)."""
    doc = await db.fashion.find_one({"source_id": source_id}, {"_id": 0, "brand_tr": 1, "season_label": 1})
    if not doc:
        raise HTTPException(404, "Koleksiyon bulunamadı.")
    await db.fashion_reports.insert_one({
        "id": str(uuid.uuid4()),
        "source_id": source_id,
        "brand_tr": doc.get("brand_tr") or "",
        "season_label": doc.get("season_label") or "",
        "user_id": user["id"],
        "user_name": user.get("name") or user.get("email") or "",
        "reason": body.reason,
        "note": body.note.strip(),
        "status": "open",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    return {"status": "ok"}


@api.get("/fashion/looks/filters")
async def fashion_looks_filters(user: Annotated[dict, Depends(get_current_user)]):
    """Static filter option lists (season/gender/item/color/material/pattern) for coordinate search."""
    return fashion_scraper.looks_filters()


class ParseQueryBody(BaseModel):
    text: str = Field(min_length=1, max_length=300)


@api.post("/fashion/looks/parse-query")
async def fashion_parse_query(body: ParseQueryBody, user: Annotated[dict, Depends(get_current_user)]):
    """B3: "Kelimeyle ara" — a free sentence (any of tr/en/es) -> Lens
    filter values, via Gemini. The Kombin Arama filter panel already has a
    fast keyword-table free-text search (fashion_tag_map.free_text_conditions,
    used by /fashion/looks's own `q` param) — this is the heavier, opt-in
    "understand a whole sentence and set the actual filter dropdowns" path."""
    raw = fashion_scraper.looks_filters()
    vocab = {
        "gender": [g["value"] for g in raw["genders"] if g["value"]],
        "season": [s["value"] for s in raw["seasons"]],
        "item": [opt["value"] for group in raw["items"] for opt in group["options"]],
        "color": [c["value"] for c in raw["colors"]],
        "material": [m["value"] for m in raw["materials"]],
        "pattern": [p["value"] for p in raw["patterns"]],
    }
    if not gemini_client.ENABLED:
        raise HTTPException(503, "Yapay zeka şu anda kullanılamıyor.")
    parsed = await asyncio.to_thread(gemini_client.parse_look_query, body.text, vocab)
    if parsed is None:
        raise HTTPException(502, "Anlaşılamadı, tekrar dene.")
    await _bump_usage_counter("gemini_calls")
    return {"filters": parsed}


_LOOKS_LIMIT = 90


@api.get("/fashion/looks")
async def fashion_looks(
    user: Annotated[dict, Depends(get_current_user)],
    gender: Optional[str] = None,
    season: Optional[str] = None,
    item: Optional[str] = None,
    color: Optional[str] = None,
    material: Optional[str] = None,
    pattern: Optional[str] = None,
    q: Optional[str] = None,
    skip: int = 0,
):
    """Coordinate search ("kombin arama"): single runway photos, filtered by
    item / color / material / pattern / season / gender.

    Served from our OWN db.fashion — every collection's Gemini photo tags
    (see gemini_client.tag_images + run_fashion_tag_photos), exploded to one
    result per tagged photo — so FirstView shows up here too, not just
    fashion-press. The filter vocabulary is still fashion-press's (see
    fashion_scraper.LOOKS_*); fashion_tag_map bridges it to the looser words
    Gemini actually writes. Only photos that have been tagged so far appear;
    coverage fills in as the nightly tag sweep runs.
    """
    pipeline = _looks_pipeline(gender, season, item, color, material, pattern, q, skip, _LOOKS_LIMIT)
    rows = await db.fashion.aggregate(pipeline).to_list(length=_LOOKS_LIMIT)
    for r in rows:
        r.pop("season_rank", None)
        r.pop("feed_seq", None)
        r.pop("updated_at", None)
    return {"items": rows}


def _looks_pipeline(
    gender: Optional[str], season: Optional[str], item: Optional[str], color: Optional[str],
    material: Optional[str], pattern: Optional[str], q: Optional[str], skip: int, limit: int,
) -> list:
    """The aggregation pipeline behind /fashion/looks — factored out so A8's
    smart-board refresh can run the exact same match a saved filter
    represents, instead of drifting out of sync with a second copy."""
    match: dict = {}
    if season:
        match["season"] = season.upper()
    if gender == "female":
        match["category"] = {"$in": ["women", "haute-couture"]}
    elif gender == "male":
        match["category"] = "men"

    q = (q or "").strip()
    # "pantolon" / "jean" / "yün" / "siyah" etc. -> the Gemini tag words for
    # that garment/colour/material/pattern, so the search box also filters on
    # what's IN the photos, not just brand/season/city text.
    qtags = fashion_tag_map.free_text_conditions(q) if q else {}
    if q:
        rx = {"$regex": re.escape(q), "$options": "i"}
        ors = [{"brand_tr": rx}, {"title_tr": rx}, {"season_label": rx}, {"city": rx}]
        if qtags:
            ors.append({"image_tags": {"$elemMatch": {"$or": [{f: c} for f, c in qtags.items()]}}})
        match["$or"] = ors

    tconds = fashion_tag_map.tag_match_conditions(item=item, color=color, material=material, pattern=pattern)
    if tconds:
        match["image_tags"] = {"$elemMatch": tconds}

    proj = {
        "_id": 0, "sid": "$source_id", "brand_tr": 1, "season": 1, "season_label": 1,
        "url": 1, "images": 1, "images_thumb": 1, "image_tags": 1,
        "season_rank": 1, "updated_at": 1, "feed_seq": 1,
    }
    if q:
        # did this collection match the query by TEXT (brand/season/city)? If
        # so every photo of it is a hit; if it only matched via qtags, keep
        # just the photos whose own tags match. (Only add this field when
        # there IS a query — a literal in an inclusion $project would break it.)
        q_re = re.escape(q)
        proj["q_text_hit"] = {"$or": [
            {"$regexMatch": {"input": {"$ifNull": ["$brand_tr", ""]}, "regex": q_re, "options": "i"}},
            {"$regexMatch": {"input": {"$ifNull": ["$title_tr", ""]}, "regex": q_re, "options": "i"}},
            {"$regexMatch": {"input": {"$ifNull": ["$season_label", ""]}, "regex": q_re, "options": "i"}},
            {"$regexMatch": {"input": {"$ifNull": ["$city", ""]}, "regex": q_re, "options": "i"}},
        ]}
    pipeline: list = [
        {"$match": match},
        {"$project": proj},
        {"$unwind": {"path": "$image_tags", "includeArrayIndex": "i"}},
    ]
    post_conds: list = []
    if tconds:
        post_conds.append({f"image_tags.{k}": v for k, v in tconds.items()})
    if qtags:
        # photo's own tag matches the query, OR the collection matched by text
        post_conds.append({"$or": [{"q_text_hit": True}, *[{f"image_tags.{f}": c} for f, c in qtags.items()]]})
    if post_conds:
        pipeline.append({"$match": {"$and": post_conds} if len(post_conds) > 1 else post_conds[0]})
    pipeline += [
        {"$project": {
            "source_id": {"$concat": ["$sid", "#", {"$toString": "$i"}]},
            "url": {"$ifNull": ["$url", ""]},
            "brand_tr": {"$ifNull": ["$brand_tr", ""]},
            "season": {"$ifNull": ["$season", ""]},
            "season_text_tr": {"$ifNull": ["$season_label", ""]},
            "image": {"$ifNull": [
                {"$arrayElemAt": ["$images_thumb", "$i"]},
                {"$arrayElemAt": ["$images", "$i"]},
            ]},
            "season_rank": {"$ifNull": ["$season_rank", -1]},
            "feed_seq": {"$ifNull": ["$feed_seq", 1000000]},
            "updated_at": {"$ifNull": ["$updated_at", ""]},
        }},
        {"$match": {"image": {"$nin": [None, ""]}}},
        # Newest show first: season, then the source's listing position
        # (0 = newest), then re-scrape time, then stable.
        {"$sort": {"season_rank": -1, "feed_seq": 1, "updated_at": -1, "source_id": 1}},
        {"$skip": max(0, skip)},
        {"$limit": limit},
    ]
    return pipeline


# ---------------- COZA Lens boards (saved photos, nested folders) -------------
_BOARD_PHOTO_PAGE = 120


async def _board_or_404(user_id: str, board_id: str) -> dict:
    b = await db.boards.find_one({"id": board_id, "user_id": user_id}, {"_id": 0})
    if not b:
        raise HTTPException(404, "Pano bulunamadı.")
    return b


async def _descendant_board_ids(user_id: str, root_id: str) -> list:
    """root_id + every board nested under it (any depth)."""
    all_boards = await db.boards.find({"user_id": user_id}, {"_id": 0, "id": 1, "parent_id": 1}).to_list(length=2000)
    children: dict = {}
    for b in all_boards:
        children.setdefault(b.get("parent_id"), []).append(b["id"])
    out, stack = [], [root_id]
    while stack:
        cur = stack.pop()
        out.append(cur)
        stack.extend(children.get(cur, []))
    return out


async def _board_tag_profile(user_id: str, board_id: str) -> dict:
    """A7 input: brand distribution + top item/color/material words across
    a board's saved photos (joins back to each photo's collection to read
    its image_tags — saved_photos itself only carries brand/season)."""
    photos = await db.saved_photos.find(
        {"user_id": user_id, "board_id": board_id},
        {"_id": 0, "source_id": 1, "photo_index": 1, "brand_tr": 1},
    ).to_list(length=2000)
    if not photos:
        return {}
    source_ids = list({p["source_id"] for p in photos})
    docs = await db.fashion.find(
        {"source_id": {"$in": source_ids}}, {"_id": 0, "source_id": 1, "image_tags": 1},
    ).to_list(length=len(source_ids))
    tags_by_source = {d["source_id"]: d.get("image_tags") or [] for d in docs}
    from collections import Counter
    brands = Counter()
    counts = {f: Counter() for f in _TREND_FACETS}
    for p in photos:
        brands[p.get("brand_tr") or "?"] += 1
        tags = tags_by_source.get(p["source_id"]) or []
        idx = p["photo_index"]
        if 0 <= idx < len(tags) and isinstance(tags[idx], dict):
            for f in counts:
                v = (tags[idx].get(f) or "").strip().lower()
                if v and v not in _TREND_IGNORE:
                    counts[f][v] += 1
    return {
        "photo_count": len(photos),
        "brands": [{"name": n, "count": c} for n, c in brands.most_common(6)],
        **{f"top_{f}": [w for w, _ in c.most_common(5)] for f, c in counts.items()},
    }


@api.get("/fashion/boards")
async def list_boards(user: Annotated[dict, Depends(get_current_user)]):
    """Every board the user has (flat; the app builds the tree from
    parent_id) with a photo count and a cover (newest saved photo)."""
    boards = await db.boards.find({"user_id": user["id"]}, {"_id": 0}).sort("name", 1).to_list(length=2000)
    counts = await db.saved_photos.aggregate([
        {"$match": {"user_id": user["id"]}},
        {"$sort": {"added_at": -1}},
        {"$group": {"_id": "$board_id", "n": {"$sum": 1}, "cover": {"$first": "$image_thumb"},
                    "cover_full": {"$first": "$image"}}},
    ]).to_list(length=2000)
    cmap = {c["_id"]: c for c in counts}
    for b in boards:
        c = cmap.get(b["id"], {})
        b["photo_count"] = c.get("n", 0)
        b["cover"] = c.get("cover") or c.get("cover_full") or None
    return {"boards": boards}


@api.post("/fashion/boards")
async def create_board(body: BoardCreateBody, user: Annotated[dict, Depends(get_current_user)]):
    parent_id = body.parent_id or None
    if parent_id:
        await _board_or_404(user["id"], parent_id)
    if await db.boards.count_documents({"user_id": user["id"]}) >= 500:
        raise HTTPException(400, "Çok fazla pano var.")
    now = datetime.now(timezone.utc).isoformat()
    doc = {"id": str(uuid.uuid4()), "user_id": user["id"], "name": body.name.strip(),
           "parent_id": parent_id, "created_at": now, "updated_at": now}
    if body.smart_filter:
        doc["smart_filter"] = body.smart_filter
    await db.boards.insert_one(dict(doc))
    doc.pop("_id", None)
    doc["photo_count"] = 0
    doc["cover"] = None
    return doc


@api.patch("/fashion/boards/{board_id}")
async def update_board(board_id: str, body: BoardUpdateBody, user: Annotated[dict, Depends(get_current_user)]):
    await _board_or_404(user["id"], board_id)
    upd: dict = {"updated_at": datetime.now(timezone.utc).isoformat()}
    if body.name is not None:
        upd["name"] = body.name.strip()
    if body.parent_id is not None:
        new_parent = body.parent_id or None
        if new_parent in ("root", ""):
            new_parent = None
        if new_parent == board_id or (new_parent and new_parent in await _descendant_board_ids(user["id"], board_id)):
            raise HTTPException(400, "Bir pano kendi içine taşınamaz.")
        if new_parent:
            await _board_or_404(user["id"], new_parent)
        upd["parent_id"] = new_parent
    await db.boards.update_one({"id": board_id, "user_id": user["id"]}, {"$set": upd})
    return {"status": "ok"}


@api.delete("/fashion/boards/{board_id}")
async def delete_board(board_id: str, user: Annotated[dict, Depends(get_current_user)]):
    await _board_or_404(user["id"], board_id)
    ids = await _descendant_board_ids(user["id"], board_id)
    await db.saved_photos.delete_many({"user_id": user["id"], "board_id": {"$in": ids}})
    await db.boards.delete_many({"user_id": user["id"], "id": {"$in": ids}})
    return {"status": "ok", "deleted_boards": len(ids)}


@api.get("/fashion/boards/{board_id}/photos")
async def board_photos(board_id: str, user: Annotated[dict, Depends(get_current_user)], skip: int = 0):
    await _board_or_404(user["id"], board_id)
    rows = await db.saved_photos.find(
        {"user_id": user["id"], "board_id": board_id}, {"_id": 0, "user_id": 0},
    ).sort("added_at", -1).skip(max(0, skip)).limit(_BOARD_PHOTO_PAGE).to_list(length=_BOARD_PHOTO_PAGE)
    return {"items": rows}


@api.post("/fashion/boards/{board_id}/photos")
async def save_photo(board_id: str, body: SavePhotoBody, user: Annotated[dict, Depends(get_current_user)]):
    await _board_or_404(user["id"], board_id)
    key = {"user_id": user["id"], "board_id": board_id,
           "source_id": body.source_id, "photo_index": body.photo_index}
    await db.saved_photos.update_one(
        key,
        {"$set": {"image": body.image, "image_thumb": body.image_thumb or body.image,
                  "brand_tr": body.brand_tr, "season": body.season, "season_label": body.season_label,
                  "url": body.url},
         "$setOnInsert": {**key, "added_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    return {"status": "ok"}


@api.delete("/fashion/boards/{board_id}/photos/{source_id}/{photo_index}")
async def unsave_photo(board_id: str, source_id: str, photo_index: int,
                       user: Annotated[dict, Depends(get_current_user)]):
    await db.saved_photos.delete_one({
        "user_id": user["id"], "board_id": board_id,
        "source_id": source_id, "photo_index": photo_index,
    })
    return {"status": "ok"}


@api.patch("/fashion/boards/{board_id}/photos/{source_id}/{photo_index}")
async def update_saved_photo_note(
    board_id: str, source_id: str, photo_index: int,
    body: SavedPhotoNoteBody, user: Annotated[dict, Depends(get_current_user)],
):
    """A1: personal note + custom tags on a saved photo — the user's own,
    doesn't touch the AI's image_tags on the collection itself."""
    upd: dict = {}
    if body.note is not None:
        upd["note"] = body.note.strip()
    if body.tags is not None:
        upd["custom_tags"] = [t.strip() for t in body.tags if t.strip()][:20]
    if not upd:
        return {"status": "ok"}
    res = await db.saved_photos.update_one(
        {"user_id": user["id"], "board_id": board_id, "source_id": source_id, "photo_index": photo_index},
        {"$set": upd},
    )
    if res.matched_count == 0:
        raise HTTPException(404, "Kayıtlı fotoğraf bulunamadı.")
    return {"status": "ok"}


@api.post("/fashion/boards/{board_id}/duplicate")
async def duplicate_board(board_id: str, user: Annotated[dict, Depends(get_current_user)]):
    """A3: copy a board (name + its own direct photos only, not sub-folders)
    as a new sibling board."""
    src = await _board_or_404(user["id"], board_id)
    if await db.boards.count_documents({"user_id": user["id"]}) >= 500:
        raise HTTPException(400, "Çok fazla pano var.")
    now = datetime.now(timezone.utc).isoformat()
    new_id = str(uuid.uuid4())
    await db.boards.insert_one({
        "id": new_id, "user_id": user["id"], "name": f"{src['name']} (kopya)",
        "parent_id": src.get("parent_id"), "created_at": now, "updated_at": now,
    })
    photos = await db.saved_photos.find(
        {"user_id": user["id"], "board_id": board_id}, {"_id": 0, "user_id": 0, "board_id": 0, "added_at": 0},
    ).to_list(length=20000)
    if photos:
        await db.saved_photos.insert_many([
            {**p, "user_id": user["id"], "board_id": new_id, "added_at": now} for p in photos
        ])
    return {"id": new_id, "status": "ok", "photos_copied": len(photos)}


@api.post("/fashion/boards/{board_id}/archive")
async def archive_board(board_id: str, user: Annotated[dict, Depends(get_current_user)], archived: bool = True):
    """A3: hide a board from the normal folder view without deleting it."""
    await _board_or_404(user["id"], board_id)
    await db.boards.update_one(
        {"id": board_id, "user_id": user["id"]},
        {"$set": {"archived": archived, "updated_at": datetime.now(timezone.utc).isoformat()}},
    )
    return {"status": "ok"}


@api.post("/fashion/boards/{board_id}/share")
async def share_board(board_id: str, user: Annotated[dict, Depends(get_current_user)]):
    """F5: turn on a public, view-only link for this board. The token is a
    separate random value (not the board's own id) so it can be revoked
    (POST unshare) and re-issued without ever reusing an old, possibly-
    leaked link — see public_board below for what a visitor actually sees."""
    board = await _board_or_404(user["id"], board_id)
    token = board.get("share_token") or secrets.token_urlsafe(16)
    await db.boards.update_one(
        {"id": board_id, "user_id": user["id"]},
        {"$set": {"public": True, "share_token": token}},
    )
    return {"status": "ok", "token": token}


@api.post("/fashion/boards/{board_id}/unshare")
async def unshare_board(board_id: str, user: Annotated[dict, Depends(get_current_user)]):
    await _board_or_404(user["id"], board_id)
    await db.boards.update_one({"id": board_id, "user_id": user["id"]}, {"$set": {"public": False}})
    return {"status": "ok"}


@api.get("/public/boards/{token}")
async def public_board(token: str):
    """F5: read-only, no auth. Deliberately returns ONLY what a visitor
    should see — board name + its own photos (not sub-folders, not the
    owner's identity, not any other field on the board doc)."""
    board = await db.boards.find_one({"share_token": token, "public": True}, {"_id": 0, "id": 1, "name": 1})
    if not board:
        raise HTTPException(404, "Bu bağlantı artık geçerli değil.")
    photos = await db.saved_photos.find(
        {"board_id": board["id"]},
        {"_id": 0, "user_id": 0, "board_id": 0, "note": 0, "custom_tags": 0},
    ).sort("added_at", -1).limit(_BOARD_PHOTO_PAGE).to_list(length=_BOARD_PHOTO_PAGE)
    return {"name": board["name"], "photos": photos}


_SMART_BOARD_MAX_ADD = 40


@api.post("/fashion/boards/{board_id}/smart-refresh")
async def smart_refresh_board(board_id: str, user: Annotated[dict, Depends(get_current_user)]):
    """A8: re-run this board's saved Lens filter and save any photo that
    matches now but wasn't already in the board — capped per refresh so
    opening a very broad smart board doesn't dump hundreds of photos in
    at once."""
    board = await _board_or_404(user["id"], board_id)
    sf = board.get("smart_filter")
    if not sf:
        raise HTTPException(400, "Bu bir akıllı pano değil.")
    pipeline = _looks_pipeline(
        sf.get("gender"), sf.get("season"), sf.get("item"), sf.get("color"),
        sf.get("material"), sf.get("pattern"), sf.get("q"), 0, 200,
    )
    rows = await db.fashion.aggregate(pipeline).to_list(length=200)
    existing = await db.saved_photos.find(
        {"user_id": user["id"], "board_id": board_id}, {"_id": 0, "source_id": 1, "photo_index": 1},
    ).to_list(length=5000)
    existing_keys = {f"{r['source_id']}#{r['photo_index']}" for r in existing}
    now = datetime.now(timezone.utc).isoformat()
    added = 0
    for r in rows:
        if added >= _SMART_BOARD_MAX_ADD:
            break
        if r["source_id"] in existing_keys:
            continue
        sid, _, idx_s = r["source_id"].rpartition("#")
        try:
            idx = int(idx_s)
        except ValueError:
            continue
        await db.saved_photos.update_one(
            {"user_id": user["id"], "board_id": board_id, "source_id": sid, "photo_index": idx},
            {
                "$set": {
                    "image": r["image"], "image_thumb": r["image"], "brand_tr": r["brand_tr"],
                    "season": r["season"], "season_label": r["season_text_tr"], "url": r["url"],
                },
                "$setOnInsert": {"added_at": now},
            },
            upsert=True,
        )
        existing_keys.add(r["source_id"])
        added += 1
    return {"status": "ok", "added": added}


@api.post("/fashion/boards/{board_id}/summarize")
async def summarize_board_endpoint(
    board_id: str, user: Annotated[dict, Depends(get_current_user)], lang: str = "tr", force: bool = False,
):
    """A7: "Board'u özetle" — cached on the board doc so re-opening never
    re-calls Gemini; pass force=true to regenerate (e.g. after adding photos)."""
    board = await _board_or_404(user["id"], board_id)
    if not force and board.get("summary") and board.get("summary_lang") == lang:
        return {"summary": board["summary"], "cached": True}
    profile = await _board_tag_profile(user["id"], board_id)
    if not profile or not profile.get("photo_count"):
        raise HTTPException(400, "Pano boş, özetlenecek bir şey yok.")
    if not gemini_client.ENABLED:
        raise HTTPException(503, "Yapay zeka şu anda kullanılamıyor.")
    text = await asyncio.to_thread(gemini_client.summarize_board, profile, lang)
    if not text:
        raise HTTPException(502, "Özet oluşturulamadı, tekrar dene.")
    await db.boards.update_one(
        {"id": board_id, "user_id": user["id"]}, {"$set": {"summary": text, "summary_lang": lang}},
    )
    await _bump_usage_counter("gemini_calls")
    return {"summary": text, "cached": False}


@api.get("/fashion/saved-keys")
async def saved_keys(user: Annotated[dict, Depends(get_current_user)]):
    """Which photos the user has saved anywhere -> "<source_id>#<index>" list
    plus the board ids each is in, so the gallery can show a filled bookmark."""
    rows = await db.saved_photos.find(
        {"user_id": user["id"]}, {"_id": 0, "source_id": 1, "photo_index": 1, "board_id": 1},
    ).to_list(length=20000)
    by_key: dict = {}
    for r in rows:
        by_key.setdefault(f"{r['source_id']}#{r['photo_index']}", []).append(r["board_id"])
    return {"saved": by_key}


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

    # Unfiltered option lists for the feed's city/season filter pickers (see
    # fashion.tsx). These deliberately ignore any active season/category/city
    # query the caller might also be applying elsewhere -- the picker has to
    # keep showing every option even while one is selected, otherwise picking
    # a city would make every *other* city disappear from its own dropdown.
    city_dist = await db.fashion.distinct("city", {"city": {"$nin": ["", None]}})
    season_pairs = await db.fashion.aggregate([
        {"$match": {"season": {"$nin": ["", None]}, "season_label": {"$nin": ["", None]}}},
        {"$group": {"_id": {"code": "$season", "label": "$season_label"}}},
    ]).to_list(length=200)
    season_options = sorted(
        ({"code": r["_id"]["code"], "label": r["_id"]["label"]} for r in season_pairs),
        key=lambda s: _season_rank(s["code"]),
        reverse=True,
    )

    return {
        "total": total,
        "seasons": [{"label": r["_id"], "count": r["count"]} for r in season_dist],
        "brands": [{"label": r["_id"], "count": r["count"]} for r in brand_dist],
        "brand_count": len(await db.fashion.distinct("brand_tr")),
        "last_scrape": meta.get("last_scrape"),
        "cities": sorted(city_dist),
        "season_options": season_options,
    }


async def _tagging_readiness(untagged: "int | None" = None) -> dict:
    """Whether pressing "start tagging" right now will actually do anything —
    one plain-language line, shared by the Settings button and the Gemini
    key test so they never disagree.

    Trusts the last real tagging run over a 1-request key probe: a tiny
    "ping" slips through the per-minute limit while a real burst of hundreds
    gets 429'd, so a quota-limited run in the last 6h means "still no" even
    when every key pings OK and the in-memory cooldowns have since expired.
    """
    if untagged is None:
        agg = await db.fashion.aggregate([
            {"$project": {"n": {"$size": {"$ifNull": ["$images", []]}},
                          "t": {"$min": [{"$size": {"$ifNull": ["$image_tags", []]}},
                                         {"$min": [{"$size": {"$ifNull": ["$images", []]}}, _TAG_MAX_PHOTOS_PER_DOC]}]}}},
            {"$group": {"_id": None,
                        "taggable": {"$sum": {"$min": ["$n", _TAG_MAX_PHOTOS_PER_DOC]}},
                        "tagged": {"$sum": "$t"}}},
        ]).to_list(1)
        s = agg[0] if agg else {}
        untagged = max(0, s.get("taggable", 0) - s.get("tagged", 0))

    fmeta = await db.meta.find_one({"_id": "fashion"}, {"_id": 0, "scraping": 1, "phase": 1}) or {}
    ss = gemini_client.slot_status()
    jr = (await db.meta.find_one({"_id": "job_runs"}, {"_id": 0}) or {}).get("items", [])
    last_tag = next((r for r in jr if r.get("job") == "fashion_tag_photos"), None)
    quota_recent = False
    if last_tag and last_tag.get("status") in ("partial", "error") and "kota" in (last_tag.get("reason") or "").lower():
        try:
            fin = datetime.fromisoformat((last_tag.get("finished_at") or "").replace("Z", "+00:00"))
            # Ignore a quota-limited run from before this process started — a
            # redeploy (e.g. new GEMINI_MODELS) deserves a fresh attempt, not
            # a "kota dolu" carried over from the old config.
            cutoff = max(datetime.now(timezone.utc) - timedelta(hours=6), _PROCESS_START)
            quota_recent = fin > cutoff
        except Exception:
            quota_recent = False

    if not gemini_client.ENABLED:
        return {"can_run": False, "label": "Gemini anahtarı tanımlı değil", "untagged": untagged}
    if fmeta.get("scraping") and fmeta.get("phase") in ("tagging_photos", "tagging_firstview"):
        return {"can_run": False, "label": "Etiketleme şu anda çalışıyor", "untagged": untagged}
    if untagged <= 0:
        return {"can_run": False, "label": "Tüm fotoğraflar etiketli", "untagged": 0}
    if ss.get("all_cooling") and not ss.get("all_quota_cooling"):
        return {"can_run": False,
                "label": "Gemini isteği reddediyor (model/ayar uyumsuzluğu) — Railway loglarına bak",
                "untagged": untagged}
    if ss.get("all_quota_cooling") or quota_recent:
        secs = ss.get("resumes_in_s")
        when = f" (~{max(1, round(secs / 60))} dk)" if (ss.get("all_quota_cooling") and secs) else ""
        return {"can_run": False,
                "label": f"Günlük Gemini kotası dolu — gece 04:00'te devam edecek{when}",
                "untagged": untagged}
    return {"can_run": True, "label": f"Hazır — {untagged} fotoğraf etiketlenecek", "untagged": untagged}


@api.get("/fashion/meta")
async def fashion_meta(user: Annotated[dict, Depends(get_current_user)]):
    meta = await db.meta.find_one({"_id": "fashion"}, {"_id": 0}) or {}
    meta["item_count"] = await db.fashion.count_documents({})
    # Whole-feed photo-tagging progress (see run_fashion_tag_photos). Distinct
    # from tags_total/tags_done in `meta`, which only cover the current sweep
    # run; these are the standing totals across every collection.
    agg = await db.fashion.aggregate([
        {"$project": {
            "n": {"$size": {"$ifNull": ["$images", []]}},
            # a re-scrape can leave image_tags longer than the (now shorter)
            # images array mid-backfill — clamp so "tagged" never exceeds
            # "taggable" (which showed as >100% in the UI).
            "t": {"$min": [
                {"$size": {"$ifNull": ["$image_tags", []]}},
                {"$min": [{"$size": {"$ifNull": ["$images", []]}}, _TAG_MAX_PHOTOS_PER_DOC]},
            ]},
        }},
        {"$group": {
            "_id": None,
            "photos_total": {"$sum": "$n"},
            "photos_tagged": {"$sum": "$t"},
            "photos_taggable": {"$sum": {"$min": ["$n", _TAG_MAX_PHOTOS_PER_DOC]}},
        }},
    ]).to_list(1)
    stats = agg[0] if agg else {}
    meta["photos_total"] = stats.get("photos_total", 0)
    meta["photos_tagged"] = stats.get("photos_tagged", 0)
    meta["photos_taggable"] = stats.get("photos_taggable", 0)

    # Honest one-liner for the Settings "Fotoğraf Etiketle" button (and the
    # Gemini key test's verdict — same helper, so the two never disagree).
    untagged = max(0, stats.get("photos_taggable", 0) - stats.get("photos_tagged", 0))
    meta["tag_state"] = await _tagging_readiness(untagged)
    return meta


@api.post("/admin/fashion-scrape")
async def admin_fashion_scrape(admin: Annotated[dict, Depends(require_admin)]):
    # Fire-and-forget: with three sources plus per-collection photo dedup this
    # can now run well past typical HTTP client/proxy timeouts if awaited inline.
    if _fashion_lock.locked():
        return {"status": "already_running"}
    asyncio.create_task(_run_tracked("fashion_scrape", run_fashion_scrape("manual")))
    return {"status": "started"}


@api.post("/admin/fashion-backfill")
async def admin_fashion_backfill(admin: Annotated[dict, Depends(require_admin)]):
    # One-off full historical pull (see run_fashion_scrape's `backfill=True`
    # path) — everything since January 2026, not just each source's latest
    # page. Much slower than a regular scrape (hundreds of extra requests),
    # so this is a separate button from the regular "tara" one, not something
    # the twice-weekly schedule ever runs on its own.
    if _fashion_lock.locked():
        return {"status": "already_running"}
    asyncio.create_task(_run_tracked("fashion_backfill", run_fashion_scrape("backfill_2026", backfill=True)))
    return {"status": "started"}


_COVER_FIX_TIMEOUT_S = 30  # gallery-page fetch+parse budget (fast: one HTML fetch + regex), see _fix_one_cover
# A collection's photo *download+cache* budget, separate from the above --
# confirmed live that a real fashion-press.net gallery can hold 120+ photos
# (Yoshiokubo's 2027SS collection: 121), which downloading and re-hosting
# one at a time never finished inside a 30s budget. That's what left large
# collections permanently stuck on a single photo: the old code fetched the
# full 121-URL list fine, then timed out mid-way through caching them and
# bailed out (`return False`) without ever saving what little it had -- but
# a doc that instead got "gallery_fetched" set with 1-2 images (like
# Yoshiokubo) came from some other request path entirely, most likely this
# same lazy fetch happening the moment the show first went up on the source
# site with only its first photo published so far. See image_store.
# cache_images_with_thumb's docstring and _THIN_GALLERY_MAX for the other
# half of this fix (re-attempting a doc that already looks "done" but thin).
_COVER_FIX_CACHE_TIMEOUT_S = 180


async def _fix_one_cover(doc: dict, sem: asyncio.Semaphore) -> bool:
    """Replace one fashion-press collection's low-res listing-thumbnail cover
    with a real full-resolution photo pulled from its own gallery page —
    the same fetch GET /fashion/collections/{id} does lazily on first view,
    just run proactively here so the feed's cover doesn't stay stuck on the
    low-res thumbnail for a collection nobody has opened yet. Best-effort:
    any failure just leaves the doc's existing cover in place and it's
    retried on the next sweep (only success marks gallery_fetched).
    """
    async with sem:
        try:
            images = await asyncio.wait_for(
                asyncio.to_thread(fashion_scraper.fetch_collection_images, doc["fp_source_id"]),
                timeout=_COVER_FIX_TIMEOUT_S,
            )
        except Exception:
            images = []
        if not images:
            return False
        images_thumb = images
        if image_store.ENABLED:
            try:
                cached = await asyncio.wait_for(
                    asyncio.to_thread(image_store.cache_images_with_thumb, images),
                    timeout=_COVER_FIX_CACHE_TIMEOUT_S,
                )
            except Exception:
                return False
            images = [full for full, _ in cached]
            images_thumb = [thumb for _, thumb in cached]
        await db.fashion.update_one(
            {"source_id": doc["source_id"]},
            {
                "$set": {
                    "gallery_fetched": True,
                    "images": images,
                    "image": images[0],
                    "images_thumb": images_thumb,
                    "image_thumb": images_thumb[0] if images_thumb else images[0],
                }
            },
        )
        return True


async def run_fashion_cover_fix() -> dict:
    """One-off sweep, mirrors run_fashion_scrape's shape: give every
    fashion-press collection that's never had its gallery fetched (or that
    only got a suspiciously thin one -- see _THIN_GALLERY_MAX) a real cover
    photo instead of the low-res listing-page thumbnail scrape_collections
    saves initially (see _parse_collection_links). Shares _fashion_lock with
    the regular scrape/backfill so they never race each other over the same
    documents.
    """
    if _fashion_lock.locked():
        return {"status": "already_running"}
    async with _fashion_lock:
        started_at = datetime.now(timezone.utc).isoformat()
        all_docs = await db.fashion.find(
            {"fp_source_id": {"$ne": None}},
            {"_id": 0, "source_id": 1, "fp_source_id": 1, "gallery_fetched": 1, "images": 1},
        ).to_list(length=None)
        docs = [
            {"source_id": d["source_id"], "fp_source_id": d["fp_source_id"]}
            for d in all_docs
            if not d.get("gallery_fetched") or len(d.get("images") or []) <= _THIN_GALLERY_MAX
        ]
        logger.info(
            "Fashion cover fix: %d fashion-press collection(s) still on their low-res cover or a thin gallery.",
            len(docs),
        )
        await db.meta.update_one(
            {"_id": "fashion"},
            {"$set": {"scraping": True, "phase": "fixing_covers", "covers_total": len(docs), "covers_done": 0}},
            upsert=True,
        )

        fixed = 0
        sem = asyncio.Semaphore(_IMG_WORK_CONCURRENCY)

        async def _run_one(d: dict):
            nonlocal fixed
            ok = await _fix_one_cover(d, sem)
            if ok:
                fixed += 1
            await db.meta.update_one({"_id": "fashion"}, {"$inc": {"covers_done": 1}})

        await asyncio.gather(*(_run_one(d) for d in docs))
        logger.info("Fashion cover fix: done, %d/%d cover(s) upgraded.", fixed, len(docs))
        await db.meta.update_one({"_id": "fashion"}, {"$set": {"scraping": False}})
        await _record_job_run(
            "fashion_cover_fix", status="ok", started_at=started_at,
            done=fixed, total=len(docs), detail=f"{fixed}/{len(docs)} kapak güncellendi",
        )
        return {"status": "ok", "total": len(docs), "fixed": fixed}


@api.post("/admin/fashion-fix-covers")
async def admin_fashion_fix_covers(admin: Annotated[dict, Depends(require_admin)]):
    # Fire-and-forget, same reasoning as /admin/fashion-scrape: with
    # hundreds of fashion-press collections potentially still stuck on
    # their low-res cover, this can run well past typical HTTP timeouts.
    if _fashion_lock.locked():
        return {"status": "already_running"}
    asyncio.create_task(_run_tracked("fashion_cover_fix", run_fashion_cover_fix()))
    return {"status": "started"}


_THUMB_FIX_TIMEOUT_S = 20  # per-photo download(from our own R2)+resize+upload budget


async def _fix_one_doc_thumbs(doc: dict, sem: asyncio.Semaphore) -> bool:
    """Backfill grid/list thumbnails for one collection whose full-resolution
    photos are already cached on R2 but predate thumbnails existing at all
    (see image_store._THUMB_MAX_WIDTH). Downloads each already-cached photo
    from our own R2 bucket -- never the original source site, so this never
    touches fashion-press.net/firstview.com and can run with more
    concurrency than the cover-fix/merge sweeps. Best-effort per photo: one
    that can't be thumbnailed just falls back to its own full-resolution URL
    (see the zip below), so a single bad photo never blocks the rest of the
    collection.
    """
    async with sem:
        images = doc.get("images") or ([doc["image"]] if doc.get("image") else [])
        if not images:
            return False

        async def _one(u: str):
            try:
                return await asyncio.wait_for(
                    asyncio.to_thread(image_store.backfill_thumb, u), timeout=_THUMB_FIX_TIMEOUT_S
                )
            except Exception:
                return None

        thumbs = await asyncio.gather(*(_one(u) for u in images))
        images_thumb = [t or u for t, u in zip(thumbs, images)]
        await db.fashion.update_one(
            {"source_id": doc["source_id"]},
            {"$set": {"images_thumb": images_thumb, "image_thumb": images_thumb[0] if images_thumb else None}},
        )
        return True


async def run_fashion_thumbnails_backfill() -> dict:
    """One-off sweep: give every existing collection (any source, any prior
    sweep) a small grid/list thumbnail alongside its already-cached
    full-resolution photos -- covers everything scraped/merged/cover-fixed
    before thumbnails existed. Much cheaper than the other sweeps: every
    photo here is already on our own R2 bucket, so nothing here waits on or
    loads fashion-press.net/firstview.com. Shares _fashion_lock with the
    other sweeps so they never race each other over the same documents.
    """
    if _fashion_lock.locked():
        return {"status": "already_running"}
    async with _fashion_lock:
        started_at = datetime.now(timezone.utc).isoformat()
        all_docs = await db.fashion.find(
            {"images.0": {"$exists": True}},
            {"_id": 0, "source_id": 1, "images": 1, "image": 1, "images_thumb": 1},
        ).to_list(length=None)
        docs = [d for d in all_docs if len(d.get("images_thumb") or []) < len(d.get("images") or [])]
        logger.info("Fashion thumbnails: %d collection(s) missing a thumbnail for at least one photo.", len(docs))
        await db.meta.update_one(
            {"_id": "fashion"},
            {
                "$set": {
                    "scraping": True,
                    "phase": "generating_thumbnails",
                    "thumbs_total": len(docs),
                    "thumbs_done": 0,
                }
            },
            upsert=True,
        )

        fixed = 0
        sem = asyncio.Semaphore(_IMG_WORK_CONCURRENCY)

        async def _run_one(d: dict):
            nonlocal fixed
            ok = await _fix_one_doc_thumbs(d, sem)
            if ok:
                fixed += 1
            await db.meta.update_one({"_id": "fashion"}, {"$inc": {"thumbs_done": 1}})

        await asyncio.gather(*(_run_one(d) for d in docs))
        logger.info("Fashion thumbnails: done, %d/%d collection(s) updated.", fixed, len(docs))
        await db.meta.update_one({"_id": "fashion"}, {"$set": {"scraping": False}})
        await _record_job_run(
            "fashion_thumbnails", status="ok", started_at=started_at,
            done=fixed, total=len(docs), detail=f"{fixed}/{len(docs)} koleksiyona küçük resim eklendi",
        )
        return {"status": "ok", "total": len(docs), "fixed": fixed}


@api.post("/admin/fashion-fix-thumbnails")
async def admin_fashion_fix_thumbnails(admin: Annotated[dict, Depends(require_admin)]):
    # Fire-and-forget, same reasoning as /admin/fashion-fix-covers.
    if _fashion_lock.locked():
        return {"status": "already_running"}
    asyncio.create_task(_run_tracked("fashion_thumbnails", run_fashion_thumbnails_backfill()))
    return {"status": "started"}


async def run_fashion_blurhash_backfill() -> dict:
    """D5: a blur placeholder for each collection's COVER thumbnail only
    (not every photo in every gallery — that's a much bigger job for a
    cosmetic feature). Deliberately not wired into the live scrape path
    (see image_store.blurhash_for_url) — this is a standalone backfill an
    admin re-runs occasionally to cover newly-scraped collections."""
    if _fashion_lock.locked():
        return {"status": "already_running"}
    async with _fashion_lock:
        started_at = datetime.now(timezone.utc).isoformat()
        docs = await db.fashion.find(
            {"image_thumb": {"$exists": True, "$ne": None}, "image_blurhash": {"$exists": False}},
            {"_id": 0, "source_id": 1, "image_thumb": 1},
        ).to_list(length=None)
        logger.info("Fashion blurhash: %d collection(s) missing a cover placeholder.", len(docs))
        sem = asyncio.Semaphore(_IMG_WORK_CONCURRENCY)
        fixed = 0

        async def _one(d: dict):
            nonlocal fixed
            async with sem:
                bh = await asyncio.to_thread(image_store.blurhash_for_url, d["image_thumb"])
                if bh:
                    await db.fashion.update_one({"source_id": d["source_id"]}, {"$set": {"image_blurhash": bh}})
                    fixed += 1

        await asyncio.gather(*(_one(d) for d in docs))
        logger.info("Fashion blurhash: done, %d/%d collection(s) updated.", fixed, len(docs))
        await _record_job_run(
            "fashion_blurhash", status="ok", started_at=started_at,
            done=fixed, total=len(docs), detail=f"{fixed}/{len(docs)} koleksiyona bulanık önizleme eklendi",
        )
        return {"status": "ok", "total": len(docs), "fixed": fixed}


@api.post("/admin/fashion-fix-blurhash")
async def admin_fashion_fix_blurhash(admin: Annotated[dict, Depends(require_admin)]):
    if _fashion_lock.locked():
        return {"status": "already_running"}
    asyncio.create_task(_run_tracked("fashion_blurhash", run_fashion_blurhash_backfill()))
    return {"status": "started"}


# How many photos of one collection's gallery to tag. Cem wants every
# photo tagged (not just the first N), so this defaults high enough to
# cover any real gallery — the scrapers themselves cap a collection at a
# few hundred photos (firstview_scraper._MAX_GALLERY_IMAGES) — while still
# bounding a pathological doc. Lower it via env if Gemini quota gets tight.
_TAG_MAX_PHOTOS_PER_DOC = int(os.environ.get("FASHION_TAG_MAX_PHOTOS_PER_DOC", "400"))
# Photos per Gemini request (see gemini_client.tag_images). flash-lite got
# flaky returning a clean N-object JSON array past ~6 images; gemini-3.6-flash
# (paid) handles structured output better, so 8. Drop back to 6 via
# GEMINI_TAG_BATCH if "yanıt okunamadı" counts climb.
_TAG_BATCH = int(os.environ.get("GEMINI_TAG_BATCH", "8"))
# Wall-clock budget for one tag_images() call, scaled by batch size. Generous
# on purpose: a batch that's waiting out a per-key throttle delay, or slot
# cooldowns forcing rotation, can otherwise look timed-out when it was only
# queued.
_TAG_TIMEOUT_PER_PHOTO_S = 30


async def _tag_one_doc(doc: dict, sem: asyncio.Semaphore) -> int:
    """Tag one collection's still-untagged gallery photos via Gemini vision
    (item/color/pattern/material — see gemini_client.tag_images), in batches,
    preferring the small thumbnail over the full-resolution photo (plenty for
    this level of classification, cheaper/faster to upload). Only the first
    _TAG_MAX_PHOTOS_PER_DOC photos of a gallery are ever considered.

    `image_tags` is always kept as a contiguous prefix of `images`, same
    index order — so resuming later (a fresh sweep, or this one picking back
    up after a Railway redeploy killed it mid-run) is just "start at
    len(image_tags)", no need to track which specific photos succeeded. Stops
    at the first failed photo rather than skipping past it, for exactly that
    reason; the sweep retries it next time. Returns how many photos got a new
    tag this run.
    """
    async with sem:
        images = doc.get("images") or ([doc["image"]] if doc.get("image") else [])
        images_thumb = doc.get("images_thumb") or images
        tags = list(doc.get("image_tags") or [])
        target = min(len(images), _TAG_MAX_PHOTOS_PER_DOC)
        added = 0
        while len(tags) < target:
            lo = len(tags)
            hi = min(lo + _TAG_BATCH, target)
            batch_urls = [images_thumb[i] if i < len(images_thumb) else images[i] for i in range(lo, hi)]
            # Self-heal the same "URL points at a bucket that no longer holds
            # the object" case run_fashion_repair_urls fixes in bulk (bucket
            # count changed, or one was emptied by hand) -- a doc that hasn't
            # been through that sweep yet would otherwise 404 on every single
            # photo here and the whole pass looks like "quota/CDN trouble"
            # with nothing actually wrong with Gemini. No-ops (returns the
            # same URL) for a live source-site URL that was never cached.
            batch_urls = await asyncio.to_thread(
                lambda urls=batch_urls: [image_store.find_object_url(u) or u for u in urls]
            )
            try:
                results = await asyncio.wait_for(
                    asyncio.to_thread(gemini_client.tag_images, batch_urls),
                    timeout=_TAG_TIMEOUT_PER_PHOTO_S * len(batch_urls),
                )
            except Exception:
                results = [None] * len(batch_urls)
            # Keep the prefix invariant: take tags up to the first None only.
            new = 0
            for r in results:
                if r is None:
                    break
                tags.append(r)
                new += 1
            if new:
                added += new
                await db.fashion.update_one({"source_id": doc["source_id"]}, {"$set": {"image_tags": tags}})
                await db.meta.update_one({"_id": "fashion"}, {"$inc": {"tags_done": new}})
            if new < len(batch_urls):
                break  # a photo in this batch failed — leave the rest for next sweep
        return added


def _doc_taggable(doc: dict) -> int:
    """How many of a doc's photos are in scope for tagging (see
    _TAG_MAX_PHOTOS_PER_DOC)."""
    n = len(doc.get("images") or ([doc["image"]] if doc.get("image") else []))
    return min(n, _TAG_MAX_PHOTOS_PER_DOC)


async def run_fashion_repair_urls() -> dict:
    """Rewrite every cached photo URL to the bucket that actually holds the
    object now. Going from 1 -> N R2 buckets changed `hash % N`, so the
    shard for a given key moved: new uploads went to the right bucket but
    the stored URLs still point at the old one (often bucket 1, which was
    emptied by hand) -> 404 / blank tiles. This just fixes the addresses,
    no re-download. A URL that resolves to nothing is left as-is (the next
    scrape re-fetches it)."""
    if _fashion_lock.locked():
        return {"status": "already_running"}
    async with _fashion_lock:
        started_at = datetime.now(timezone.utc).isoformat()
        docs = await db.fashion.find(
            {}, {"_id": 0, "source_id": 1, "images": 1, "images_thumb": 1, "image": 1, "image_thumb": 1},
        ).to_list(length=None)
        await db.meta.update_one(
            {"_id": "fashion"},
            {"$set": {"scraping": True, "phase": "repairing_urls", "repair_total": len(docs), "repair_done": 0}},
            upsert=True,
        )
        fixed_docs = 0
        sem = asyncio.Semaphore(_IMG_WORK_CONCURRENCY)

        def _remap(urls: list) -> list:
            return [(image_store.find_object_url(u) or u) for u in (urls or [])]

        async def _one(d: dict) -> None:
            nonlocal fixed_docs
            async with sem:
                imgs = d.get("images") or []
                thumbs = d.get("images_thumb") or []
                new_imgs, new_thumbs = await asyncio.to_thread(lambda: (_remap(imgs), _remap(thumbs)))
                if new_imgs != imgs or new_thumbs != thumbs:
                    upd = {"images": new_imgs, "images_thumb": new_thumbs}
                    if new_imgs:
                        upd["image"] = new_imgs[0]
                    if new_thumbs:
                        upd["image_thumb"] = new_thumbs[0]
                    await db.fashion.update_one({"source_id": d["source_id"]}, {"$set": upd})
                    fixed_docs += 1
            await db.meta.update_one({"_id": "fashion"}, {"$inc": {"repair_done": 1}})

        await asyncio.gather(*(_one(d) for d in docs))
        await db.meta.update_one({"_id": "fashion"}, {"$set": {"scraping": False}})
        logger.info("Fashion URL repair: rewrote photo URLs on %d/%d collection(s).", fixed_docs, len(docs))
        await _record_job_run(
            "fashion_repair_urls", status="ok", started_at=started_at,
            done=fixed_docs, total=len(docs), detail=f"{fixed_docs}/{len(docs)} koleksiyonun adresi düzeltildi",
        )
        return {"status": "ok", "docs_fixed": fixed_docs, "docs_total": len(docs)}


@api.post("/admin/fashion-repair-urls")
async def admin_fashion_repair_urls(admin: Annotated[dict, Depends(require_admin)]):
    if _fashion_lock.locked():
        return {"status": "already_running"}
    asyncio.create_task(_run_tracked("fashion_repair_urls", run_fashion_repair_urls()))
    return {"status": "started"}


async def run_fashion_drop_dead_images() -> dict:
    """Drop photo entries whose object exists on NONE of the R2 buckets from
    every collection's `images` list, keeping `images_thumb` and `image_tags`
    index-aligned.

    After the buckets were emptied by hand and re-sharded, some docs still
    list URLs that 404 everywhere — the app renders them as missing tiles
    and the tagging sweep retries them on every run forever. "Repair URLs"
    can't help (the object is on no bucket); this removes the ghost entries
    so photo counts and tagging are honest again. It does NOT delete
    anything from R2 (there's nothing there) and does NOT touch live
    source-site URLs (a later scrape re-caches those). A genuinely-lost
    photo only comes back with a full "Tümünü Tara"; a collection left with
    zero photos is reported, not deleted.
    """
    if _fashion_lock.locked():
        return {"status": "already_running"}
    async with _fashion_lock:
        started_at = datetime.now(timezone.utc).isoformat()
        docs = await db.fashion.find(
            {}, {"_id": 0, "source_id": 1, "images": 1, "images_thumb": 1,
                 "image": 1, "image_thumb": 1, "image_tags": 1},
        ).to_list(length=None)
        await db.meta.update_one(
            {"_id": "fashion"},
            {"$set": {"scraping": True, "phase": "dropping_dead_images",
                      "repair_total": len(docs), "repair_done": 0}},
            upsert=True,
        )
        sem = asyncio.Semaphore(_IMG_WORK_CONCURRENCY)
        docs_changed = 0
        photos_dropped = 0
        docs_emptied = 0

        def _scan(imgs: list, thumbs: list, tags: list) -> tuple:
            keep: list = []  # (original_index, live_full_url)
            for i, u in enumerate(imgs):
                if not u:
                    continue
                if not image_store.is_our_url(u):
                    keep.append((i, u))  # source-site URL — leave it be
                    continue
                live = image_store.find_object_url(u)
                if live is not None:
                    keep.append((i, live))
                # else: one of ours, on no bucket -> a ghost, drop it
            new_imgs: list = []
            new_thumbs: list = []
            for (i, live_full) in keep:
                new_imgs.append(live_full)
                raw_t = thumbs[i] if i < len(thumbs) else None
                if raw_t and image_store.is_our_url(raw_t):
                    raw_t = image_store.find_object_url(raw_t) or None
                new_thumbs.append(raw_t or live_full)
            # image_tags is a prefix of images; keeping tags[i] for surviving
            # indices < len(tags) preserves that (shorter, still contiguous).
            new_tags = [tags[i] for (i, _l) in keep if i < len(tags)]
            return new_imgs, new_thumbs, new_tags

        async def _one(d: dict) -> None:
            nonlocal docs_changed, photos_dropped, docs_emptied
            async with sem:
                imgs = d.get("images") or []
                if imgs:
                    thumbs = d.get("images_thumb") or []
                    tags = d.get("image_tags") or []
                    new_imgs, new_thumbs, new_tags = await asyncio.to_thread(_scan, imgs, thumbs, tags)
                    dropped = len(imgs) - len(new_imgs)
                    if dropped > 0:
                        await db.fashion.update_one(
                            {"source_id": d["source_id"]},
                            {"$set": {
                                "images": new_imgs,
                                "images_thumb": new_thumbs,
                                "image_tags": new_tags,
                                "image": new_imgs[0] if new_imgs else None,
                                "image_thumb": new_thumbs[0] if new_thumbs else None,
                            }},
                        )
                        docs_changed += 1
                        photos_dropped += dropped
                        if not new_imgs:
                            docs_emptied += 1
            await db.meta.update_one({"_id": "fashion"}, {"$inc": {"repair_done": 1}})

        await asyncio.gather(*(_one(d) for d in docs))
        await db.meta.update_one({"_id": "fashion"}, {"$set": {"scraping": False}})
        logger.info(
            "Fashion dead-image drop: removed %d photo(s) from %d/%d collection(s); %d left with none.",
            photos_dropped, docs_changed, len(docs), docs_emptied,
        )
        status = "partial" if docs_emptied else "ok"
        reason = ""
        if docs_emptied:
            reason = (
                f"{docs_emptied} koleksiyonun bütün fotoğrafları depoda yok — bunlar ancak bir kez "
                f"tam 'Tümünü Tara' çalıştırılınca geri gelir."
            )
        await _record_job_run(
            "fashion_drop_dead_images", status=status, started_at=started_at,
            done=docs_changed, total=len(docs), reason=reason,
            detail=f"{docs_changed} koleksiyondan {photos_dropped} ölü fotoğraf adresi çıkarıldı",
        )
        return {
            "status": "ok",
            "docs_changed": docs_changed,
            "photos_dropped": photos_dropped,
            "docs_emptied": docs_emptied,
            "docs_total": len(docs),
        }


@api.post("/admin/fashion-drop-dead-images")
async def admin_fashion_drop_dead_images(admin: Annotated[dict, Depends(require_admin)]):
    if _fashion_lock.locked():
        return {"status": "already_running"}
    asyncio.create_task(_run_tracked("fashion_drop_dead_images", run_fashion_drop_dead_images()))
    return {"status": "started"}


@api.get("/admin/fashion-reports")
async def admin_fashion_reports(admin: Annotated[dict, Depends(require_admin)], status: str = "open"):
    """G2: the queue of user-flagged "wrong cover/brand" reports."""
    q = {} if status == "all" else {"status": status}
    rows = await db.fashion_reports.find(q, {"_id": 0}).sort("created_at", -1).to_list(length=500)
    return {"items": rows}


@api.post("/admin/fashion-reports/{report_id}/resolve")
async def admin_resolve_fashion_report(report_id: str, admin: Annotated[dict, Depends(require_admin)]):
    res = await db.fashion_reports.update_one(
        {"id": report_id},
        {"$set": {
            "status": "resolved",
            "resolved_at": datetime.now(timezone.utc).isoformat(),
            "resolved_by": admin.get("name") or admin.get("email") or "",
        }},
    )
    if res.matched_count == 0:
        raise HTTPException(404, "Bildirim bulunamadı.")
    return {"status": "ok"}


@api.post("/admin/fashion-collections/{source_id}/refetch")
async def admin_refetch_collection(source_id: str, admin: Annotated[dict, Depends(require_admin)]):
    """G3: "Koleksiyonu yeniden çek" — only fashion-press.net collections
    support an on-demand re-fetch (see fashion_collection_detail); other
    sources already scrape their full gallery up front and only refresh on
    the next site-wide sweep."""
    doc = await db.fashion.find_one({"source_id": source_id}, {"_id": 0, "fp_source_id": 1})
    if not doc:
        raise HTTPException(404, "Koleksiyon bulunamadı.")
    fp_id = doc.get("fp_source_id")
    if not fp_id:
        return {"status": "no_source", "detail": "Bu koleksiyon fashion-press.net kaynaklı değil, tek tek yeniden çekilemiyor."}
    images = await asyncio.to_thread(fashion_scraper.fetch_collection_images, fp_id)
    if not images:
        return {"status": "empty", "detail": "Kaynaktan hiç fotoğraf gelmedi."}
    images_thumb = images
    if image_store.ENABLED:
        cached = await asyncio.to_thread(image_store.cache_images_with_thumb, images)
        images = [full for full, _ in cached]
        images_thumb = [thumb for _, thumb in cached]
    await db.fashion.update_one(
        {"source_id": source_id},
        {"$set": {
            "images": images, "images_thumb": images_thumb,
            "image": images[0], "image_thumb": images_thumb[0],
            "gallery_fetched": True,
        }},
    )
    return {"status": "ok", "photo_count": len(images)}


class BrandMergeBody(BaseModel):
    from_names: list[str] = Field(min_length=1, max_length=30)
    to_name: str = Field(min_length=1, max_length=200)


@api.get("/admin/fashion-brands")
async def admin_fashion_brands(admin: Annotated[dict, Depends(require_admin)], q: Optional[str] = None):
    """G5: every distinct brand name + how many collections use it, for the
    admin merge screen."""
    match: dict = {"brand_tr": {"$nin": ["", None]}}
    if q and q.strip():
        match["brand_tr"] = {"$regex": re.escape(q.strip()), "$options": "i"}
    rows = await db.fashion.aggregate([
        {"$match": match},
        {"$group": {"_id": "$brand_tr", "n": {"$sum": 1}}},
        {"$sort": {"_id": 1}},
    ]).to_list(length=5000)
    return {"items": [{"name": r["_id"], "count": r["n"]} for r in rows]}


@api.post("/admin/fashion-brands/merge")
async def admin_merge_brands(body: BrandMergeBody, admin: Annotated[dict, Depends(require_admin)]):
    """G5: rename `brand_tr` on every collection under any of `from_names`
    to `to_name` — a straight rename, not a doc merge (fashion-merge-
    duplicates already handles the same-show-different-source case)."""
    from_names = [n.strip() for n in body.from_names if n.strip() and n.strip() != body.to_name.strip()]
    if not from_names:
        return {"status": "ok", "renamed": 0}
    res = await db.fashion.update_many(
        {"brand_tr": {"$in": from_names}}, {"$set": {"brand_tr": body.to_name.strip()}},
    )
    return {"status": "ok", "renamed": res.modified_count}


@api.post("/admin/fashion-brands/suggest-merges")
async def admin_suggest_brand_merges(admin: Annotated[dict, Depends(require_admin)]):
    """G6: ask Gemini to cluster brand names that are probably the same
    house written differently — admin reviews and approves each cluster
    with G5's merge endpoint, nothing renamed automatically."""
    rows = await db.fashion.aggregate([
        {"$match": {"brand_tr": {"$nin": ["", None]}}},
        {"$group": {"_id": "$brand_tr", "n": {"$sum": 1}}},
        {"$sort": {"n": -1}},
        {"$limit": 400},
    ]).to_list(length=400)
    brands = [{"name": r["_id"], "count": r["n"]} for r in rows]
    if not gemini_client.ENABLED:
        raise HTTPException(503, "Yapay zeka şu anda kullanılamıyor.")
    suggestions = await asyncio.to_thread(gemini_client.suggest_brand_merges, brands)
    if suggestions is None:
        raise HTTPException(502, "Öneri alınamadı, tekrar dene.")
    await _bump_usage_counter("gemini_calls")
    return {"suggestions": suggestions}


async def run_fashion_tag_photos() -> dict:
    """Sweep: tag every still-untagged runway photo across the WHOLE feed
    (all sources) via Gemini vision, so the look feed can be filtered by
    garment/color/pattern/material no matter where a collection came from —
    fashion-press.net's own pages only expose item+color per photo, never
    material/pattern, so this is the only uniform source of all four.

    Paced by gemini_client's key/model rotation to stay on the free API tier
    (no billing), so a large backlog takes several nightly runs — see the
    progress counters written to db.meta (phase "tagging_photos",
    tags_total/tags_done), same shape as the other fashion sweeps. Shares
    _fashion_lock with them so nothing races over the same documents.
    """
    if not gemini_client.ENABLED:
        await _record_job_run(
            "fashion_tag_photos", status="error", started_at=datetime.now(timezone.utc).isoformat(),
            reason="Gemini API anahtarı tanımlı değil (GEMINI_API_KEY / GEMINI_API_KEYS ortam değişkeni eksik).",
        )
        return {"status": "gemini_disabled"}
    if _fashion_lock.locked():
        return {"status": "already_running"}
    async with _fashion_lock:
        started_at = datetime.now(timezone.utc).isoformat()
        # Fresh failure tally for this run — gemini_client bumps it per photo
        # (download 404 / timeout / quota / bad reply / ok) so the outcome
        # below can name the real reason a pass stalled, not a guess.
        gemini_client.reset_tag_stats()
        # A re-scrape replaces `images` but leaves `image_tags` — if the new
        # gallery is shorter, trim the tags back to a valid prefix so the
        # remaining photos get (re-)tagged and progress counts stay sane.
        await db.fashion.update_many(
            {"$expr": {"$gt": [
                {"$size": {"$ifNull": ["$image_tags", []]}},
                {"$size": {"$ifNull": ["$images", []]}},
            ]}},
            [{"$set": {"image_tags": {"$slice": ["$image_tags", {"$size": {"$ifNull": ["$images", []]}}]}}}],
        )
        all_docs = await db.fashion.find(
            {},
            {"_id": 0, "source_id": 1, "images": 1, "images_thumb": 1, "image": 1, "image_tags": 1},
        ).to_list(length=None)
        need = [d["source_id"] for d in all_docs if len(d.get("image_tags") or []) < _doc_taggable(d)]
        total_photos = sum(_doc_taggable(d) - len(d.get("image_tags") or []) for d in all_docs)
        logger.info("Fashion tagging: %d collection(s), %d photo(s) still untagged.", len(need), total_photos)
        await db.meta.update_one(
            {"_id": "fashion"},
            {"$set": {"scraping": True, "phase": "tagging_photos", "tags_total": total_photos, "tags_done": 0}},
            upsert=True,
        )

        sem = asyncio.Semaphore(int(os.environ.get("FASHION_TAG_DOC_CONCURRENCY", "6")))
        # Keep going in passes. When a whole pass tags nothing, tell a
        # per-minute rate limit (every slot cooling for a SHORT while — wait
        # it out and retry the same docs) apart from the daily cap being
        # spent (long / no cooldown — stop, the 04:00 run resumes).
        max_rate_waits = int(os.environ.get("FASHION_TAG_RATE_WAITS", "10"))
        tagged = 0
        stopped_early = False
        rate_waits = 0
        while need:
            batch_docs = await db.fashion.find(
                {"source_id": {"$in": need}},
                {"_id": 0, "source_id": 1, "images": 1, "images_thumb": 1, "image": 1,
                 "image_tags": 1, "season_rank": 1},
            ).to_list(length=None)
            batch_docs = [d for d in batch_docs if len(d.get("image_tags") or []) < _doc_taggable(d)]
            if not batch_docs:
                break
            # Newest shows first — the ones actually being browsed — so an
            # interrupted run (deploy / quota) leaves the recent feed tagged.
            batch_docs.sort(key=lambda d: d.get("season_rank") or -1, reverse=True)
            results = await asyncio.gather(*(_tag_one_doc(d, sem) for d in batch_docs))
            pass_tagged = sum(results)
            tagged += pass_tagged

            if pass_tagged == 0:
                ss = gemini_client.slot_status()
                wait = ss.get("resumes_in_s") or 0
                if ss.get("all_cooling") and 0 < wait <= 150 and rate_waits < max_rate_waits:
                    rate_waits += 1
                    logger.info("Fashion tagging: all slots cooling ~%ss (rate limit) — waiting, retry %d/%d.",
                                wait, rate_waits, max_rate_waits)
                    await asyncio.sleep(wait + 3)
                    continue  # same `need`, try again
                logger.info("Fashion tagging: a full pass tagged nothing (daily quota spent or photos unreachable) — stopping, resumes next run.")
                stopped_early = True
                break

            rate_waits = 0  # real progress refills the patience budget
            # A doc that gained zero while others progressed is stuck on a dead
            # (404) photo mid-gallery — drop it so we don't re-hit it; the
            # nightly 04:00 sweep retries it fresh.
            stuck = {d["source_id"] for d, got in zip(batch_docs, results) if got == 0}
            retry_ids = [d["source_id"] for d in batch_docs if d["source_id"] not in stuck]
            still = await db.fashion.find(
                {"source_id": {"$in": retry_ids}},
                {"_id": 0, "source_id": 1, "images": 1, "image_tags": 1},
            ).to_list(length=None) if retry_ids else []
            need = [d["source_id"] for d in still if len(d.get("image_tags") or []) < _doc_taggable(d)]
            logger.info("Fashion tagging: pass done (+%d), %d collection(s) still need work.", pass_tagged, len(need))

        logger.info("Fashion tagging: run finished, %d photo(s) tagged.", tagged)
        await db.meta.update_one({"_id": "fashion"}, {"$set": {"scraping": False}})
        await _bump_usage_counter("gemini_photos_tagged", tagged)

        # Turn the per-photo failure tally into a plain-language reason, so
        # "it stopped" has a real answer in the Admin panel instead of a
        # guess from slot_status().
        stats = gemini_client.tag_stats()

        def _sum(*keys: str) -> int:
            return sum(stats.get(k, 0) for k in keys)

        dl_404 = _sum("dl_http_404")
        dl_403 = _sum("dl_http_403")
        dl_5xx = _sum("dl_http_5xx", "dl_http_other")
        dl_net = _sum("dl_timeout", "dl_conn", "dl_other")
        dl_notimg = _sum("dl_not_image")
        g_quota = _sum("gemini_all_cooling")
        g_rejected = _sum("gemini_slots_errored")
        g_noreply = _sum("gemini_no_reply")
        g_badreply = _sum("gemini_bad_json", "gemini_count_mismatch")
        fail_total = (dl_404 + dl_403 + dl_5xx + dl_net + dl_notimg
                      + g_quota + g_rejected + g_noreply + g_badreply)

        bits = []
        if dl_404:
            bits.append(f"{dl_404} fotoğraf depolamada yok (404) — bunlar ancak bir kez tam 'geçmişi tara' ile geri gelir")
        if dl_403:
            bits.append(f"{dl_403} fotoğraf erişime kapalı (403)")
        if dl_notimg:
            bits.append(f"{dl_notimg} adres fotoğraf yerine hata sayfası döndürdü")
        if dl_5xx:
            bits.append(f"{dl_5xx} fotoğrafta depolama geçici hata verdi")
        if dl_net:
            bits.append(f"{dl_net} fotoğraf indirilemedi (bağlantı/zaman aşımı)")
        if g_quota:
            bits.append(f"{g_quota} fotoğrafta günlük Gemini kotası doluydu")
        if g_rejected:
            bits.append(f"{g_rejected} fotoğrafta Gemini isteği reddetti (model/ayar uyumsuzluğu) — Railway loglarına bak")
        if g_noreply:
            bits.append(f"{g_noreply} fotoğrafta Gemini yanıt vermedi")
        if g_badreply:
            bits.append(f"{g_badreply} fotoğrafta Gemini yanıtı okunamadı")

        status, reason = "ok", ""
        if stopped_early or tagged < total_photos:
            status = "partial"
            if bits:
                reason = "Duruş nedeni — " + "; ".join(bits) + ". Kalanlar her gün 04:00'teki taramada tekrar denenir."
            else:
                slots = gemini_client.slot_status()
                if slots.get("all_cooling"):
                    mins = max(1, round((slots.get("resumes_in_s") or 0) / 60))
                    reason = (
                        f"Günlük Gemini kotası tükendi — tüm anahtarlar ~{mins} dk soğumada. "
                        f"Kalanlar her gün 04:00'teki taramada tekrar denenir."
                    )
                else:
                    reason = (
                        "Bir kısım fotoğrafa ulaşılamadı ya da yapay zeka yanıtı okunamadı. "
                        "Kalanlar bir sonraki taramada tekrar denenir."
                    )
        detail = f"{tagged}/{total_photos} fotoğraf etiketlendi"
        if fail_total:
            detail += f" · {fail_total} başarısız deneme"
        logger.info("Fashion tagging: failure tally %s", stats or "{}")
        await _record_job_run(
            "fashion_tag_photos", status=status, started_at=started_at,
            done=tagged, total=total_photos, reason=reason, detail=detail,
        )
        return {"status": "ok", "total_photos": total_photos, "tagged": tagged, "stats": stats}


@api.post("/admin/fashion-tag-firstview")
async def admin_fashion_tag_photos(admin: Annotated[dict, Depends(require_admin)]):
    # Route path kept for the existing app build; tags all sources now, not
    # just FirstView. Fire-and-forget: a multi-thousand-photo backlog on a
    # throttled free tier runs for well over an hour (across nightly runs).
    if not gemini_client.ENABLED:
        raise HTTPException(400, "Gemini API anahtarı yapılandırılmamış.")
    if _fashion_lock.locked():
        return {"status": "already_running"}
    asyncio.create_task(_run_tracked("fashion_tag_photos", run_fashion_tag_photos()))
    return {"status": "started"}


async def run_fashion_prune_old() -> dict:
    """Delete collections whose show is older than the rolling
    FASHION_RECENT_MONTHS window (see _min_recent_season_rank), photos and
    all — the app is a rolling window, so an aged-out collection leaves
    nothing behind, not even orphaned files on R2. Runs after every scrape
    and on its own nightly job.

    A doc whose season doesn't parse (season_rank < 0) is normally left
    alone — we only delete when we can date the show — EXCEPT when it also
    hasn't been re-scraped in _UNDATED_STALE_DAYS: several scrape cycles
    have gone by without ever managing to date it, so it's stale cruft that
    would otherwise pile up forever (Resort / Pre-Fall pre-parser-fix).
    """
    started_at = datetime.now(timezone.utc).isoformat()
    floor = _min_recent_season_rank()
    stale_cut = (datetime.now(timezone.utc) - timedelta(days=_UNDATED_STALE_DAYS)).isoformat()
    doomed = await db.fashion.find(
        {"$or": [
            {"season_rank": {"$gte": 0, "$lt": floor}},
            {"season_rank": {"$lt": 0}, "updated_at": {"$lt": stale_cut}},
        ]},
        {"_id": 0, "source_id": 1, "images": 1, "images_thumb": 1, "image": 1},
    ).to_list(length=None)
    if not doomed:
        await db.meta.update_one(
            {"_id": "fashion"},
            {"$set": {"last_prune": datetime.now(timezone.utc).isoformat(),
                      "recent_months": FASHION_RECENT_MONTHS}},
            upsert=True,
        )
        await _record_job_run(
            "fashion_prune_old", status="ok", started_at=started_at,
            detail="silinecek eski koleksiyon yok",
        )
        return {"status": "ok", "deleted": 0, "photos_deleted": 0, "season_rank_floor": floor}

    # Every re-hosted photo URL these docs point at. delete_image() removes
    # the full-res object AND its derived thumbnail, and no-ops on any URL
    # that isn't on our own R2 bucket, so passing the full-res list is
    # enough (and passing a source-site URL is harmless).
    urls: set = set()
    for d in doomed:
        for u in (d.get("images") or []):
            if u:
                urls.add(u)
        if d.get("image"):
            urls.add(d["image"])

    def _purge(batch: list) -> None:
        for u in batch:
            image_store.delete_image(u)

    url_list = list(urls)
    CHUNK = 50
    await asyncio.gather(*(
        asyncio.to_thread(_purge, url_list[i:i + CHUNK]) for i in range(0, len(url_list), CHUNK)
    ))

    res = await db.fashion.delete_many({"source_id": {"$in": [d["source_id"] for d in doomed]}})
    logger.info(
        "Fashion prune: removed %d collection(s) + %d photo(s) older than %d months (season_rank < %s).",
        res.deleted_count, len(url_list), FASHION_RECENT_MONTHS, floor,
    )
    await db.meta.update_one(
        {"_id": "fashion"},
        {"$set": {"last_prune": datetime.now(timezone.utc).isoformat(),
                  "recent_months": FASHION_RECENT_MONTHS}},
        upsert=True,
    )
    await _record_job_run(
        "fashion_prune_old", status="ok", started_at=started_at,
        done=res.deleted_count, total=res.deleted_count,
        detail=f"{res.deleted_count} eski koleksiyon + {len(url_list)} fotoğraf silindi",
    )
    return {
        "status": "ok",
        "deleted": res.deleted_count,
        "photos_deleted": len(url_list),
        "season_rank_floor": floor,
    }


@api.post("/admin/fashion-prune")
async def admin_fashion_prune(admin: Annotated[dict, Depends(require_admin)]):
    # Can now take a while (deletes photos from R2 too), so fire-and-forget.
    if _fashion_lock.locked():
        return {"status": "already_running"}
    asyncio.create_task(_run_tracked("fashion_prune_old", run_fashion_prune_old()))
    return {"status": "started"}


async def run_fashion_clean_cruft() -> dict:
    """Admin-triggered: delete, photos and all, the two kinds of collection
    the automatic sweeps have no repair path for —

      * undated (season_rank < 0): the season never parsed from any source
        title, so the feed can't sort it and the date-based window prune
        can't age it out. run_fashion_prune_old only removes these after
        _UNDATED_STALE_DAYS of not being re-scraped; this clears them now.
      * a non-fashion-press collection stuck at <= 1 photo: run_fashion_cover
        _fix only re-fetches fashion-press galleries (it needs fp_source_id),
        so a thin firstview/nowfashion entry can't be repaired, and a
        one-photo "runway collection" isn't worth showing.

    Fashion-press thin collections are deliberately left alone — the Kapaklar
    sweep (run_fashion_cover_fix) is their repair path. Mirrors
    run_fashion_prune_old's R2 photo cleanup; shares _fashion_lock with the
    other sweeps so nothing races over the same documents.
    """
    if _fashion_lock.locked():
        return {"status": "already_running"}
    async with _fashion_lock:
        started_at = datetime.now(timezone.utc).isoformat()
        doomed = await db.fashion.find(
            {"$or": [
                {"season_rank": {"$lt": 0}},
                {"fp_source_id": None, "images.1": {"$exists": False}},
            ]},
            {"_id": 0, "source_id": 1, "images": 1, "image": 1},
        ).to_list(length=None)
        await db.meta.update_one(
            {"_id": "fashion"},
            {"$set": {"scraping": True, "phase": "cleaning_cruft",
                      "cruft_total": len(doomed), "cruft_done": 0}},
            upsert=True,
        )
        if not doomed:
            await db.meta.update_one(
                {"_id": "fashion"},
                {"$set": {"scraping": False,
                          "last_cruft_clean": datetime.now(timezone.utc).isoformat()}},
            )
            await _record_job_run(
                "fashion_clean_cruft", status="ok", started_at=started_at,
                detail="silinecek bozuk kayıt yok",
            )
            return {"status": "ok", "deleted": 0, "photos_deleted": 0}

        urls: set = set()
        for d in doomed:
            for u in (d.get("images") or []):
                if u:
                    urls.add(u)
            if d.get("image"):
                urls.add(d["image"])

        def _purge(batch: list) -> None:
            for u in batch:
                image_store.delete_image(u)

        url_list = list(urls)
        CHUNK = 50
        await asyncio.gather(*(
            asyncio.to_thread(_purge, url_list[i:i + CHUNK]) for i in range(0, len(url_list), CHUNK)
        ))

        res = await db.fashion.delete_many({"source_id": {"$in": [d["source_id"] for d in doomed]}})
        logger.info(
            "Fashion cruft clean: removed %d collection(s) + %d photo(s) "
            "(undated, or non-fashion-press with <= 1 photo).",
            res.deleted_count, len(url_list),
        )
        await db.meta.update_one(
            {"_id": "fashion"},
            {"$set": {"scraping": False, "cruft_done": len(doomed),
                      "last_cruft_clean": datetime.now(timezone.utc).isoformat()}},
        )
        await _record_job_run(
            "fashion_clean_cruft", status="ok", started_at=started_at,
            done=res.deleted_count, total=res.deleted_count,
            detail=f"{res.deleted_count} bozuk koleksiyon + {len(url_list)} fotoğraf silindi",
        )
        return {"status": "ok", "deleted": res.deleted_count, "photos_deleted": len(url_list)}


@api.post("/admin/fashion-clean-cruft")
async def admin_fashion_clean_cruft(admin: Annotated[dict, Depends(require_admin)]):
    # Fire-and-forget: also deletes the freed photos from R2, same as
    # /admin/fashion-prune.
    if _fashion_lock.locked():
        return {"status": "already_running"}
    asyncio.create_task(_run_tracked("fashion_clean_cruft", run_fashion_clean_cruft()))
    return {"status": "started"}


def _fashion_doc_merge_key(doc: dict) -> str:
    """Same shape as _fashion_merge_key, but for an already-saved doc rather
    than a freshly-scraped raw item -- and always canonicalizes the doc's
    stored season first (see _season_merge_code). A doc saved before that
    canonicalization existed may still carry the old spelling ('2026AW'),
    which is exactly what makes two really-identical collections compute
    different keys and never find each other -- this is what
    run_fashion_merge_duplicates groups by instead.
    """
    season = _season_merge_code(doc.get("season") or "")
    key = f"{_brand_slug(doc.get('brand_tr') or '')}-{(season or 'unk').lower()}-{doc.get('category') or ''}"
    key = re.sub(r"-+", "-", key).strip("-")
    return key or f"item-{abs(hash(doc.get('url') or doc.get('source_id') or ''))}"


_MERGE_TIMEOUT_S = 90  # per-group budget for phash downloads + R2 deletes, mirrors _FINALIZE_TIMEOUT_S


async def _merge_one_doc_group_inner(key: str, group: list) -> tuple:
    """Fold one canonical-key group of already-saved docs (all the same
    real-world show, previously split across sources because their season
    codes didn't string-match) into a single surviving document. Returns
    (docs_removed, images_dropped).
    """
    # Most-complete-first, same tie-break as _dedupe_existing_fashion_docs.
    group = sorted(group, key=lambda d: (-len(d.get("images") or []), d["source_id"]))
    canonical, *dups = group
    images = list(canonical.get("images") or [])
    seen = set(images)
    # Full URL -> its thumbnail URL, so the merged doc's images_thumb can be
    # rebuilt in the same order as the deduped full-res list below without
    # re-deriving anything from image_store. A doc saved before thumbnails
    # existed has no images_thumb of its own -- falls back to the full URL
    # itself (same as everywhere else a thumbnail might be missing).
    thumb_by_url = dict(zip(canonical.get("images") or [], canonical.get("images_thumb") or []))
    sources = list(canonical.get("sources") or [])
    brand_tr, title_tr = canonical.get("brand_tr", ""), canonical.get("title_tr", "")
    category = canonical.get("category", "")
    city = canonical.get("city")
    fp_source_id = canonical.get("fp_source_id")
    first_seen = canonical.get("first_seen")
    for d in dups:
        thumb_by_url.update(zip(d.get("images") or [], d.get("images_thumb") or []))
        for u in d.get("images") or []:
            if u not in seen:
                seen.add(u)
                images.append(u)
        for s in d.get("sources") or []:
            if s not in sources:
                sources.append(s)
        if d.get("city") and not city:
            city = d["city"]
        if not fp_source_id:
            fp_source_id = d.get("fp_source_id")
        if d.get("first_seen") and (not first_seen or d["first_seen"] < first_seen):
            first_seen = d["first_seen"]
        brand_tr = _looks_better_text(brand_tr, d.get("brand_tr", ""))
        title_tr = _looks_better_text(title_tr, d.get("title_tr", ""))
        if _FASHION_CATEGORY_PRIORITY.get(d.get("category", ""), 9) < _FASHION_CATEGORY_PRIORITY.get(category, 9):
            category = d["category"]

    # These docs are only grouped together because they come from more than
    # one source (that's the whole bug this sweep fixes) -- run phash dedup
    # to drop the same shot syndicated twice, then actually free the R2
    # storage for whichever copy loses (see image_store.delete_image, which
    # also deletes that photo's paired thumbnail).
    deduped = await asyncio.to_thread(_dedupe_images_phash, images) if len(sources) > 1 else images
    dropped = [u for u in images if u not in set(deduped)]
    if dropped:
        await asyncio.to_thread(lambda: [image_store.delete_image(u) for u in dropped])
    deduped_thumb = [thumb_by_url.get(u, u) for u in deduped]

    # image_tags is a positional prefix of images (image_tags[i] describes
    # images[i]). The merge can reorder / drop photos, so keep only the
    # leading tags whose URL still lines up at the same index; the nightly
    # tagging sweep regenerates the rest. In the common case (canonical doc
    # unchanged, dups just appended) this carries every tag over losslessly.
    _old_tags = canonical.get("image_tags") or []
    _old_imgs = canonical.get("images") or []
    kept_tags: list = []
    for _i, _u in enumerate(deduped):
        if _i < len(_old_tags) and _i < len(_old_imgs) and _old_imgs[_i] == _u:
            kept_tags.append(_old_tags[_i])
        else:
            break

    season = _season_merge_code(canonical.get("season") or "")
    merged_doc = {
        **canonical,
        "source_id": key,
        "images": deduped,
        "image": deduped[0] if deduped else None,
        "images_thumb": deduped_thumb,
        "image_thumb": deduped_thumb[0] if deduped_thumb else None,
        "image_tags": kept_tags,
        "sources": sources,
        "brand_tr": brand_tr,
        "title_tr": title_tr,
        "category": category,
        "city": city,
        "fp_source_id": fp_source_id,
        "season": season,
        "season_label": fashion_scraper._season_label_tr(season),
        "season_rank": _season_rank(season),
        "first_seen": first_seen,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.fashion.update_one({"source_id": key}, {"$set": merged_doc}, upsert=True)

    old_ids = {d["source_id"] for d in group}
    delete_ids = old_ids - {key}
    if delete_ids:
        await db.fashion.delete_many({"source_id": {"$in": list(delete_ids)}})
    return len(delete_ids), len(dropped)


async def _merge_one_doc_group(key: str, group: list, sem: asyncio.Semaphore) -> tuple:
    async with sem:
        try:
            return await asyncio.wait_for(_merge_one_doc_group_inner(key, group), timeout=_MERGE_TIMEOUT_S)
        except asyncio.TimeoutError:
            logger.warning(
                "Fashion merge: group %s timed out (>%ds, likely a stalled photo "
                "download) — skipped, will retry on the next sweep.", key, _MERGE_TIMEOUT_S,
            )
            return 0, 0
        except Exception:
            logger.exception("Fashion merge: group %s failed to merge", key)
            return 0, 0


async def run_fashion_merge_duplicates() -> dict:
    """One-off admin-triggered sweep that finds collections which are really
    the same real-world show scraped from fashion-press AND firstview but
    got saved as two separate documents, because the two sites spell an
    Autumn/Winter season code differently as plain strings ('2026-27AW' vs
    '2026AW' -- see _season_merge_code) and the merge key used to be built
    straight from that unnormalized string. Confirmed live before writing
    this: 0 of 917 saved collections had ever merged across sources.

    Any collection scraped from now on already merges correctly at save
    time (_normalize_fashion_item canonicalizes the season before the merge
    key is ever computed), so this sweep only exists to clean up the
    historical backlog -- it never needs to run automatically. Unlike
    _dedupe_existing_fashion_docs (URL-matching only, no network calls,
    safe on every startup/scrape), this one downloads photos to compare
    them and permanently deletes the loser's copy from R2 -- destructive
    and slower, so it deliberately only ever runs when an admin presses the
    button, exactly like run_fashion_cover_fix. Shares _fashion_lock with
    the other fashion admin actions so none of them race each other.
    """
    if _fashion_lock.locked():
        return {"status": "already_running"}
    async with _fashion_lock:
        started_at = datetime.now(timezone.utc).isoformat()
        docs = await db.fashion.find({}, {"_id": 0}).to_list(length=None)
        groups: dict = {}
        for d in docs:
            groups.setdefault(_fashion_doc_merge_key(d), []).append(d)
        multi = {k: g for k, g in groups.items() if len(g) > 1}
        # A singleton doc can still carry a stale, uncanonicalized season
        # spelling (nothing to merge it WITH, so the grouping above doesn't
        # touch it) -- catch those too, so the feed's season filter and
        # labels are consistent everywhere, not just on merged collections.
        singles_to_relabel = [
            d for g in groups.values() if len(g) == 1
            for d in g
            if _season_merge_code(d.get("season") or "") != (d.get("season") or "")
        ]

        logger.info(
            "Fashion merge: %d cross-source duplicate group(s) found (%d doc(s) total), "
            "%d singleton(s) need only a season relabel.",
            len(multi), sum(len(g) for g in multi.values()), len(singles_to_relabel),
        )
        await db.meta.update_one(
            {"_id": "fashion"},
            {"$set": {"scraping": True, "phase": "merging_duplicates", "merge_total": len(multi), "merge_done": 0}},
            upsert=True,
        )

        sem = asyncio.Semaphore(_IMG_WORK_CONCURRENCY)
        docs_removed = 0
        images_dropped = 0

        async def _run_one(key: str, group: list):
            nonlocal docs_removed, images_dropped
            removed, dropped = await _merge_one_doc_group(key, group, sem)
            docs_removed += removed
            images_dropped += dropped
            await db.meta.update_one({"_id": "fashion"}, {"$inc": {"merge_done": 1}})

        await asyncio.gather(*(_run_one(k, g) for k, g in multi.items()))

        if singles_to_relabel:
            ops = []
            for d in singles_to_relabel:
                season = _season_merge_code(d.get("season") or "")
                ops.append(UpdateOne(
                    {"source_id": d["source_id"]},
                    {"$set": {
                        "season": season,
                        "season_label": fashion_scraper._season_label_tr(season),
                        "season_rank": _season_rank(season),
                    }},
                ))
            await db.fashion.bulk_write(ops, ordered=False)

        logger.info(
            "Fashion merge: done — %d group(s) merged (%d duplicate doc(s) removed, "
            "%d redundant photo(s) dropped from R2), %d singleton(s) relabeled.",
            len(multi), docs_removed, images_dropped, len(singles_to_relabel),
        )
        await db.meta.update_one({"_id": "fashion"}, {"$set": {"scraping": False}})
        await _record_job_run(
            "fashion_merge_duplicates", status="ok", started_at=started_at,
            done=len(multi), total=len(multi),
            detail=f"{len(multi)} grup birleştirildi ({docs_removed} yinelenen silindi, {len(singles_to_relabel)} sezon etiketi düzeltildi)",
        )
        return {
            "status": "ok",
            "groups_merged": len(multi),
            "docs_removed": docs_removed,
            "images_dropped": images_dropped,
            "singles_relabeled": len(singles_to_relabel),
        }


@api.post("/admin/fashion-merge-duplicates")
async def admin_fashion_merge_duplicates(admin: Annotated[dict, Depends(require_admin)]):
    # Fire-and-forget, same reasoning as the other one-off fashion sweeps —
    # can run well past typical HTTP timeouts with hundreds of collections
    # to compare.
    if _fashion_lock.locked():
        return {"status": "already_running"}
    asyncio.create_task(_run_tracked("fashion_merge_duplicates", run_fashion_merge_duplicates()))
    return {"status": "started"}


@api.get("/")
async def root():
    return {"app": "COZA", "status": "ok"}


app.include_router(api)

# Auth is a Bearer JWT in the Authorization header, never a cookie, so
# allow_credentials must stay False — pairing it with allow_origins=["*"]
# is the invalid combo browsers reject anyway. "*" is fine here: this is a
# token-gated read API with no ambient (cookie) credentials to protect.
app.add_middleware(
    CORSMiddleware,
    allow_credentials=False,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


async def _scheduled_catalog_scrape():
    await _run_tracked("catalog_scrape", run_scrape("scheduled_mon_thu_08:00"))


async def _scheduled_fashion_scrape():
    await _run_tracked("fashion_scrape", run_fashion_scrape("scheduled_mon_wed_07:00"))


async def _scheduled_fashion_tag_photos():
    await _run_tracked("fashion_tag_photos", run_fashion_tag_photos())


async def _scheduled_fashion_prune():
    # run_fashion_prune_old() is deliberately lock-free (run_fashion_scrape
    # calls it while already holding _fashion_lock, and asyncio.Lock isn't
    # reentrant). The API route guards it with a .locked() check; this 03:30
    # job needs the same guard, or it can delete db.fashion docs + R2 photos
    # concurrently with a manual backfill / tag / merge that's holding the
    # lock. Skipping is safe: every scrape runs its own prune at the end.
    if _fashion_lock.locked():
        logger.info("Scheduled prune skipped — another fashion job holds the lock.")
        return
    async with _fashion_lock:
        await _run_tracked("fashion_prune_old", run_fashion_prune_old())


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
    await db.fashion.create_index([("season_rank", -1), ("feed_seq", 1)])
    await db.boards.create_index([("user_id", 1), ("parent_id", 1)])
    await db.saved_photos.create_index(
        [("user_id", 1), ("board_id", 1), ("source_id", 1), ("photo_index", 1)], unique=True,
    )
    await db.saved_photos.create_index([("user_id", 1), ("board_id", 1), ("added_at", -1)])
    await seed_users()
    # A CronTrigger built standalone (as below) does NOT inherit the
    # scheduler's `timezone=` — it defaults to the host's local system time,
    # which is UTC on Railway. Without `timezone=` here these jobs silently
    # fired at 08:00/07:00 UTC (11:00/10:00 Istanbul), not the advertised time.
    scheduler.add_job(
        _scheduled_catalog_scrape, CronTrigger(day_of_week="mon,thu", hour=8, minute=0, timezone="Europe/Istanbul"),
        id="scheduled_scrape", replace_existing=True,
    )
    # COZA Fashion: refresh runway collections Mondays and Wednesdays at
    # 07:00 (was every day — cut back to twice a week). Re-scraping doesn't
    # create duplicates either way — items upsert by brand+season+category,
    # so an unchanged collection just gets its updated_at bumped and only
    # genuinely new collections add a new entry.
    scheduler.add_job(
        _scheduled_fashion_scrape, CronTrigger(day_of_week="mon,wed", hour=7, minute=0, timezone="Europe/Istanbul"),
        id="scheduled_fashion_scrape", replace_existing=True,
    )
    # Runway photo tagging (see run_fashion_tag_photos / gemini_client.
    # tag_images): the free Gemini tier caps each model line at a few hundred
    # requests/day, so a multi-thousand-photo backlog can't finish in one run
    # -- image_tags is a resumable prefix of images specifically so a daily
    # job like this one picks back up where the previous run ran out of
    # quota. Runs once a day; a no-op (returns immediately) once every photo
    # in scope is tagged. Self-guards on gemini_client.ENABLED, so it's a
    # harmless no-op if no GEMINI_API_KEY(S) are set.
    scheduler.add_job(
        _scheduled_fashion_tag_photos, CronTrigger(hour=4, minute=0, timezone="Europe/Istanbul"),
        id="scheduled_fashion_tag_firstview", replace_existing=True,
    )
    # Roll the recent-window forward every night (also runs after each
    # scrape). Just before the tag sweep so freshly-aged-out collections
    # aren't tagged. Plain DB deletes, no network — cheap.
    scheduler.add_job(
        _scheduled_fashion_prune, CronTrigger(hour=3, minute=30, timezone="Europe/Istanbul"),
        id="scheduled_fashion_prune", replace_existing=True,
    )
    scheduler.start()
    # A scrape/sweep can't survive a process restart, so a lingering
    # scraping:true here (e.g. the box was OOM-killed mid-backfill) is
    # always stale — clear it so the UI doesn't show a frozen progress bar,
    # and record it in the "son işlemler" history so a restart mid-sweep
    # actually explains itself instead of just quietly resetting.
    stale = await db.meta.find_one_and_update(
        {"_id": "fashion", "scraping": True},
        {"$set": {"scraping": False, "phase": "interrupted"}},
    )
    if stale:
        job = {"tagging_photos": "fashion_tag_photos", "tagging_firstview": "fashion_tag_photos",
               "fixing_covers": "fashion_cover_fix", "generating_thumbnails": "fashion_thumbnails",
               "merging_duplicates": "fashion_merge_duplicates", "repairing_urls": "fashion_repair_urls",
               "dropping_dead_images": "fashion_drop_dead_images",
               "cleaning_cruft": "fashion_clean_cruft"}.get(stale.get("phase"), "fashion_scrape")
        await _record_job_run(
            job, status="error",
            started_at=stale.get("scrape_started_at") or datetime.now(timezone.utc).isoformat(),
            reason=f"Sunucu yeniden başladı (ör. bellek yetersizliği/deploy) ve '{stale.get('phase')}' "
                   f"aşamasında yarım kaldı. Kaldığı yerden devam etmek için işlemi tekrar başlatın.",
        )
    await _seed_if_empty()
    await _migrate_fashion_schema()
    await _dedupe_existing_fashion_docs()
    await _seed_fashion_if_empty()
    await _backfill_fashion_if_needed()
    # Let browsers load fashion photos straight from the R2 bucket (see
    # image_store.ensure_cors_configured's docstring for why this is
    # needed). Blocking network call, so keep it off the event loop.
    await asyncio.to_thread(image_store.ensure_cors_configured)


@app.on_event("shutdown")
async def on_shutdown():
    scheduler.shutdown(wait=False)
    client.close()
