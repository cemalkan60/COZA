"""
COZA Fashion — Cloudflare R2 image cache (sharded across N accounts).

Fashion photos are downloaded once, at scrape time, and re-hosted on our
own R2 storage so the app serves them instantly from our CDN instead of
live-proxying the source site on every view.

Storage is sharded across one OR MORE Cloudflare accounts, because the free
tier is 10 GB per account and the rolling recent-runway window (see
FASHION_RECENT_MONTHS in server.py) at full photo coverage needs more than
that. Each photo is content-addressed and hashed to a fixed shard, so
re-scraping never re-uploads and every read/delete can find the right
bucket from the URL alone.

Configuration (env vars):
  R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY /
  R2_BUCKET_NAME / R2_PUBLIC_BASE_URL
                     The first shard, if set (the app's original
                     single-bucket config — left untouched).
  R2_ACCOUNTS_JSON   JSON array of ADDITIONAL accounts, each:
                       {"account_id": "...", "access_key_id": "...",
                        "secret_access_key": "...", "bucket": "...",
                        "public_base_url": "https://xxx.r2.dev"}
                     Merged after the singular-var account. Either or both
                     may be set; de-duped by account_id + bucket.
  R2_FULLRES_MAX_WIDTH  Longest edge (px) a stored "full-res" photo is
                        downscaled to. Default 1600 — plenty for phone
                        viewing + pinch-zoom, and roughly halves storage
                        vs. keeping source originals.

Deliberately all-optional: with no accounts configured, ENABLED is False
and every function is a no-op passthrough returning the original URL, so
the app keeps working via the live proxy exactly as before.
"""
import os
import json
import hashlib
import logging
import threading
import time
from typing import Optional
from urllib.parse import urlparse

import requests
from requests.adapters import HTTPAdapter

logger = logging.getLogger("coza.image_store")


def _load_accounts() -> list:
    """The original singular-var bucket (if set) as the first shard, then any
    listed in R2_ACCOUNTS_JSON appended. De-duped by account_id + bucket so
    the same bucket can't land in the list twice and skew the shard hash."""
    accounts: list = []
    if os.environ.get("R2_ACCOUNT_ID"):
        accounts.append({
            "account_id": os.environ.get("R2_ACCOUNT_ID", ""),
            "access_key_id": os.environ.get("R2_ACCESS_KEY_ID", ""),
            "secret_access_key": os.environ.get("R2_SECRET_ACCESS_KEY", ""),
            "bucket": os.environ.get("R2_BUCKET_NAME", ""),
            "public_base_url": os.environ.get("R2_PUBLIC_BASE_URL", "").rstrip("/"),
        })

    raw = os.environ.get("R2_ACCOUNTS_JSON", "").strip()
    if raw:
        try:
            parsed = json.loads(raw)
        except Exception as exc:  # noqa: BLE001
            logger.error("image_store: R2_ACCOUNTS_JSON is not valid JSON: %s", exc)
            parsed = []
        for a in parsed if isinstance(parsed, list) else []:
            try:
                accounts.append({
                    "account_id": a["account_id"],
                    "access_key_id": a["access_key_id"],
                    "secret_access_key": a["secret_access_key"],
                    "bucket": a["bucket"],
                    "public_base_url": a["public_base_url"].rstrip("/"),
                })
            except (KeyError, TypeError, AttributeError):
                logger.error("image_store: skipping malformed R2 account entry: %r", a)

    seen: set = set()
    deduped: list = []
    for a in accounts:
        sig = (a["account_id"], a["bucket"])
        if sig in seen:
            continue
        seen.add(sig)
        deduped.append(a)
    return deduped


_ACCOUNTS = [
    a for a in _load_accounts()
    if a["account_id"] and a["access_key_id"] and a["secret_access_key"]
    and a["bucket"] and a["public_base_url"]
]

ENABLED = bool(_ACCOUNTS)

# Every public host our photos can be served from — the image-proxy host
# allowlist in server.py checks against this. PUBLIC_HOSTNAME kept as an
# alias (the first shard) for any single-value caller.
PUBLIC_HOSTNAMES = {
    (urlparse(a["public_base_url"]).hostname or "").lower() for a in _ACCOUNTS
}
PUBLIC_HOSTNAMES.discard("")
PUBLIC_HOSTNAME = next(iter(PUBLIC_HOSTNAMES), None)

