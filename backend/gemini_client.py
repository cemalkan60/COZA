"""
COZA Fashion — Gemini-based brand-name resolution.

fashion_scraper.py extracts each collection's brand name from its Japanese
title and romanizes it with pykakasi (_romanize_ja) as an always-on, free
fallback. That romanization is a mechanical kana/kanji reading, though, not
a lookup of the brand's actual spelling — for a katakana rendering of a
foreign word (e.g. "アンダーカバー") the reading comes out wrong just as
often as it comes out close ("Andaakabaa" instead of "Undercover").

This module asks Gemini's text model, once per unique brand name (cached by
the caller in db.brand_names — see server.py's _resolve_brand_names), what
the brand's real Latin-script name is. Text-only: no images are sent, no
vision pricing applies.

Configuration (all via env vars):
  GEMINI_API_KEY   Google AI Studio API key. Required to activate.
  GEMINI_MODEL     Model name, e.g. "gemini-2.0-flash". Optional, defaults
                    to a fast/free-tier-friendly model below.

Deliberately all-optional: with GEMINI_API_KEY unset, ENABLED is False and
resolve_brand_name() always returns None, so callers fall back to the
pykakasi romanization exactly as before — nothing breaks if the key is
missing or removed. Nothing above imports `requests` at import time either
(it already is imported elsewhere in this project, but keeping the pattern
consistent with image_store.py costs nothing).
"""
import base64
import json
import logging
import os
import threading
import time
from typing import Optional

import requests

logger = logging.getLogger("coza.gemini_client")

_API_KEY = os.environ.get("GEMINI_API_KEY", "")
_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
# Minimum seconds between any two Gemini requests from this process (see
# _throttle below) -- keeps the image-tagging sweep (run_fashion_tag_
# firstview in server.py, which can fire hundreds of calls in one run)
# under the free API tier's per-minute request cap, so it never needs a
# paid key. Conservative default; override via env if the tier allows more.
_MIN_INTERVAL_S = float(os.environ.get("GEMINI_MIN_INTERVAL_S", "4.5"))

ENABLED = bool(_API_KEY)

_ENDPOINT = (
    f"https://generativelanguage.googleapis.com/v1beta/models/{_MODEL}:generateContent"
)

_IMG_DOWNLOAD_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
    ),
}

# Simple global leaky-bucket-of-one: every call to _throttle() blocks (the
# calling thread only -- callers always run this via asyncio.to_thread, so
# the event loop itself never sleeps) until at least _MIN_INTERVAL_S has
# passed since the previous Gemini request from this process, regardless of
# how many docs/photos are being tagged concurrently. A lock rather than a
# per-caller sleep because several worker threads can race to call this at
# once (the tagging sweep runs a handful of documents concurrently).
_throttle_lock = threading.Lock()
_last_call_ts = 0.0


def _throttle() -> None:
    global _last_call_ts
    with _throttle_lock:
        now = time.monotonic()
        wait = _last_call_ts + _MIN_INTERVAL_S - now
        if wait > 0:
            time.sleep(wait)
        _last_call_ts = time.monotonic()

_PROMPT_TEMPLATE = (
    "You are helping identify fashion brand/designer names. The following text "
    "is a brand or designer name as written in Japanese (often katakana, a "
    "phonetic rendering of a foreign word). Reply with ONLY the brand's real, "
    "official Latin-script name as it is actually spelled/branded (for example "
    "アンダーカバー -> Undercover, コム デ ギャルソン -> Comme des Garçons, "
    "ヨシオクボ -> Yoshiokubo). If you are not confident what the real name is, "
    "reply with exactly NONE and nothing else. Do not explain, do not add "
    "quotes, do not add punctuation beyond what the name itself contains.\n\n"
    "Japanese text: {brand_ja}"
)


