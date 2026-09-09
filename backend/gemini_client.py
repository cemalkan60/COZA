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
from concurrent.futures import ThreadPoolExecutor
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

# Rotating several model lines to multiply free-tier quota was the plan, but
# checked live 2026-09-07: Google has retired gemini-2.0-flash-lite and
# gemini-2.5-flash-lite ("no longer available", HTTP 404) and points
# everything at gemini-3.5-flash-lite -- which is currently the ONLY free
# multimodal line worth using here (full Flash is ~20 requests/DAY on this
# tier). So the default is just that one model; effective quota now scales
# with the number of API KEYS, not models. GEMINI_MODELS can still list more
# if Google reopens other lite lines later. gemini-2.0-flash (no "-lite")
# was this module's original default and was shut down 2026-06-01.
_MODELS = _split_env("GEMINI_MODELS") or (
    [os.environ["GEMINI_MODEL"].strip()] if os.environ.get("GEMINI_MODEL", "").strip()
    else ["gemini-3.5-flash-lite"]
)

# Minimum seconds between two requests that reuse the SAME key (rate limits
# are per-project, tracked per key). Default 0.6s (~100 req/min/key) — a
# brand-new PAID account starts with modest rate limits that ramp up with
# use, and bursting past them just earns 429s. Lower it once limits grow;
# set GEMINI_MIN_INTERVAL_S=3 if you go back to free keys.
_MIN_INTERVAL_S = float(os.environ.get("GEMINI_MIN_INTERVAL_S", "0.6"))

# Image downloads for a batch run in parallel (each _download_image is a
# blocking requests.get) -- serial downloads were most of a batch's
# wall-clock time, leaving the per-key request budget under-used.
_DL_POOL = ThreadPoolExecutor(max_workers=16, thread_name_prefix="gemini-img")

ENABLED = bool(_KEYS)

# --- Per-run failure tally (why did a tagging pass tag nothing?) -------------
# tag_images / _download_image bump these counters by category so the caller
# (run_fashion_tag_photos) can write a REAL reason into the Admin panel's
# "son işlemler" history instead of guessing from slot_status(). Keys are
# short stable slugs; the server maps them to a Turkish sentence.
#   dl_http_404 / dl_http_403 / dl_http_5xx / dl_http_other  photo download HTTP error
#   dl_timeout / dl_conn / dl_other                          photo download network error
#   dl_not_image                                             download ok but not an image
#   gemini_all_cooling                                       every key on cooldown (daily quota)
#   gemini_no_reply                                          Gemini returned nothing (not cooling)
#   gemini_bad_json                                          reply had no / unparseable JSON
#   gemini_count_mismatch                                    reply had the wrong number of items
#   ok                                                       photo got a tag
_TAG_STATS_LOCK = threading.Lock()
_TAG_STATS: dict = {}


def reset_tag_stats() -> None:
    """Clear the failure tally — call once at the start of a tagging sweep."""
    with _TAG_STATS_LOCK:
        _TAG_STATS.clear()


def tag_stats() -> dict:
    """Snapshot of the failure tally since the last reset_tag_stats()."""
    with _TAG_STATS_LOCK:
        return dict(_TAG_STATS)


def _tag_stat(reason: str, n: int = 1) -> None:
    if n <= 0:
        return
    with _TAG_STATS_LOCK:
        _TAG_STATS[reason] = _TAG_STATS.get(reason, 0) + n


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


_RETRY_DELAY_RE = re.compile(r'"retryDelay"\s*:\s*"(\d+)(?:\.\d+)?s"')


def _cool(slot: "_Slot", *, quota: bool, retry_after: "float | None" = None) -> None:
    """Park a slot. If Gemini told us exactly how long to wait (retryDelay
    in a 429 body — a per-minute rate cap), honour that. Otherwise back off
    exponentially from ~1min: repeated 429s on the SAME slot with no
    retryDelay means the daily bucket is spent, so keep climbing to
    _COOL_MAX_S. Network/5xx cools briefly."""
    with _slot_lock:
        slot.fails += 1
        if retry_after is not None:
            delay = max(5.0, min(retry_after + 2.0, _COOL_MAX_S))
        elif quota:
            delay = min(60 * (2 ** (slot.fails - 1)), _COOL_MAX_S)
        else:
            delay = min(15 * (2 ** (slot.fails - 1)), 300)
        slot.cool_until = time.monotonic() + delay


def _slot_ok(slot: "_Slot") -> None:
    with _slot_lock:
        slot.fails = 0
        slot.cool_until = 0.0