_FULLRES_MAX_WIDTH = int(os.environ.get("R2_FULLRES_MAX_WIDTH", "1600"))
_THUMB_MAX_WIDTH = 480

_DOWNLOAD_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
    ),
}

# One pooled requests.Session per worker thread. cache_images_with_thumb runs
# this module across a ThreadPoolExecutor, and a plain requests.get() opens a
# fresh TCP+TLS connection on every call — thousands of them per backfill, all
# to the same handful of hosts (the source sites and the R2 public subdomain).
# A per-thread pooled Session reuses connections instead. Thread-local, so no
# Session object is ever touched by two threads at once.
_thread_local = threading.local()


def _http() -> requests.Session:
    s = getattr(_thread_local, "session", None)
    if s is None:
        s = requests.Session()
        adapter = HTTPAdapter(pool_connections=8, pool_maxsize=8)
        s.mount("https://", adapter)
        s.mount("http://", adapter)
        _thread_local.session = s
    return s


_clients: dict = {}


def _client_for(acc: dict):
    aid = acc["account_id"]
    if aid not in _clients:
        import boto3  # lazy — only needed once R2 is configured
        from botocore.config import Config

        _clients[aid] = boto3.client(
            "s3",
            endpoint_url=f"https://{aid}.r2.cloudflarestorage.com",
            aws_access_key_id=acc["access_key_id"],
            aws_secret_access_key=acc["secret_access_key"],
            region_name="auto",
            # botocore's default pool is 10; the scrape uploads far more than
            # 10 photos to one R2 account at once, so extra connections were
            # being opened, used once and thrown away ("Connection pool is
            # full, discarding connection" warnings). Size it to the scrape's
            # real concurrency ceiling so connections get reused instead.
            config=Config(max_pool_connections=50),
        )
    return _clients[aid]


def _key_for(source_url: str) -> str:
    """Stable, content-addressed key so re-scraping the same photo never
    re-uploads it."""
    digest = hashlib.sha1(source_url.encode("utf-8")).hexdigest()
    ext = "jpg"
    path = source_url.lower().split("?")[0]
    for candidate in ("jpeg", "jpg", "png", "webp"):
        if path.endswith("." + candidate):
            ext = candidate
            break
    return f"fashion/{digest}.{ext}"


def _thumb_key_for(full_key: str) -> str:
    if full_key.startswith("fashion/"):
        return "fashion-thumb/" + full_key[len("fashion/"):]
    return "fashion-thumb/" + full_key


def _shard_for_key(key: str) -> dict:
    """Which account a given object key lives in — sha1(key) mod N, so a
    photo (and its paired thumb, via the shared digest) always maps to the
    same bucket."""
    h = int(hashlib.sha1(key.encode("utf-8")).hexdigest(), 16)
    return _ACCOUNTS[h % len(_ACCOUNTS)]


def _account_for_url(public_url: str) -> "Optional[dict]":
    for a in _ACCOUNTS:
        if public_url.startswith(a["public_base_url"] + "/"):
            return a
    return None


def _key_from_url(url: str) -> "Optional[str]":
    a = _account_for_url(url or "")
    if not a:
        return None
    return url[len(a["public_base_url"]) + 1:].split("?")[0]


def is_our_url(url: str) -> bool:
    """True if `url` points at one of our R2 buckets (as opposed to a live
    source-site URL that was never cached). Lets callers tell 'this photo is
    genuinely gone from storage' apart from 'this was never on storage'."""
    return _key_from_url(url or "") is not None


def find_object_url(url: str) -> "Optional[str]":
    """Where a cached photo actually lives NOW. Given one of our R2 URLs,
    return the URL on whichever bucket currently holds that object — the
    shard-correct one first, then the others — or None if it's on none of
    them. Repairs URLs stranded on a bucket that `hash % N` no longer picks
    (bucket count changed) or that was emptied by hand."""
    if not ENABLED or not url:
        return None
    key = _key_from_url(url)
    if not key:
        return None  # not one of ours — a live source-site URL, leave it
    sc = _shard_for_key(key)
    for a in [sc] + [x for x in _ACCOUNTS if x is not sc]:
        if _object_exists(_client_for(a), a["bucket"], key):
            u = f"{a['public_base_url']}/{key}"
            return u if u != url.split("?")[0] else url
    return None


