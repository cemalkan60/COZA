"""
COZA Fashion — Gemini-based brand-name resolution + runway-photo tagging.

fashion_scraper.py extracts each collection's brand name from its Japanese
title and romanizes it with pykakasi (_romanize_ja) as an always-on, free
fallback. That romanization is a mechanical kana/kanji reading, though, not
a lookup of the brand's actual spelling — for a katakana rendering of a
foreign word (e.g. "アンダーカバー") the reading comes out wrong just as
often as it comes out close ("Andaakabaa" instead of "Undercover").

This module asks Gemini, once per unique brand name (cached by the caller
in db.brand_names — see server.py's _resolve_brand_names), what the
brand's real Latin-script name is (resolve_brand_name, text-only). It also
classifies fashion photos' garment/color/pattern/material for cross-source
filtering (tag_image for one photo, tag_images for a batch — see
run_fashion_tag_photos in server.py). All share the same request path,
rotation and throttle below.

Configuration (all via env vars):
  GEMINI_API_KEY    One Google AI Studio API key.
  GEMINI_API_KEYS   OR several, comma/space/newline separated. Each key is a
                    separate free-tier project with its own daily quota, so
                    listing 3-4 here multiplies how many photos a nightly
                    sweep can tag before it runs out for the day. Both vars
                    are merged; at least one key activates the module.
  GEMINI_MODELS     Comma-separated model names to rotate through, e.g.
                    "gemini-3.5-flash-lite,gemini-2.5-flash-lite". Each model
                    line has its OWN free-tier daily bucket on the same
                    project, so rotating a few multiplies quota again.
                    Optional — defaults to the *-flash-lite trio below.
  GEMINI_MODEL      Back-compat single-model override (used only if
                    GEMINI_MODELS is unset).
  GEMINI_MIN_INTERVAL_S  Minimum seconds between two requests that reuse the
                    same API key (per-key throttle). Default 4.5.

Deliberately all-optional: with no key set, ENABLED is False and every
function here returns None / a list of Nones, so callers fall back to the
pykakasi romanization / an untagged photo exactly as before — nothing
breaks if the keys are missing or removed.
"""
import base64
import json
import logging
import os
import re
import threading
import time
from typing import Optional

import requests

logger = logging.getLogger("coza.gemini_client")


def _split_env(*names: str) -> list:
    """Collect + de-dupe values from one or more env vars, each of which may
    itself hold a comma / whitespace / newline separated list."""
    out: list = []
    for name in names:
        for chunk in re.split(r"[,\s]+", os.environ.get(name, "").strip()):
            chunk = chunk.strip()
            if chunk and chunk not in out:
                out.append(chunk)
    return out


_KEYS = _split_env("GEMINI_API_KEYS", "GEMINI_API_KEY")

# "gemini-2.0-flash" (this module's original default) was shut down by Google
# on 2026-06-01 -- every call had been silently 404ing and falling back to
# the non-AI path ever since. "gemini-flash-latest" (full Flash) fixed the
# 404 but this project's free tier gives that line only 20 requests/DAY,
# nowhere near a sweep over 1000+ photos. The "-flash-lite" models are still
# fully multimodal (image input, same generateContent call) but sit in a far
# more generous free bucket (hundreds of requests/day), and each model line
# has its own separate daily quota -- so rotating a few of them multiplies
# how much a nightly sweep can get through before every bucket is empty.
_MODELS = _split_env("GEMINI_MODELS") or (
    [os.environ["GEMINI_MODEL"].strip()] if os.environ.get("GEMINI_MODEL", "").strip()
    else ["gemini-3.5-flash-lite", "gemini-2.5-flash-lite", "gemini-2.0-flash-lite"]
)

# Minimum seconds between two requests that reuse the SAME key (a free
# project's rate limit is per-project, so this is tracked per key, not
# globally -- with N keys the effective aggregate spacing is ~1/N of this).
_MIN_INTERVAL_S = float(os.environ.get("GEMINI_MIN_INTERVAL_S", "4.5"))

ENABLED = bool(_KEYS)

_IMG_DOWNLOAD_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
    ),
}


# --------------------------------------------------------------------------
# (key, model) slot rotation
# --------------------------------------------------------------------------
# One "slot" is a specific (API key, model) pairing. A 429 (quota/rate) or a
# transient network error puts just that slot on a cooldown -- a growing
# backoff, so a key whose DAILY bucket is empty stops being retried every
# few seconds and the rotation naturally settles onto whatever slots still
# have quota. When every slot is cooling, callers get None and the sweep
# just resumes on its next run (image_tags is a resumable prefix of images).
class _Slot:
    __slots__ = ("key", "model", "cool_until", "fails")

    def __init__(self, key: str, model: str):
        self.key = key
        self.model = model
        self.cool_until = 0.0
        self.fails = 0