def _throttle(key: str) -> None:
    """Space out requests that reuse the same key by >= _MIN_INTERVAL_S.

    Reserve-then-sleep: the next send-time for `key` is claimed under the
    lock *before* sleeping, so N threads racing here for the same key queue
    up at strict _MIN_INTERVAL_S increments instead of all reading the same
    stale timestamp and firing together (that burst is what earns 429s).
    Only the calling thread sleeps — callers run this via asyncio.to_thread.
    """
    with _slot_lock:
        send_at = max(time.monotonic(), _key_last_ts.get(key, 0.0) + _MIN_INTERVAL_S)
        _key_last_ts[key] = send_at
    wait = send_at - time.monotonic()
    if wait > 0:
        time.sleep(wait)


def _endpoint(model: str) -> str:
    return f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


def _gen_config(max_output_tokens: int, *, response_json: bool, bare: bool = False) -> dict:
    cfg = {"temperature": 0, "maxOutputTokens": max_output_tokens}
    if bare:
        return cfg
    # A bounded classification / lookup never needs the model to "think" —
    # on gemini-2.5+/3.x thinking burns the output-token budget before any
    # answer is emitted, which showed up as ~100% "yanıt okunamadı".
    cfg["thinkingConfig"] = {"thinkingBudget": 0}
    if response_json:
        cfg["responseMimeType"] = "application/json"
    return cfg


def _generate(
    parts: list, max_output_tokens: int, timeout: int = 40, response_json: bool = False,
) -> "Optional[str]":
    """One generateContent call. Rotates through (key, model) slots on 429 /
    503 / network error until one succeeds or all are cooling. Returns the
    concatenated text of the first candidate (thinking parts skipped), or None.

    response_json asks the API for a raw JSON body (no markdown fence / prose)
    — used by the tagging calls, which parse the reply as JSON."""
    if not ENABLED:
        return None
    attempts = max(len(_SLOTS), 1)
    for _ in range(attempts):
        slot = _next_slot()
        if slot is None:
            logger.warning("gemini_client: every (key,model) slot is on cooldown")
            return None
        _throttle(slot.key)
        bare = False
        for _try in range(2):
            try:
                resp = requests.post(
                    _endpoint(slot.model),
                    params={"key": slot.key},
                    json={
                        "contents": [{"parts": parts}],
                        "generationConfig": _gen_config(max_output_tokens, response_json=response_json, bare=bare),
                    },
                    timeout=timeout,
                )
            except requests.RequestException as exc:
                logger.warning("gemini_client: network error on %s: %s", slot.model, exc)
                _cool(slot, quota=False)
                resp = None
                break
            # An older model may reject thinkingConfig / responseMimeType with
            # a 400 — retry once with a plain config before giving up on the slot.
            if resp.status_code == 400 and not bare and (
                "thinking" in resp.text.lower() or "responsemimetype" in resp.text.lower()
                or "not supported" in resp.text.lower() or "unknown name" in resp.text.lower()
            ):
                logger.info("gemini_client: %s rejected extended config, retrying bare", slot.model)
                bare = True
                continue
            break
        if resp is None:
            continue
        if resp.status_code in (429, 503):
            ra = None
            if resp.status_code == 429:
                m = _RETRY_DELAY_RE.search(resp.text or "")
                if m:
                    ra = float(m.group(1))
            _cool(slot, quota=(resp.status_code == 429), retry_after=ra)
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
            # Skip internal reasoning parts — only the real answer text.
            return "".join(p.get("text", "") for p in parts_out if not p.get("thought")).strip()
        except Exception as exc:  # noqa: BLE001
            logger.warning("gemini_client: unparseable response body: %s", exc)
            return None
    return None


def _probe(key: str, model: str, timeout: int) -> dict:
    """One minimal live generateContent call. ok=True also for 429 (the
    key/model pairing is valid, its quota is just spent)."""
    res = {"ok": False, "quota_exhausted": False, "detail": ""}
    try:
        r = requests.post(
            _endpoint(model),
            params={"key": key},
            json={
                "contents": [{"parts": [{"text": "ping"}]}],
                "generationConfig": {"temperature": 0, "maxOutputTokens": 1},
            },
            timeout=timeout,
        )
        if r.ok:
            res["ok"] = True
            res["detail"] = "ok"
        elif r.status_code == 429:
            res["ok"] = True
            res["quota_exhausted"] = True
            res["detail"] = "geçerli — kota dolu"
        else:
            try:
                msg = (r.json().get("error") or {}).get("message", "") or r.text[:160]
            except Exception:  # noqa: BLE001
                msg = r.text[:160]
            res["detail"] = f"HTTP {r.status_code}: {msg[:180]}"
    except Exception as exc:  # noqa: BLE001
        res["detail"] = f"{type(exc).__name__}: {exc}"
    return res