def _derive_variants(content: bytes, content_type: str) -> tuple:
    """From one download, produce (full_bytes, full_ctype, thumb_bytes).

    Memory-frugal on purpose — this runs many-at-once during a scrape and
    OOM-killed the box once: ONE PIL decode, JPEG draft-mode so the decoder
    downscales while reading (a big runway JPEG never becomes a full-size
    bitmap in RAM), then shrink the same image in place — full-res save
    first, then further down to the thumbnail. No .copy(), no second open.
    On any Pillow failure the original bytes are stored as-is and the thumb
    falls back to them, so a decode problem never costs the photo.
    """
    try:
        from io import BytesIO
        from PIL import Image

        img = Image.open(BytesIO(content))
        if (img.format or "").upper() == "JPEG":
            # decoder downscales to ~this size while reading the file
            img.draft("RGB", (_FULLRES_MAX_WIDTH, _FULLRES_MAX_WIDTH))
        img = img.convert("RGB")

        if max(img.size) > _FULLRES_MAX_WIDTH:
            img.thumbnail((_FULLRES_MAX_WIDTH, _FULLRES_MAX_WIDTH))
            fb = BytesIO()
            img.save(fb, format="JPEG", quality=82, optimize=True)
            full_bytes, full_ctype = fb.getvalue(), "image/jpeg"
        else:
            full_bytes, full_ctype = content, content_type

        img.thumbnail((_THUMB_MAX_WIDTH, _THUMB_MAX_WIDTH * 3))  # same img, further down
        tb = BytesIO()
        img.save(tb, format="JPEG", quality=78, optimize=True)
        thumb_bytes = tb.getvalue()
        img.close()
        return full_bytes, full_ctype, thumb_bytes
    except Exception as exc:  # noqa: BLE001
        logger.warning("image_store: could not process a photo (%s) — storing as-is", exc)
        return content, content_type, content


def _object_exists(client, bucket: str, key: str) -> bool:
    try:
        client.head_object(Bucket=bucket, Key=key)
        return True
    except Exception:
        return False


# Per-account CORS state: None = not tried, True = set OK, str = last error.
# expo-image's web renderer loads photos with crossOrigin="anonymous", so a
# bucket with no CORS policy shows BLANK on web even though the URL is fine
# in a plain <img>. A new account's API token is often "Object Read & Write"
# only, which can't call put_bucket_cors — so this now retries on every
# startup (not one-shot) and the error is surfaced (cors_status()).
_cors_state: dict = {}

_CORS_RULES = {"CORSRules": [{
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 86400,
}]}


def ensure_cors_configured() -> None:
    """Try to set the browser-load CORS policy on every bucket that isn't
    known-good yet. Safe to call on every startup."""
    if not ENABLED:
        return
    for acc in _ACCOUNTS:
        aid = acc["account_id"]
        if _cors_state.get(aid) is True:
            continue
        try:
            _client_for(acc).put_bucket_cors(Bucket=acc["bucket"], CORSConfiguration=_CORS_RULES)
            _cors_state[aid] = True
            logger.info("image_store: CORS policy set on %s", acc["bucket"])
        except Exception as exc:  # noqa: BLE001
            _cors_state[aid] = f"{type(exc).__name__}: {exc}"
            logger.error(
                "image_store: could NOT set CORS on %s (%s) — web images from this "
                "bucket will be blank until you add the policy in the Cloudflare "
                "dashboard (Settings -> CORS Policy).", acc["bucket"], exc,
            )


_cors_probe_cache: dict = {}  # public_base -> (checked_at, ok, detail)