_SLOTS = [_Slot(k, m) for k in _KEYS for m in _MODELS]
_slot_lock = threading.Lock()
_rr = 0  # round-robin cursor
# Per-key "last request finished at" timestamps for the throttle.
_key_last_ts: dict = {k: 0.0 for k in _KEYS}

_COOL_MAX_S = 6 * 3600  # a fully-spent daily bucket: stop poking it for the night


def _next_slot() -> "Optional[_Slot]":
    """Round-robin to the next slot that isn't on cooldown, or None if all are."""
    global _rr
    with _slot_lock:
        n = len(_SLOTS)
        now = time.monotonic()
        for _ in range(n):
            slot = _SLOTS[_rr % n]
            _rr = (_rr + 1) % n
            if slot.cool_until <= now:
                return slot
        return None


def _cool(slot: "_Slot", *, quota: bool) -> None:
    with _slot_lock:
        slot.fails += 1
        # 429 -> exponential from ~2min, capped at _COOL_MAX_S (covers "daily
        # bucket empty"). Network/5xx -> short, it's usually momentary.
        base = 120 if quota else 15
        delay = min(base * (2 ** (slot.fails - 1)), _COOL_MAX_S)
        slot.cool_until = time.monotonic() + delay


def _slot_ok(slot: "_Slot") -> None:
    with _slot_lock:
        slot.fails = 0
        slot.cool_until = 0.0


def _throttle(key: str) -> None:
    """Block (calling thread only -- callers use asyncio.to_thread) until at
    least _MIN_INTERVAL_S has passed since the previous request on `key`."""
    with _slot_lock:
        wait = _key_last_ts.get(key, 0.0) + _MIN_INTERVAL_S - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    with _slot_lock:
        _key_last_ts[key] = time.monotonic()


def _endpoint(model: str) -> str:
    return f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


def _generate(parts: list, max_output_tokens: int, timeout: int = 40) -> "Optional[str]":
    """One generateContent call. Rotates through (key, model) slots on 429 /
    503 / network error until one succeeds or all are cooling. Returns the
    concatenated text of the first candidate, or None."""
    if not ENABLED:
        return None
    attempts = max(len(_SLOTS), 1)
    for _ in range(attempts):
        slot = _next_slot()
        if slot is None:
            logger.warning("gemini_client: every (key,model) slot is on cooldown")
            return None
        _throttle(slot.key)
        try:
            resp = requests.post(
                _endpoint(slot.model),
                params={"key": slot.key},
                json={
                    "contents": [{"parts": parts}],
                    "generationConfig": {"temperature": 0, "maxOutputTokens": max_output_tokens},
                },
                timeout=timeout,
            )
        except requests.RequestException as exc:
            logger.warning("gemini_client: network error on %s: %s", slot.model, exc)
            _cool(slot, quota=False)
            continue
        if resp.status_code in (429, 503):
            _cool(slot, quota=(resp.status_code == 429))
            continue
        if not resp.ok:
            logger.warning("gemini_client: HTTP %s from %s: %s", resp.status_code, slot.model, resp.text[:200])
            _cool(slot, quota=False)
            continue
        _slot_ok(slot)
        try:
            data = resp.json()
            candidates = data.get("candidates") or []
            if not candidates:
                return None
            parts_out = (candidates[0].get("content") or {}).get("parts") or []
            return "".join(p.get("text", "") for p in parts_out).strip()
        except Exception as exc:  # noqa: BLE001
            logger.warning("gemini_client: unparseable response body: %s", exc)
            return None
    return None


