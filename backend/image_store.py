"""
COZA Fashion — Cloudflare R2 image cache.

Fashion photos are currently proxied live from their source site on every
view (see /api/fashion/image-proxy in server.py), which is what makes them
slow to open. This module downloads each photo once, at scrape time, and
re-hosts it on our own R2 bucket — the app then serves photos instantly
from our own CDN-backed storage instead of hitting the source site per view.

Configuration (all via env vars, all required to activate):
  R2_ACCOUNT_ID          Cloudflare account id
  R2_ACCESS_KEY_ID       R2 API token access key
  R2_SECRET_ACCESS_KEY   R2 API token secret key
  R2_BUCKET_NAME         the bucket to upload into
  R2_PUBLIC_BASE_URL     the bucket's public base URL (its r2.dev subdomain,
                         or a custom domain mapped to it) — used to build the
                         URL we hand back to the app after upload.

Deliberately all-optional: with any of these unset, ENABLED is False and
cache_image() is a no-op passthrough that returns the original URL, so the
app keeps working exactly as it does today (via the live proxy) until R2 is
configured. Nothing above imports boto3 at module load either, so a missing
`boto3` package doesn't break the rest of the app — it only matters once
R2 is actually configured and cache_image() is called.
"""
import os
import hashlib
import logging
import time
from typing import Optional
from urllib.parse import urlparse

import requests

logger = logging.getLogger("coza.image_store")

_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "")
_ACCESS_KEY = os.environ.get("R2_ACCESS_KEY_ID", "")
_SECRET_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
_BUCKET = os.environ.get("R2_BUCKET_NAME", "")
_PUBLIC_BASE = os.environ.get("R2_PUBLIC_BASE_URL", "").rstrip("/")

# Hostname photos get served from once cache_image() has re-hosted them —
# exposed so other modules (the image-proxy host allowlist in server.py)
# can recognize our own CDN URLs without hardcoding the bucket's domain.
PUBLIC_HOSTNAME = (urlparse(_PUBLIC_BASE).hostname or "").lower() if _PUBLIC_BASE else None

ENABLED = bool(_ACCOUNT_ID and _ACCESS_KEY and _SECRET_KEY and _BUCKET and _PUBLIC_BASE)

_DOWNLOAD_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
    ),
}

_client = None


def _get_client():
    global _client
    if _client is None:
        import boto3  # imported lazily — only needed once R2 is configured

        _client = boto3.client(
            "s3",
            endpoint_url=f"https://{_ACCOUNT_ID}.r2.cloudflarestorage.com",
            aws_access_key_id=_ACCESS_KEY,
            aws_secret_access_key=_SECRET_KEY,
            region_name="auto",
        )
    return _client


def _key_for(source_url: str) -> str:
    """Stable, content-addressed key so re-scraping the same photo (e.g. an
    unchanged collection re-scraped the next day) never re-uploads it.
    """
    digest = hashlib.sha1(source_url.encode("utf-8")).hexdigest()
    ext = "jpg"
    path = source_url.lower().split("?")[0]
    for candidate in ("jpeg", "jpg", "png", "webp"):
        if path.endswith("." + candidate):
            ext = candidate
            break
    return f"fashion/{digest}.{ext}"


# Grid/list tiles never render a photo anywhere near full runway resolution
# (a few hundred px wide at most, even on a large desktop grid), but every
# photo was being cached and served at its original full size regardless —
# confirmed live as the main cause of slow/blank-looking grids: the browser
# was downloading full-resolution runway photos (often 1-2MB+) just to
# paint a ~180px-wide thumbnail. 480px covers any grid tile with room for
# a retina display; the full-resolution original is still cached and used
# whenever a photo is actually opened (see cache_image/cache_image_with_thumb
# callers in server.py).
_THUMB_MAX_WIDTH = 480