def cors_status() -> list:
    """Per-bucket CORS state for the admin panel — the REAL test: a browser
    CORS preflight against the public URL (needs no credentials), so it
    reflects a policy set by hand in the Cloudflare dashboard, not just
    whether our API token could call put_bucket_cors. Cached 2 min."""
    out = []
    for i, acc in enumerate(_ACCOUNTS, 1):
        base = acc["public_base_url"]
        cached = _cors_probe_cache.get(base)
        if cached and (time.time() - cached[0] < 120):
            _, ok, detail = cached
        else:
            ok, detail = False, ""
            try:
                r = requests.options(
                    f"{base}/_corsprobe",
                    headers={"Origin": "https://coza.app", "Access-Control-Request-Method": "GET"},
                    timeout=6,
                )
                if r.headers.get("access-control-allow-origin"):
                    ok = True
                else:
                    detail = f"no ACAO header (HTTP {r.status_code})"
            except Exception as exc:  # noqa: BLE001
                detail = f"{type(exc).__name__}"
            _cors_probe_cache[base] = (time.time(), ok, detail)
        out.append({
            "index": i,
            "bucket": acc["bucket"],
            "host": (urlparse(base).hostname or ""),
            "ok": ok,
            "detail": detail,
        })
    return out


def _wait_until_publicly_readable(public_url: str, attempts: int = 5, delay: float = 0.35) -> None:
    """R2's public subdomain briefly 503s an object right after upload while
    it propagates to the edge — poll until it serves so a caller never gets
    a URL that momentarily 404/503s. Best-effort and bounded."""
    for _ in range(attempts):
        try:
            if _http().head(public_url, timeout=5).status_code < 400:
                return
        except Exception:
            pass
        time.sleep(delay)


def delete_image(public_url: str) -> None:
    """Permanently remove one cached photo (and its paired thumbnail) from
    whichever shard holds it. Best-effort and silent: a URL that was never
    one of ours, or is already gone, is a no-op — never raises."""
    if not ENABLED or not public_url:
        return
    acc = _account_for_url(public_url)
    if acc is None:
        return
    key = public_url[len(acc["public_base_url"]) + 1:]
    client = _client_for(acc)
    try:
        client.delete_object(Bucket=acc["bucket"], Key=key)
    except Exception as exc:  # noqa: BLE001
        logger.warning("image_store: failed to delete %s: %s", public_url, exc)
    if key.startswith("fashion/"):
        try:
            client.delete_object(Bucket=acc["bucket"], Key=_thumb_key_for(key))
        except Exception:
            pass


def cache_image(source_url: str) -> str:
    """Return a URL to a copy of `source_url` on our own R2 storage (the
    right shard for its key), uploading it first if unseen. Falls back to
    the original URL on any failure or when R2 isn't configured."""
    if not ENABLED or not source_url:
        return source_url

    key = _key_for(source_url)
    acc = _shard_for_key(key)
    public_url = f"{acc['public_base_url']}/{key}"
    client = _client_for(acc)

    if _object_exists(client, acc["bucket"], key):
        return public_url

    try:
        resp = _http().get(source_url, headers=_DOWNLOAD_HEADERS, timeout=20)
        resp.raise_for_status()
        body, ctype, _ = _derive_variants(resp.content, resp.headers.get("Content-Type", "image/jpeg"))
        client.put_object(Bucket=acc["bucket"], Key=key, Body=body, ContentType=ctype or "image/jpeg")
        _wait_until_publicly_readable(public_url)
        return public_url
    except Exception as exc:  # noqa: BLE001
        logger.warning("image_store: failed to cache %s: %s", source_url, exc)
        return source_url