# --------------------------------------------------------------------------
# Brand-name resolution (text only)
# --------------------------------------------------------------------------
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
    in Japanese. Returns None on any failure, low confidence, or when no key
    is configured — callers fall back to the pykakasi romanization, never
    block or raise on this.
    """
    if not ENABLED or not (brand_ja or "").strip():
        return None
    text = _generate(
        [{"text": _PROMPT_TEMPLATE.format(brand_ja=brand_ja.strip())}],
        max_output_tokens=32,
    )
    if text is None:
        return None
    text = text.strip("\"'` \n\t")
    if not text or text.upper() == "NONE":
        return None
    return text


# --------------------------------------------------------------------------
# Runway-photo tagging (vision)
# --------------------------------------------------------------------------
_TAG_FIELDS = ("item", "color", "pattern", "material")

_TAG_SHAPE_RULES = (
    'Each object: {"item": "<main garment type, e.g. dress, coat, suit, '
    'skirt, trousers, jacket, blouse, jumpsuit>", "color": "<single dominant '
    'color, e.g. black, white, red, beige, navy, multicolor>", "pattern": '
    '"<e.g. solid, striped, floral, plaid, animal print, polka dot, none>", '
    '"material": "<best-guess fabric, e.g. denim, leather, knit, silk, wool, '
    'cotton, sequin, unknown>"}. If you cannot tell a field confidently use '
    '"unknown" for that field only — never drop a field or invent detail you '
    "cannot actually see."
)

_TAG_PROMPT_ONE = (
    "You are labeling a single fashion runway photo for a filterable clothing "
    "catalog app. Look at the main garment/outfit worn by the model and reply "
    "with ONLY a compact JSON object, no markdown, no code fence, no "
    "explanation:\n" + _TAG_SHAPE_RULES
)


def _tag_prompt_batch(n: int) -> str:
    return (
        f"You are labeling fashion runway photos for a filterable clothing "
        f"catalog app. You will be given {n} photos, in order. For EACH photo "
        f"look at the main garment/outfit worn by the model. Reply with ONLY a "
        f"JSON array of EXACTLY {n} objects, in the same order as the photos — "
        f"no markdown, no code fence, no explanation.\n" + _TAG_SHAPE_RULES
    )


def _clean_tag(obj) -> "Optional[dict]":
    if not isinstance(obj, dict):
        return None
    return {
        field: str(obj.get(field) or "unknown").strip().lower()[:40]
        for field in _TAG_FIELDS
    }


def _download_image(image_url: str) -> "Optional[dict]":
    """Fetch one image and return a generateContent inline_data part, or None."""
    try:
        r = requests.get(image_url, headers=_IMG_DOWNLOAD_HEADERS, timeout=15)
        r.raise_for_status()
        mime = (r.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip()
        if not mime.startswith("image/"):
            mime = "image/jpeg"
        return {"inline_data": {"mime_type": mime, "data": base64.b64encode(r.content).decode("ascii")}}
    except Exception as exc:  # noqa: BLE001
        logger.warning("gemini_client: failed to download image %r: %s", image_url, exc)
        return None


def tag_images(image_urls: list) -> list:
    """Classify several runway photos in ONE generateContent call (item /
    color / pattern / material each — see server.py's run_fashion_tag_photos).

    The free tier's real ceiling is requests/DAY, not images/day, so sending
    a handful of photos per request is the main lever for getting a big
    backlog tagged in days rather than weeks. Returns a list the same length
    and order as `image_urls`; any entry is None if that photo couldn't be
    downloaded, the reply couldn't be parsed, or all slots are cooling —
    callers should leave those photos for a later sweep, never block/raise.
    """
    n = len(image_urls)
    if not ENABLED or n == 0:
        return [None] * n

    downloaded = [_download_image(u) for u in image_urls]
    ok_idx = [i for i, d in enumerate(downloaded) if d is not None]
    if not ok_idx:
        return [None] * n

    out: list = [None] * n

    # One good image left -> the single-object prompt parses more reliably
    # than asking for a 1-element array.
    if len(ok_idx) == 1:
        i = ok_idx[0]
        text = _generate([{"text": _TAG_PROMPT_ONE}, downloaded[i]], max_output_tokens=256)
        if text:
            m = re.search(r"\{.*\}", text, re.DOTALL)
            if m:
                try:
                    out[i] = _clean_tag(json.loads(m.group(0)))
                except Exception:  # noqa: BLE001
                    pass
        return out

    parts = [{"text": _tag_prompt_batch(len(ok_idx))}]
    for i in ok_idx:
        parts.append(downloaded[i])
    # ~90 output tokens per object is plenty for this fixed 4-field shape.
    text = _generate(parts, max_output_tokens=64 + 90 * len(ok_idx), timeout=60)
    if not text:
        return out
    m = re.search(r"\[.*\]", text, re.DOTALL)
    if not m:
        logger.warning("gemini_client: batch reply had no JSON array")
        return out
    try:
        arr = json.loads(m.group(0))
    except Exception as exc:  # noqa: BLE001
        logger.warning("gemini_client: batch JSON array unparseable: %s", exc)
        return out
    if not isinstance(arr, list) or len(arr) != len(ok_idx):
        logger.warning(
            "gemini_client: batch returned %s items, expected %d",
            len(arr) if isinstance(arr, list) else type(arr).__name__, len(ok_idx),
        )
        return out
    for pos, i in enumerate(ok_idx):
        out[i] = _clean_tag(arr[pos])
    return out


def tag_image(image_url: str) -> "Optional[dict]":
    """Single-photo convenience wrapper around tag_images()."""
    return tag_images([image_url])[0]