def slot_status() -> dict:
    """Cheap, in-memory snapshot of the (key,model) rotation — no network
    calls, unlike check_keys(). Used to tell the Admin panel WHY a tagging
    pass tagged nothing: every slot cooling means the day's quota is spent
    (recovers on its own); anything else means photos were unreachable or
    replies didn't parse (see tag_images)."""
    now = time.monotonic()
    with _slot_lock:
        cooling = [s for s in _SLOTS if s.cool_until > now]
        soonest = min((s.cool_until for s in cooling), default=None)
    return {
        "slot_count": len(_SLOTS),
        "cooling_count": len(cooling),
        "all_cooling": bool(_SLOTS) and len(cooling) == len(_SLOTS),
        "resumes_in_s": max(0, round(soonest - now)) if soonest is not None else None,
    }


def check_keys(timeout: int = 12) -> dict:
    """Diagnostic: probe EVERY (key, model) slot the rotation would use, so an
    operator can see the real working parallelism — a mistyped key or a
    non-existent model name shows up here instead of silently cooling itself
    out during a sweep. Never returns key material (position + 4-char tail
    only). `keys` keeps the per-key summary (ok if ANY of its models work);
    `slots` has the full grid.
    """
    out = {
        "enabled": ENABLED,
        "key_count": len(_KEYS),
        "models": list(_MODELS),
        "slot_count": len(_SLOTS),
        "slots_ok": 0,
        "keys": [],
        "slots": [],
    }
    if not _KEYS or not _MODELS:
        return out
    for idx, key in enumerate(_KEYS, 1):
        tail = key[-4:] if len(key) >= 4 else "?"
        per_model = []
        for model in _MODELS:
            r = _probe(key, model, timeout)
            per_model.append({"model": model, **r})
            out["slots"].append({"key_index": idx, "key_tail": tail, "model": model, **r})
            if r["ok"]:
                out["slots_ok"] += 1
        any_ok = any(m["ok"] for m in per_model)
        all_quota = any_ok and all((not m["ok"]) or m["quota_exhausted"] for m in per_model)
        detail = next((m["detail"] for m in per_model if not m["ok"]), "ok")
        out["keys"].append({
            "index": idx, "tail": tail,
            "ok": any_ok, "quota_exhausted": all_quota,
            "models_ok": sum(1 for m in per_model if m["ok"]),
            "models_total": len(per_model),
            "detail": "ok" if any_ok else detail,
        })
    return out


# Models worth probing as ADD-ONS to the rotation. Every (key, model) pair
# on the free tier carries its OWN separate daily quota, so each model that
# still works multiplies total tagging capacity across the same 8 keys.
# Google retires these silently (2.0/2.5-flash-lite went 404 in Sep 2026),
# so which to actually use is decided by a live probe, not this list.
_CANDIDATE_MODELS = [
    "gemini-3.5-flash-lite",      # current default
    "gemini-3.6-flash",           # named by the retired 2.5/2.0-flash 404s
    "gemini-3.6-flash-lite",      # a lite sibling may exist
    "gemini-3.1-pro-preview",     # named by the retired 3-pro-preview 404
    "gemini-flash-latest",        # alias -> newest full flash
    "gemini-flash-lite-latest",   # alias -> newest flash-lite
]


def discover_models(timeout: int = 15) -> dict:
    """Probe each candidate model once (against the first key only — model
    availability is per free-tier project, not per key) so an operator can
    see which are alive and not quota-blocked, then add the good ones to
    GEMINI_MODELS. Read-only; never touches the live rotation."""
    out = {"configured": list(_MODELS), "candidates": []}
    if not _KEYS:
        return out
    key = _KEYS[0]
    for i, m in enumerate(_CANDIDATE_MODELS):
        if i:
            time.sleep(1.0)  # don't trip the per-minute limit and false-positive "quota"
        r = _probe(key, m, timeout)
        out["candidates"].append({
            "model": m,
            "ok": r["ok"],
            "quota_exhausted": r["quota_exhausted"],
            "configured": m in _MODELS,
            "detail": r["detail"],
        })
    # Suggested env value: the working models, current ones first.
    good = [c["model"] for c in out["candidates"] if c["ok"]]
    good.sort(key=lambda m: (m not in _MODELS, _CANDIDATE_MODELS.index(m)))
    out["suggested_env"] = ",".join(good)
    return out


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


class GeminiUnavailable(Exception):
    """Raised when a request couldn't be answered at all (every slot on
    cooldown / quota, or a network failure) — distinct from Gemini actually
    replying "NONE". Callers use this to know NOT to cache the miss."""