def cache_image_with_thumb(source_url: str) -> tuple:
    """Like cache_image, but also produces a 480px thumbnail alongside the
    (dimension-capped) full-res photo. One source download, up to two
    uploads, each skipped if already present. Returns (full_url, thumb_url);
    degrades to (source_url, source_url) on a download/upload failure and to
    (full_url, full_url) on a thumbnailing failure."""
    if not ENABLED or not source_url:
        return source_url, source_url

    full_key = _key_for(source_url)
    thumb_key = _thumb_key_for(full_key)
    acc = _shard_for_key(full_key)  # thumb shares the digest -> same shard
    client = _client_for(acc)
    full_url = f"{acc['public_base_url']}/{full_key}"
    thumb_url = f"{acc['public_base_url']}/{thumb_key}"

    full_exists = _object_exists(client, acc["bucket"], full_key)
    thumb_exists = _object_exists(client, acc["bucket"], thumb_key)
    if full_exists and thumb_exists:
        return full_url, thumb_url

    try:
        resp = _http().get(source_url, headers=_DOWNLOAD_HEADERS, timeout=20)
        resp.raise_for_status()
        full_body, full_ctype, thumb_body = _derive_variants(
            resp.content, resp.headers.get("Content-Type", "image/jpeg")
        )
        del resp
    except Exception as exc:  # noqa: BLE001
        logger.warning("image_store: failed to download %s: %s", source_url, exc)
        return source_url, source_url

    if not full_exists:
        try:
            client.put_object(Bucket=acc["bucket"], Key=full_key, Body=full_body, ContentType=full_ctype or "image/jpeg")
        except Exception as exc:  # noqa: BLE001
            logger.warning("image_store: failed to upload full %s: %s", source_url, exc)
            return source_url, source_url

    if not thumb_exists:
        try:
            client.put_object(Bucket=acc["bucket"], Key=thumb_key, Body=thumb_body, ContentType="image/jpeg")
        except Exception as exc:  # noqa: BLE001
            logger.warning("image_store: failed to make/upload thumb for %s: %s", source_url, exc)
            thumb_url = full_url

    if not full_exists:
        _wait_until_publicly_readable(full_url)
    return full_url, thumb_url


def cache_bytes_with_thumb(content: bytes, content_type: str, key_hint: str) -> tuple:
    """A5: like cache_image_with_thumb, but for bytes already in hand (a
    user's own upload) instead of a source URL to fetch — there's nothing
    to download, so this skips straight to deriving variants and
    uploading. `key_hint` should be unique per upload (a uuid); unlike the
    scraped-photo path this isn't content-addressed, so re-uploading the
    same file twice makes two objects — acceptable for the rare, manual
    "add a photo" flow. Returns (full_url, thumb_url), or (None, None) on
    any failure."""
    if not ENABLED or not content:
        return None, None
    full_key = f"user/{key_hint}.jpg"
    thumb_key = f"user/{key_hint}_thumb.jpg"
    acc = _shard_for_key(full_key)
    client = _client_for(acc)
    full_url = f"{acc['public_base_url']}/{full_key}"
    thumb_url = f"{acc['public_base_url']}/{thumb_key}"
    try:
        full_body, full_ctype, thumb_body = _derive_variants(content, content_type or "image/jpeg")
        client.put_object(Bucket=acc["bucket"], Key=full_key, Body=full_body, ContentType=full_ctype or "image/jpeg")
        client.put_object(Bucket=acc["bucket"], Key=thumb_key, Body=thumb_body, ContentType="image/jpeg")
        _wait_until_publicly_readable(full_url)
        return full_url, thumb_url
    except Exception as exc:  # noqa: BLE001
        logger.warning("image_store: failed to cache an uploaded photo: %s", exc)
        return None, None


def backfill_thumb(full_url: str) -> Optional[str]:
    """Generate a thumbnail for a photo already cached at full resolution,
    re-reading it from our own bucket (no load on the source site). Returns
    the thumb URL, or None if `full_url` isn't one of ours or the work
    failed."""
    if not ENABLED or not full_url:
        return None
    acc = _account_for_url(full_url)
    if acc is None:
        return None
    full_key = full_url[len(acc["public_base_url"]) + 1:]
    thumb_key = _thumb_key_for(full_key)
    thumb_url = f"{acc['public_base_url']}/{thumb_key}"
    client = _client_for(acc)

    if _object_exists(client, acc["bucket"], thumb_key):
        return thumb_url
    try:
        resp = _http().get(full_url, headers=_DOWNLOAD_HEADERS, timeout=20)
        resp.raise_for_status()
        _, _, thumb_body = _derive_variants(resp.content, "image/jpeg")
        client.put_object(Bucket=acc["bucket"], Key=thumb_key, Body=thumb_body, ContentType="image/jpeg")
        return thumb_url
    except Exception as exc:  # noqa: BLE001
        logger.warning("image_store: failed to backfill thumb for %s: %s", full_url, exc)
        return None