def _thumb_key_for(full_key: str) -> str:
    """'fashion/<hash>.jpg' -> 'fashion-thumb/<hash>.jpg' — same digest,
    parallel prefix, so a thumbnail and its full-resolution source are
    always trivially derivable from one another without a DB lookup.
    """
    if full_key.startswith("fashion/"):
        return "fashion-thumb/" + full_key[len("fashion/") :]
    return "fashion-thumb/" + full_key


def _make_thumbnail(content: bytes) -> bytes:
    """Resize downloaded photo bytes to a small JPEG for grid/list display.
    Runway photos are portrait-oriented, so capping width is what actually
    matters — the generous height cap is just a safety bound for an
    unusually wide source photo.
    """
    from io import BytesIO

    from PIL import Image

    img = Image.open(BytesIO(content))
    img = img.convert("RGB")
    img.thumbnail((_THUMB_MAX_WIDTH, _THUMB_MAX_WIDTH * 3))
    out = BytesIO()
    img.save(out, format="JPEG", quality=78, optimize=True)
    return out.getvalue()


def _object_exists(client, key: str) -> bool:
    try:
        client.head_object(Bucket=_BUCKET, Key=key)
        return True
    except Exception:
        return False


_cors_checked = False


def ensure_cors_configured() -> None:
    """Allow browsers to load photos straight from the R2 bucket.

    The app wants photos served directly from R2 (fastest — no extra hop
    through our own backend), but a browser only allows a web page to load
    an image cross-origin (a different domain than the page itself) if the
    bucket says it's OK, via CORS headers. R2 buckets don't send those by
    default, which silently breaks image loading in some browser image
    components (expo-image's web renderer, notably) even though the same
    URL loads fine in a plain <img> tag.

    This sets that permission on the bucket itself, once per process
    (`_cors_checked`) — cheap, idempotent, and safe to call on every
    startup, so no separate manual setup step is ever needed. Best-effort:
    on any failure we log and move on, since a failure here should never
    stop the app from starting (photos would just fall back to whatever
    they were doing before).
    """
    global _cors_checked
    if _cors_checked or not ENABLED:
        return
    _cors_checked = True
    try:
        client = _get_client()
        client.put_bucket_cors(
            Bucket=_BUCKET,
            CORSConfiguration={
                "CORSRules": [
                    {
                        "AllowedOrigins": ["*"],
                        "AllowedMethods": ["GET", "HEAD"],
                        "AllowedHeaders": ["*"],
                        "MaxAgeSeconds": 86400,
                    }
                ]
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("image_store: failed to set bucket CORS policy: %s", exc)


def _wait_until_publicly_readable(public_url: str, attempts: int = 5, delay: float = 0.35) -> None:
    """Cloudflare's r2.dev public subdomain briefly 503s a photo right after
    it's uploaded — the object is written, but hasn't finished propagating
    to whichever edge serves the public URL yet. It always starts working on
    its own within a couple of seconds; the only symptom otherwise is that
    whoever happens to be the first person to open a freshly-scraped
    collection sees a handful of blank thumbnails for a few seconds (seen
    live on a 69-photo gallery fetched moments after its photos were
    uploaded — most loaded fine immediately, ~12 came back 503 at first and
    only cleared up on a later reload).

    Polling here, right after upload and before handing the URL back to a
    caller, means the app only ever gets a URL once it's actually servable
    — no more blank boxes on first view. Best-effort and bounded (well
    under 2 seconds worst case): if it's still not ready after `attempts`
    tries we just give up and move on, since the object will keep finishing
    propagation in the background regardless and load fine shortly after.
    """
    for _ in range(attempts):
        try:
            resp = requests.head(public_url, timeout=5)
            if resp.status_code < 400:
                return
        except Exception:
            pass
        time.sleep(delay)


def delete_image(public_url: str) -> None:
    """Permanently remove one previously-cached photo from R2 -- used when
    two collections turn out to be the same real-world show scraped from
    different sources and get merged, leaving one of their two near-
    identical photos redundant (see _dedupe_images_phash's caller in
    server.py). Best-effort and silent: a URL that was never one of ours
    (not under R2_PUBLIC_BASE_URL, e.g. still a live source-site URL
    because R2 wasn't enabled when it was cached) or that's already gone is
    a no-op either way -- never raises, since a stray orphaned object costs
    nothing but a few KB of storage, while raising here would fail the
    merge that's already committed its DB write.
    """
    if not ENABLED or not public_url or not public_url.startswith(_PUBLIC_BASE + "/"):
        return
    key = public_url[len(_PUBLIC_BASE) + 1:]
    try:
        _get_client().delete_object(Bucket=_BUCKET, Key=key)
    except Exception as exc:  # noqa: BLE001
        logger.warning("image_store: failed to delete %s: %s", public_url, exc)
    # Also drop the paired thumbnail, if one was ever generated for this
    # photo (see _thumb_key_for) — best-effort and silent, same reasoning
    # as the full-res delete above: a stray orphaned thumb costs nothing.
    if key.startswith("fashion/"):
        try:
            _get_client().delete_object(Bucket=_BUCKET, Key=_thumb_key_for(key))
        except Exception:
            pass


def cache_image(source_url: str) -> str:
    """Return a URL to a copy of `source_url` hosted on our own R2 bucket,
    uploading it first if this is the first time we've seen it. Falls back
    to the original `source_url` on any failure, or when R2 isn't
    configured — callers never need to branch on ENABLED themselves.
    """
    if not ENABLED or not source_url:
        return source_url

    key = _key_for(source_url)
    public_url = f"{_PUBLIC_BASE}/{key}"
    client = _get_client()

    try:
        client.head_object(Bucket=_BUCKET, Key=key)
        return public_url  # already cached from a previous scrape
    except Exception:
        pass  # not cached yet, or the check itself failed — try a fresh upload below

    try:
        resp = requests.get(source_url, headers=_DOWNLOAD_HEADERS, timeout=20)
        resp.raise_for_status()
        content_type = resp.headers.get("Content-Type", "image/jpeg")
        client.put_object(Bucket=_BUCKET, Key=key, Body=resp.content, ContentType=content_type)
        _wait_until_publicly_readable(public_url)
        return public_url
    except Exception as exc:  # noqa: BLE001
        logger.warning("image_store: failed to cache %s: %s", source_url, exc)
        return source_url


def cache_image_with_thumb(source_url: str) -> tuple:
    """Like cache_image, but also produces a small resized thumbnail
    alongside the full-resolution photo — one download of the source photo,
    up to two uploads to R2 (full + thumb, each skipped if already cached).
    Used wherever a photo is being cached for the first time (a fresh
    scrape, a lazily-fetched gallery, the cover-fix sweep).

    Returns (full_url, thumb_url). Degrades gracefully: a thumbnailing
    failure (e.g. Pillow can't decode the file) still returns the working
    full_url with thumb_url falling back to it, so a broken thumbnail never
    costs the photo itself; a download/upload failure falls back to
    (source_url, source_url), same as cache_image.
    """
    if not ENABLED or not source_url:
        return source_url, source_url

    full_key = _key_for(source_url)
    thumb_key = _thumb_key_for(full_key)
    full_url = f"{_PUBLIC_BASE}/{full_key}"
    thumb_url = f"{_PUBLIC_BASE}/{thumb_key}"
    client = _get_client()

    full_exists = _object_exists(client, full_key)
    thumb_exists = _object_exists(client, thumb_key)
    if full_exists and thumb_exists:
        return full_url, thumb_url

    try:
        resp = requests.get(source_url, headers=_DOWNLOAD_HEADERS, timeout=20)
        resp.raise_for_status()
        content = resp.content
        content_type = resp.headers.get("Content-Type", "image/jpeg")
    except Exception as exc:  # noqa: BLE001
        logger.warning("image_store: failed to download %s: %s", source_url, exc)
        return source_url, source_url

    if not full_exists:
        try:
            client.put_object(Bucket=_BUCKET, Key=full_key, Body=content, ContentType=content_type)
        except Exception as exc:  # noqa: BLE001
            logger.warning("image_store: failed to upload full %s: %s", source_url, exc)
            return source_url, source_url

    if not thumb_exists:
        try:
            thumb_bytes = _make_thumbnail(content)
            client.put_object(Bucket=_BUCKET, Key=thumb_key, Body=thumb_bytes, ContentType="image/jpeg")
        except Exception as exc:  # noqa: BLE001
            logger.warning("image_store: failed to make/upload thumb for %s: %s", source_url, exc)
            thumb_url = full_url  # degrade to full-res rather than fail the whole photo

    if not full_exists:
        _wait_until_publicly_readable(full_url)
    return full_url, thumb_url


def backfill_thumb(full_url: str) -> Optional[str]:
    """Generate a thumbnail for a photo that's already been cached at full
    resolution (an existing R2-hosted URL from before thumbnails existed),
    without re-fetching it from its original source site. Downloads the
    already-cached full-resolution copy from our own R2 bucket (cheap, no
    load on fashion-press.net/firstview.com) and re-hosts a small version of
    it alongside the original.

    Returns the thumbnail's URL, or None if `full_url` isn't one of our own
    R2 URLs, R2 isn't configured, or the fetch/resize/upload failed
    (best-effort — a doc just keeps falling back to its full-res image
    until a later sweep succeeds).
    """
    if not ENABLED or not full_url or not full_url.startswith(_PUBLIC_BASE + "/"):
        return None
    full_key = full_url[len(_PUBLIC_BASE) + 1:]
    thumb_key = _thumb_key_for(full_key)
    thumb_url = f"{_PUBLIC_BASE}/{thumb_key}"
    client = _get_client()

    if _object_exists(client, thumb_key):
        return thumb_url

    try:
        resp = requests.get(full_url, headers=_DOWNLOAD_HEADERS, timeout=20)
        resp.raise_for_status()
        thumb_bytes = _make_thumbnail(resp.content)
        client.put_object(Bucket=_BUCKET, Key=thumb_key, Body=thumb_bytes, ContentType="image/jpeg")
        return thumb_url
    except Exception as exc:  # noqa: BLE001
        logger.warning("image_store: failed to backfill thumb for %s: %s", full_url, exc)
        return None


def cache_images_with_thumb(urls: list, max_workers: int = 6) -> list:
    """Run cache_image_with_thumb over a whole gallery concurrently instead
    of one photo at a time.

    A single runway gallery can hold 100+ photos (confirmed live: a
    fashion-press.net collection page can list 120+ "look" shots), and
    cache_image_with_thumb does a full download plus up to two uploads per
    photo -- done sequentially, a big gallery blew straight through every
    caller's timeout (30-90s) long before finishing, which is what left
    large collections permanently stuck on just their first photo (the
    caller's `except Exception: return False`/`[]` on timeout meant the doc
    was either never updated or, worse, marked as fully fetched with
    whatever partial list happened to exist first -- see callers in
    server.py for how `gallery_fetched` is set only after this returns).

    Returns a list of (full_url, thumb_url) tuples in the same order as
    `urls`. `max_workers` is deliberately modest (not one thread per photo)
    -- this runs inside a collection-level semaphore in server.py, so the
    real concurrency hitting the source site is max_workers times however
    many collections are being processed at once; keeping this modest
    avoids tripping the source site's own rate limiting.
    """
    if not urls:
        return []
    if len(urls) == 1:
        return [cache_image_with_thumb(urls[0])]
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=min(max_workers, len(urls))) as pool:
        return list(pool.map(cache_image_with_thumb, urls))
