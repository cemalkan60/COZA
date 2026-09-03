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
