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
import logging
import os

import requests

logger = logging.getLogger("coza.gemini_client")

_API_KEY = os.environ.get("GEMINI_API_KEY", "")
_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")

ENABLED = bool(_API_KEY)

_ENDPOINT = (
    f"https://generativelanguage.googleapis.com/v1beta/models/{_MODEL}:generateContent"
)

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
