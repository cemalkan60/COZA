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
            if _FASHION_CATEGORY_PRIORITY.get(other["category"], 9) < _FASHION_CATEGORY_PRIORITY.get(
                canonical["category"], 9
            ):
                canonical["category"] = other["category"]

    return list(groups.values()), obsolete


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
    if image_store.ENABLED:
        # Re-host each photo on our own R2 bucket so the app serves it
        # instantly instead of live-proxying the source site per view.
        # No-op (returns the original URL) until R2 is configured.
        unique_urls = [image_store.cache_image(u) for u in unique_urls]
    g["images"] = unique_urls
    g["image"] = unique_urls[0] if unique_urls else None
    return g


async def _finalize_and_save_group(g: dict, sem: asyncio.Semaphore, now_iso: str) -> bool:
    """Finish one merge group and upsert it immediately — so collections
    show up in the feed as each one finishes instead of only after every
    single one of the ~90+ groups in a scrape is done. `sem` caps how many
    of these run at once (each is a blocking thread doing network I/O).
    """
    ok = False
    try:
        async with sem:
            finalized = await asyncio.to_thread(_finalize_fashion_group, g)
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


#  The two fashion-press.net season slugs, and the firstview.com show-year,
# that between them cover "everything shown since January 2026": ready-to-wear
# runway/lookbook seasons are announced roughly 6 months ahead of their name,
# so a collection actually shown Jan-Sep 2026 carries the season name
# "2026-27 Autumn/Winter" (shown Feb/Mar 2026) or "2027 Spring/Summer" (shown
# Sept/Oct 2026 — the latter still ongoing as of this writing, so a backfill
# run today won't yet have all of it; re-running later picks up the rest).
BACKFILL_FASHION_PRESS_SEASONS = ("2026-27aw", "2027ss")
BACKFILL_FIRSTVIEW_YEAR = 2026


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

        async def collect(label: str, fn, *args):
            try:
                got = await asyncio.to_thread(fn, *args)
                raw_items.extend(got or [])
            except Exception:
                logger.exception("Fashion scrape source failed (%s)", label)

        if backfill:
            for season in BACKFILL_FASHION_PRESS_SEASONS:
                for gender in ("women", "men"):
                    await collect(
                        f"fashion-press/{gender}/{season}",
                        fashion_scraper.scrape_collections, 3000, gender, season,
                    )
            await collect(
                "fashion-press/haute-couture",
                fashion_scraper.scrape_haute_couture, 500, 200,
            )
            for cat in FASHION_CATEGORIES:
                await collect(
                    f"firstview/{cat}/{BACKFILL_FIRSTVIEW_YEAR}",
                    firstview_scraper.scrape_category, cat, 3000, BACKFILL_FIRSTVIEW_YEAR, 60, 6,
                )
        else:
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

        by_source: dict = {}
        for r in raw_items:
            by_source[r.get("source", "?")] = by_source.get(r.get("source", "?"), 0) + 1
        logger.info("Fashion scrape (%s): %d raw items collected (%s)", reason, len(raw_items), by_source)

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
                        "scrape_started_at": now_iso,
                        "reason": reason,
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
            sem = asyncio.Semaphore(8)
            results = await asyncio.gather(
                *(_finalize_and_save_group(g, sem, now_iso) for g in groups)
            )
            saved = sum(1 for ok in results if ok)
            # Belt-and-suspenders: also sweep the DB itself for duplicates
            # this scrape's own url-merge pass couldn't see (a doc saved by
            # an earlier scrape, before this dedup logic existed, whose
            # merge key this run's raw items no longer reproduce at all).
            await _dedupe_existing_fashion_docs()
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
        except Exception:
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
            return {"status": "error", **meta}

        logger.info(
            "Fashion scrape done (%s): %d raw items -> %d/%d groups saved, %.1fs",
            reason, len(raw_items), saved, len(groups),
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

    asyncio.create_task(_run())


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
    if image_store.PUBLIC_HOSTNAME and hostname == image_store.PUBLIC_HOSTNAME:
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
    fp_id = doc.get("fp_source_id")
    if not fp_id or doc.get("gallery_fetched"):
        return {"images": doc.get("images") or []}
    try:
        images = await asyncio.to_thread(fashion_scraper.fetch_collection_images, fp_id)
        if image_store.ENABLED:
            images = await asyncio.to_thread(lambda: [image_store.cache_image(u) for u in images])
    except Exception:
        images = []
    update = {"gallery_fetched": True}
    if images:
        update["images"] = images
    # Mark fetched even on failure/empty so a broken collection doesn't
    # re-trigger this fetch (and re-hit fashion-press.net) on every view —
    # the existing thumbnail stays as the fallback.
    await db.fashion.update_one({"source_id": source_id}, {"$set": update})
    return {"images": images or doc.get("images") or []}


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


@api.post("/admin/fashion-backfill")
async def admin_fashion_backfill(admin: Annotated[dict, Depends(require_admin)]):
    # One-off full historical pull (see run_fashion_scrape's `backfill=True`
    # path) — everything since January 2026, not just each source's latest
    # page. Much slower than a regular scrape (hundreds of extra requests),
    # so this is a separate button from the regular "tara" one, not something
    # the twice-weekly schedule ever runs on its own.
    if _fashion_lock.locked():
        return {"status": "already_running"}
    asyncio.create_task(run_fashion_scrape("backfill_2026", backfill=True))
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
    # COZA Fashion: refresh runway collections Mondays and Wednesdays at
    # 07:00 (was every day — cut back to twice a week). Re-scraping doesn't
    # create duplicates either way — items upsert by brand+season+category,
    # so an unchanged collection just gets its updated_at bumped and only
    # genuinely new collections add a new entry.
    scheduler.add_job(
        run_fashion_scrape, CronTrigger(day_of_week="mon,wed", hour=7, minute=0, timezone="Europe/Istanbul"),
        args=["scheduled_mon_wed_07:00"],
        id="scheduled_fashion_scrape", replace_existing=True,
    )
    scheduler.start()
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