def blurhash_for_url(thumb_url: str) -> Optional[str]:
    """D5: a short placeholder string for `thumb_url` (expo-image renders it
    as a blurred preview while the real thumbnail loads). Deliberately its
    own standalone function rather than threaded through cache_image_with_
    thumb's return shape — that function is on the hot scraping path with
    several call sites, and a blur placeholder is cosmetic, not worth the
    risk of touching it. Re-downloads the (small, already-cached) thumbnail;
    best-effort, None on any failure — callers should just skip the
    placeholder, never block on it."""
    if not thumb_url:
        return None
    try:
        import blurhash
        from io import BytesIO
        from PIL import Image

        resp = _http().get(thumb_url, headers=_DOWNLOAD_HEADERS, timeout=15)
        resp.raise_for_status()
        img = Image.open(BytesIO(resp.content)).convert("RGB")
        img.thumbnail((32, 32))
        return blurhash.encode(img, x_components=4, y_components=3)
    except Exception as exc:  # noqa: BLE001
        logger.warning("image_store: blurhash failed for %s: %s", thumb_url, exc)
        return None


# Modest by default — this runs inside a per-collection semaphore in
# server.py, so real image-decode concurrency is this x that. Too high and
# the box OOM-kills mid-scrape (seen live). Both are env-tunable.
_CACHE_WORKERS = int(os.environ.get("R2_CACHE_WORKERS", "3"))


def cache_images_with_thumb(urls: list, max_workers: int = None) -> list:
    """cache_image_with_thumb over a whole gallery concurrently. Returns a
    list of (full_url, thumb_url) tuples in the same order as `urls`."""
    if not urls:
        return []
    if len(urls) == 1:
        return [cache_image_with_thumb(urls[0])]
    from concurrent.futures import ThreadPoolExecutor

    workers = min(max_workers or _CACHE_WORKERS, len(urls))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(cache_image_with_thumb, urls))


def consolidate_into_primary(max_workers: int = None) -> dict:
    """Copy every object from every secondary R2 account (_ACCOUNTS[1:] —
    added via R2_ACCOUNTS_JSON to spread storage across several accounts'
    free 10 GB tiers) into the primary one (_ACCOUNTS[0]), now that the
    primary is on a paid plan and doesn't need the sharding for space
    reasons any more. A single Custom Domain (see server.py's
    run_fashion_migrate_image_domain, which already rewrote every stored
    URL to point at the primary's domain) only serves the primary bucket —
    this makes that bucket actually hold every object those URLs now
    claim, not just the ones that happened to shard onto it originally.

    Cross-account (a fully separate Cloudflare account/endpoint/credentials
    each), so this is a real GET-then-PUT relay through this server, not a
    single S3 copy_object call. Skips a key already present in the primary
    bucket, so it's safe to re-run/resume after a timeout or a crash."""
    if not ENABLED or len(_ACCOUNTS) < 2:
        return {"status": "error", "detail": "Birden fazla depo (R2 account) yapılandırılmamış, taşınacak bir şey yok."}
    from concurrent.futures import ThreadPoolExecutor

    primary = _ACCOUNTS[0]
    primary_client = _client_for(primary)
    copied = already_there = failed = 0

    def _list_keys(acc: dict) -> list:
        client = _client_for(acc)
        keys: list = []
        for page in client.get_paginator("list_objects_v2").paginate(Bucket=acc["bucket"]):
            keys.extend(obj["Key"] for obj in page.get("Contents", []))
        return keys

    def _copy_one(acc: dict, key: str) -> str:
        try:
            if _object_exists(primary_client, primary["bucket"], key):
                return "already_there"
            obj = _client_for(acc).get_object(Bucket=acc["bucket"], Key=key)
            body = obj["Body"].read()
            content_type = obj.get("ContentType") or "application/octet-stream"
            primary_client.put_object(Bucket=primary["bucket"], Key=key, Body=body, ContentType=content_type)
            return "copied"
        except Exception as exc:  # noqa: BLE001
            logger.error("image_store consolidate: failed to copy %s from %s: %s", key, acc["bucket"], exc)
            return "failed"

    workers = max_workers or _CACHE_WORKERS
    for acc in _ACCOUNTS[1:]:
        keys = _list_keys(acc)
        if not keys:
            continue
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for result in pool.map(lambda k, acc=acc: _copy_one(acc, k), keys):
                if result == "copied":
                    copied += 1
                elif result == "already_there":
                    already_there += 1
                else:
                    failed += 1

    return {"status": "ok" if not failed else "partial", "copied": copied, "already_there": already_there, "failed": failed}
