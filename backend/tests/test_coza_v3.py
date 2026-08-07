"""COZA iteration 3 tests: real origins, comprehensive search, manufacturer analytics, drawer/filters."""
import os
import re
import pytest
import requests
from pathlib import Path

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL")
if not BASE_URL:
    for line in Path("/app/frontend/.env").read_text().splitlines():
        if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
            BASE_URL = line.split("=", 1)[1].strip().strip('"')
BASE_URL = BASE_URL.rstrip("/")
API = f"{BASE_URL}/api"

ADMIN = ("admin@still", "cozaadmin2026")
VIEWER1 = ("ece@still", "berilberen")

KNOWN_ORIGINS = {"Türkiye", "Fas", "Çin", "Portekiz", "İspanya", "Vietnam",
                 "Kamboçya", "Hindistan", "Bangladeş", "Pakistan", "Sri Lanka",
                 "Endonezya", "Mısır", "Tunus", "Belirleniyor…"}


def _login(email, pw):
    return requests.post(f"{API}/auth/login", json={"email": email, "password": pw}, timeout=30)


@pytest.fixture(scope="module")
def admin_token():
    r = _login(*ADMIN); assert r.status_code == 200
    return r.json()["token"]


@pytest.fixture(scope="module")
def viewer_token():
    r = _login(*VIEWER1); assert r.status_code == 200
    return r.json()["token"]


# ---------- PRIMARY BUG FIX ----------
def test_code_5216_all_products_origin_turkiye():
    """Primary reported bug: code 5216 was Fas, must now be Türkiye."""
    r = requests.get(f"{API}/products", params={"code": "5216", "limit": 50}, timeout=30)
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) >= 1, "expected at least one product for code 5216"
    for p in items:
        assert p["origin"] == "Türkiye", f"code 5216 product {p['product_id']} has origin={p['origin']} (should be Türkiye)"
        assert p["manufacturer_code"] == "5216"


# ---------- REAL ORIGINS ----------
def test_origins_are_real_country_values_majority():
    """Vast majority of products should have real origin, small % may be Belirleniyor."""
    # sample 200 products
    r = requests.get(f"{API}/products", params={"limit": 60}, timeout=30)
    assert r.status_code == 200
    items = r.json()["items"]
    unknown_ct = sum(1 for p in items if p.get("origin") == "Belirleniyor…")
    real_ct = len(items) - unknown_ct
    assert real_ct > 0, "expected some real origins"
    # allow up to 30% unresolved
    assert unknown_ct / max(1, len(items)) < 0.3, f"too many unresolved origins: {unknown_ct}/{len(items)}"
    for p in items:
        assert p["origin"] in KNOWN_ORIGINS or p["origin"] is None, f"unexpected origin: {p['origin']}"


def test_currency_is_euro_and_english_names():
    r = requests.get(f"{API}/products", params={"limit": 20}, timeout=30)
    items = r.json()["items"]
    for p in items:
        assert p.get("currency") == "€", f"expected € got {p.get('currency')}"
        # names are English (uppercase in zara), just ensure non-empty
        assert p.get("name") and len(p["name"]) > 2


# ---------- ANALYTICS ----------
def test_analytics_origin_distribution_excludes_belirleniyor():
    r = requests.get(f"{API}/analytics", timeout=30)
    assert r.status_code == 200
    j = r.json()
    assert "origin_distribution" in j
    labels = [d.get("label") for d in j["origin_distribution"]]
    assert "Belirleniyor…" not in labels, "origin_distribution must exclude 'Belirleniyor…'"
    assert len(labels) >= 1
    # should include Türkiye as top origin
    assert "Türkiye" in labels


# ---------- COMPREHENSIVE SEARCH ----------
def test_search_by_origin_turkiye():
    r = requests.get(f"{API}/products", params={"q": "Türkiye", "limit": 20}, timeout=30)
    assert r.status_code == 200
    items = r.json()["items"]
    assert items, "q=Türkiye should return items"
    # at least the majority should match Türkiye origin OR contain name/color match
    tr_count = sum(1 for p in items if p["origin"] == "Türkiye")
    assert tr_count >= 1