def resolve_brand_name(brand_ja: str) -> "str | None":
    """Ask Gemini for the real Latin-script spelling of a brand name written
    in Japanese.

    Returns the name, or None when Gemini replies "NONE" / low confidence
    (a real, cacheable "no answer"). Raises GeminiUnavailable when it
    couldn't get an answer at all (all keys out of quota, network down) —
    the caller should retry later rather than cache that as a permanent
    miss. Also returns None (no raise) when no key is configured.
    """
    if not ENABLED or not (brand_ja or "").strip():
        return None
    text = _generate(
        [{"text": _PROMPT_TEMPLATE.format(brand_ja=brand_ja.strip())}],
        max_output_tokens=32,
    )
    if text is None:
        raise GeminiUnavailable(brand_ja)
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
    """Fetch one image and return a generateContent inline_data part, or None.
    On any failure, records the reason in the per-run tally (see _tag_stat) so
    the caller can report WHY a tagging pass stalled instead of guessing."""
    try:
        r = requests.get(image_url, headers=_IMG_DOWNLOAD_HEADERS, timeout=15)
        r.raise_for_status()
    except requests.Timeout:
        _tag_stat("dl_timeout")
        logger.warning("gemini_client: image download timed out: %r", image_url)
        return None
    except requests.HTTPError as exc:
        code = getattr(exc.response, "status_code", 0) or 0
        bucket = (
            "dl_http_404" if code == 404 else
            "dl_http_403" if code == 403 else
            "dl_http_5xx" if 500 <= code < 600 else
            "dl_http_other"
        )
        _tag_stat(bucket)
        logger.warning("gemini_client: image download HTTP %s: %r", code, image_url)
        return None
    except requests.RequestException as exc:
        _tag_stat("dl_conn")
        logger.warning("gemini_client: image download failed (%s): %r", type(exc).__name__, image_url)
        return None
    except Exception as exc:  # noqa: BLE001
        _tag_stat("dl_other")
        logger.warning("gemini_client: failed to download image %r: %s", image_url, exc)
        return None
    mime = (r.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip().lower()
    if mime in ("text/html", "application/json", "application/xml", "text/xml", "text/plain"):
        # A 200 that's actually an error page / bucket-listing XML — feeding it
        # to Gemini just burns a request. Treat it as an unreachable photo.
        _tag_stat("dl_not_image")
        logger.warning("gemini_client: download was %s, not an image: %r", mime, image_url)
        return None
    if not mime.startswith("image/"):
        mime = "image/jpeg"
    return {"inline_data": {"mime_type": mime, "data": base64.b64encode(r.content).decode("ascii")}}


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

    downloaded = list(_DL_POOL.map(_download_image, image_urls))
    ok_idx = [i for i, d in enumerate(downloaded) if d is not None]
    if not ok_idx:
        return [None] * n

    out: list = [None] * n

    def _blame_no_reply(count: int) -> None:
        """A None from _generate is either 'every key on cooldown' (daily
        quota spent — recovers itself) or 'asked but got nothing back'."""
        _tag_stat("gemini_all_cooling" if slot_status().get("all_cooling") else "gemini_no_reply", count)

    # One good image left -> the single-object prompt parses more reliably
    # than asking for a 1-element array.
    if len(ok_idx) == 1:
        i = ok_idx[0]
        text = _generate([{"text": _TAG_PROMPT_ONE}, downloaded[i]], max_output_tokens=256, response_json=True)
        if not text:
            _blame_no_reply(1)
            return out
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            _tag_stat("gemini_bad_json")
            return out
        try:
            out[i] = _clean_tag(json.loads(m.group(0)))
            _tag_stat("ok")
        except Exception:  # noqa: BLE001
            _tag_stat("gemini_bad_json")
        return out

    parts = [{"text": _tag_prompt_batch(len(ok_idx))}]
    for i in ok_idx:
        parts.append(downloaded[i])
    # ~90 output tokens per object is plenty for this fixed 4-field shape.
    text = _generate(parts, max_output_tokens=64 + 90 * len(ok_idx), timeout=60, response_json=True)
    if not text:
        _blame_no_reply(len(ok_idx))
        return out
    m = re.search(r"\[.*\]", text, re.DOTALL)
    if not m:
        logger.warning("gemini_client: batch reply had no JSON array")
        _tag_stat("gemini_bad_json", len(ok_idx))
        return out
    try:
        arr = json.loads(m.group(0))
    except Exception as exc:  # noqa: BLE001
        logger.warning("gemini_client: batch JSON array unparseable: %s", exc)
        _tag_stat("gemini_bad_json", len(ok_idx))
        return out
    if not isinstance(arr, list) or len(arr) != len(ok_idx):
        logger.warning(
            "gemini_client: batch returned %s items, expected %d",
            len(arr) if isinstance(arr, list) else type(arr).__name__, len(ok_idx),
        )
        _tag_stat("gemini_count_mismatch", len(ok_idx))
        return out
    for pos, i in enumerate(ok_idx):
        out[i] = _clean_tag(arr[pos])
    _tag_stat("ok", len(ok_idx))
    return out


def tag_image(image_url: str) -> "Optional[dict]":
    """Single-photo convenience wrapper around tag_images()."""
    return tag_images([image_url])[0]