def resolve_brand_name(brand_ja: str) -> "str | None":
    """Ask Gemini for the real Latin-script spelling of a brand name written
    in Japanese. Returns None on any failure, low confidence, or when
    GEMINI_API_KEY isn't configured — callers should fall back to the
    pykakasi romanization in that case, never block or raise on this.
    """
    if not ENABLED or not (brand_ja or "").strip():
        return None

    prompt = _PROMPT_TEMPLATE.format(brand_ja=brand_ja.strip())
    _throttle()
    try:
        resp = requests.post(
            _ENDPOINT,
            params={"key": _API_KEY},
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0, "maxOutputTokens": 32},
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        candidates = data.get("candidates") or []
        if not candidates:
            return None
        parts = (candidates[0].get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts).strip()
        # Strip stray quotes/markdown Gemini sometimes wraps single-word
        # answers in despite the prompt asking it not to.
        text = text.strip("\"'` \n\t")
        if not text or text.upper() == "NONE":
            return None
        return text
    except Exception as exc:  # noqa: BLE001
        logger.warning("gemini_client: failed to resolve brand %r: %s", brand_ja, exc)
        return None


_TAG_PROMPT = (
    "You are labeling a single fashion runway photo for a filterable clothing "
    "catalog app. Look at the main garment/outfit worn by the model in this "
    "photo and reply with ONLY a compact JSON object, no markdown, no code "
    "fence, no explanation, in exactly this shape:\n"
    '{"item": "<main garment type, e.g. dress, coat, suit, skirt, trousers, '
    'jacket, blouse, jumpsuit>", "color": "<single dominant color, e.g. '
    'black, white, red, beige, navy, multicolor>", "pattern": "<e.g. solid, '
    'striped, floral, plaid, animal print, polka dot, none>", "material": '
    '"<best-guess fabric/material, e.g. denim, leather, knit, silk, wool, '
    'cotton, sequin, unknown>"}\n'
    "If you cannot tell one of the fields confidently, use \"unknown\" for "
    "that field only — never leave a field out or invent detail you can't "
    "actually see."
)

_TAG_FIELDS = ("item", "color", "pattern", "material")


def tag_image(image_url: str) -> "Optional[dict]":
    """Ask Gemini's vision-capable text model to classify one fashion photo
    (garment type / color / pattern / material) for cross-source filtering
    — see server.py's run_fashion_tag_firstview, the sweep that calls this
    once per photo. Returns None on any failure, an unparseable reply, or
    when GEMINI_API_KEY isn't configured; callers should just leave that
    photo untagged and retry on a later sweep, never block or raise on this.

    Downloads `image_url` itself (works with any publicly reachable URL,
    including our own R2-hosted thumbnails/full-res photos) and sends it
    inline as base64 alongside the prompt in one generateContent call — the
    same multimodal support gemini-2.0-flash offers on this text endpoint,
    no separate vision endpoint needed. Callers should prefer a small
    thumbnail URL over the full-resolution photo where available: plenty for
    this level of classification, and noticeably cheaper/faster to upload.
    """
    if not ENABLED or not image_url:
        return None

    try:
        img_resp = requests.get(image_url, headers=_IMG_DOWNLOAD_HEADERS, timeout=15)
        img_resp.raise_for_status()
        image_b64 = base64.b64encode(img_resp.content).decode("ascii")
        mime_type = (img_resp.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip()
        if not mime_type.startswith("image/"):
            mime_type = "image/jpeg"
    except Exception as exc:  # noqa: BLE001
        logger.warning("gemini_client: failed to download image to tag %r: %s", image_url, exc)
        return None

    _throttle()
    try:
        resp = requests.post(
            _ENDPOINT,
            params={"key": _API_KEY},
            json={
                "contents": [
                    {
                        "parts": [
                            {"text": _TAG_PROMPT},
                            {"inline_data": {"mime_type": mime_type, "data": image_b64}},
                        ]
                    }
                ],
                "generationConfig": {"temperature": 0, "maxOutputTokens": 128},
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        candidates = data.get("candidates") or []
        if not candidates:
            return None
        parts = (candidates[0].get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts).strip()
        # Gemini sometimes wraps JSON in a ```json ... ``` fence despite the
        # prompt asking it not to -- strip that before parsing.
        text = text.strip("` \n\t")
        if text.lower().startswith("json"):
            text = text[4:].strip()
        parsed = json.loads(text)
        if not isinstance(parsed, dict):
            return None
        return {
            field: str(parsed.get(field) or "unknown").strip().lower()[:40]
            for field in _TAG_FIELDS
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("gemini_client: failed to tag image %r: %s", image_url, exc)
        return None