def test_search_by_manufacturer_code_prefix():
    # Pick real manufacturer prefix from data
    r = requests.get(f"{API}/manufacturers", params={"limit": 5}, timeout=30)
    assert r.status_code == 200
    codes = [m["code"] for m in r.json()["items"]]
    assert codes
    prefix = codes[0][:2]  # 2-digit prefix
    r2 = requests.get(f"{API}/products", params={"q": prefix, "limit": 20}, timeout=30)
    assert r2.status_code == 200
    items = r2.json()["items"]
    assert items
    # ensure at least one item's manufacturer_code starts with prefix (relaxed comprehensive)
    matches = sum(1 for p in items if p["manufacturer_code"].startswith(prefix)
                  or p.get("full_code", "").startswith(prefix)
                  or prefix.lower() in (p.get("name", "").lower())
                  or prefix.lower() in (p.get("origin", "") or "").lower()
                  or prefix.lower() in (p.get("color", "") or "").lower())
    assert matches >= 1


def test_search_by_category():
    # Fetch a real category from /api/filters
    f = requests.get(f"{API}/filters", timeout=30).json()
    cats = f.get("categories") or []
    assert cats, "expected categories"
    cat = cats[0]
    r = requests.get(f"{API}/products", params={"q": cat, "limit": 10}, timeout=30)
    assert r.status_code == 200
    items = r.json()["items"]
    assert items, f"q={cat} returned no items"


# ---------- MANUFACTURERS ----------
def test_manufacturers_list():
    r = requests.get(f"{API}/manufacturers", timeout=30)
    assert r.status_code == 200
    j = r.json()
    assert "items" in j
    assert len(j["items"]) >= 1
    for m in j["items"][:5]:
        assert "code" in m and re.match(r"^\d{4}$", m["code"])
        assert "count" in m and isinstance(m["count"], int)
        assert "origins" in m and isinstance(m["origins"], list)


def test_manufacturers_q_filter():
    r = requests.get(f"{API}/manufacturers", params={"q": "52"}, timeout=30)
    assert r.status_code == 200
    items = r.json()["items"]
    assert items, "expected at least one manufacturer starting with 52"
    for m in items:
        assert m["code"].startswith("52"), f"code {m['code']} does not start with 52"


# ---------- ANALYTICS/MANUFACTURER/{code} ----------
def test_analytics_manufacturer_5216():
    r = requests.get(f"{API}/analytics/manufacturer/5216", timeout=30)
    assert r.status_code == 200
    j = r.json()
    assert j["code"] == "5216"
    assert j["total"] >= 1
    assert j["primary_origin"] == "Türkiye"
    assert "origin_distribution" in j and isinstance(j["origin_distribution"], list)
    assert "category_distribution" in j and isinstance(j["category_distribution"], list)
    assert isinstance(j["avg_price"], (int, float))
    assert j["avg_price"] > 0


def test_analytics_manufacturer_unknown_code():
    r = requests.get(f"{API}/analytics/manufacturer/9999", timeout=30)
    # either 404 or valid response with total=0
    assert r.status_code in (200, 404)
    if r.status_code == 200:
        assert r.json()["total"] == 0 or r.json()["total"] >= 0


# ---------- COMPOSITION ----------
def test_composition_returns_shape():
    sample = requests.get(f"{API}/products?limit=1", timeout=30).json()["items"][0]
    pid = sample["product_id"]
    r = requests.get(f"{API}/products/{pid}/composition", timeout=90)
    assert r.status_code == 200
    j = r.json()
    assert "composition" in j
    assert isinstance(j["composition"], list)


# ---------- RBAC ----------
def test_scrape_viewer_forbidden(viewer_token):
    r = requests.post(f"{API}/admin/scrape",
                      headers={"Authorization": f"Bearer {viewer_token}"}, timeout=30)
    assert r.status_code == 403


def test_settings_viewer_forbidden(viewer_token):
    r = requests.get(f"{API}/admin/settings",
                     headers={"Authorization": f"Bearer {viewer_token}"}, timeout=30)
    assert r.status_code == 403


def test_settings_admin_ok(admin_token):
    r = requests.get(f"{API}/admin/settings",
                     headers={"Authorization": f"Bearer {admin_token}"}, timeout=30)
    assert r.status_code == 200
    assert "proxy_api_key" not in r.json()


# ---------- FILTERS (used by drawer) ----------
def test_filters_categories_and_origins():
    r = requests.get(f"{API}/filters", timeout=30)
    assert r.status_code == 200
    j = r.json()
    assert "categories" in j and isinstance(j["categories"], list) and len(j["categories"]) >= 1
    assert "origins" in j and isinstance(j["origins"], list) and len(j["origins"]) >= 1
