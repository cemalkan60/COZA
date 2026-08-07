"""COZA iteration 2 tests: roles, manufacturer_code, admin settings, composition."""
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
VIEWER2 = ("cem@still", "cem123")


def _login(email, pw):
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": pw}, timeout=30)
    return r


@pytest.fixture(scope="module")
def admin_token():
    r = _login(*ADMIN)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    j = r.json()
    assert j["user"]["role"] == "admin"
    return j["token"]


@pytest.fixture(scope="module")
def viewer_token():
    r = _login(*VIEWER1)
    assert r.status_code == 200, f"viewer login failed: {r.status_code} {r.text}"
    j = r.json()
    assert j["user"]["role"] == "viewer"
    return j["token"]


# ---------- non-email usernames ----------
def test_login_ece_non_email():
    r = _login(*VIEWER1)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["user"]["email"] == "ece@still"
    assert j["user"]["role"] == "viewer"


def test_login_cem_non_email():
    r = _login(*VIEWER2)
    assert r.status_code == 200, r.text
    assert r.json()["user"]["role"] == "viewer"


def test_login_admin_has_admin_role():
    r = _login(*ADMIN)
    assert r.status_code == 200
    assert r.json()["user"]["role"] == "admin"


def test_login_wrong_pw():
    r = _login("ece@still", "nope")
    assert r.status_code == 401


# ---------- RBAC ----------
def test_admin_settings_get_admin_ok(admin_token):
    r = requests.get(f"{API}/admin/settings",
                     headers={"Authorization": f"Bearer {admin_token}"}, timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()
    assert "proxy_api_key_masked" in j
    # must be masked, never plaintext
    assert "•" in j["proxy_api_key_masked"] or "*" in j["proxy_api_key_masked"] or j["proxy_api_key_masked"] == "••••"
    assert "db_name" in j
    assert "proxy_api_key" not in j  # plaintext never leaked


def test_admin_settings_get_viewer_forbidden(viewer_token):
    r = requests.get(f"{API}/admin/settings",
                     headers={"Authorization": f"Bearer {viewer_token}"}, timeout=30)
    assert r.status_code == 403


def test_admin_settings_put_viewer_forbidden(viewer_token):
    r = requests.put(f"{API}/admin/settings",
                     json={"proxy_api_key": "TEST_KEY_XXXXXXXX", "storage_note": "test"},
                     headers={"Authorization": f"Bearer {viewer_token}"}, timeout=30)
    assert r.status_code == 403


def test_admin_settings_put_admin_ok(admin_token):
    # capture current
    prev = requests.get(f"{API}/admin/settings",
                       headers={"Authorization": f"Bearer {admin_token}"}, timeout=30).json()
    prev_note = prev.get("storage_note", "")

    new_note = "TEST_note_iteration2"
    r = requests.put(f"{API}/admin/settings",
                     json={"proxy_api_key": "TEST_ROTATE_KEY_1234", "storage_note": new_note},
                     headers={"Authorization": f"Bearer {admin_token}"}, timeout=30)
    assert r.status_code == 200, r.text

    # verify persistence
    got = requests.get(f"{API}/admin/settings",
                       headers={"Authorization": f"Bearer {admin_token}"}, timeout=30).json()
    assert got["storage_note"] == new_note
    assert got["proxy_api_key_masked"].startswith("TEST") or got["proxy_api_key_masked"].endswith("1234")

    # restore original storage_note but keep any real key intact would require the real key;
    # since our env fallback is used when db is missing, restore only the note.
    requests.put(f"{API}/admin/settings",
                 json={"proxy_api_key": "TEST_ROTATE_KEY_1234", "storage_note": prev_note},
                 headers={"Authorization": f"Bearer {admin_token}"}, timeout=30)


def test_scrape_viewer_forbidden(viewer_token):
    r = requests.post(f"{API}/admin/scrape",
                      headers={"Authorization": f"Bearer {viewer_token}"}, timeout=30)
    assert r.status_code == 403


# ---------- manufacturer_code / q / code ----------
def test_products_have_manufacturer_code_and_full_code():
    r = requests.get(f"{API}/products?limit=5", timeout=30)
    assert r.status_code == 200
    items = r.json()["items"]
    assert items
    for p in items:
        assert "manufacturer_code" in p, f"missing manufacturer_code: {p.keys()}"
        assert "full_code" in p, f"missing full_code: {p.keys()}"
        assert re.match(r"^\d{4}$", p["manufacturer_code"]), \
            f"manufacturer_code should be 4 digits: {p['manufacturer_code']}"


def test_products_q_prefix_returns_matching_manufacturer_codes():
    # pick a real prefix from data
    sample = requests.get(f"{API}/products?limit=1", timeout=30).json()["items"][0]
    prefix = sample["manufacturer_code"]
    r = requests.get(f"{API}/products", params={"q": prefix, "limit": 20}, timeout=30)
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) >= 1
    for p in items:
        assert (
            p["manufacturer_code"].startswith(prefix)
            or p.get("full_code", "").startswith(prefix)
            or prefix.lower() in p["name"].lower()
        ), f"item {p['product_id']} did not match prefix {prefix}"


def test_products_code_filter_prefix():
    sample = requests.get(f"{API}/products?limit=1", timeout=30).json()["items"][0]
    prefix = sample["manufacturer_code"]
    r = requests.get(f"{API}/products", params={"code": prefix, "limit": 20}, timeout=30)
    assert r.status_code == 200
    items = r.json()["items"]
    assert items, f"no items for code={prefix}"
    for p in items:
        assert p["manufacturer_code"].startswith(prefix)


def test_products_is_new_filter_boolean():
    r = requests.get(f"{API}/products", params={"is_new": "true", "limit": 20}, timeout=30)
    assert r.status_code == 200
    items = r.json()["items"]
    # OK if empty on first seed, but every returned must have is_new True
    for p in items:
        assert p.get("is_new") is True


# ---------- composition ----------
def test_product_composition_returns_shape():
    sample = requests.get(f"{API}/products?limit=1", timeout=30).json()["items"][0]
    pid = sample["product_id"]
    r = requests.get(f"{API}/products/{pid}/composition", timeout=60)
    assert r.status_code == 200, r.text
    j = r.json()
    assert "composition" in j
    comp = j["composition"]
    assert isinstance(comp, list)
    if comp:  # non-empty
        first = comp[0]
        assert "area" in first
        assert "materials" in first
        # materials may be a string ("%100 viskoz") or a list — accept both
        assert isinstance(first["materials"], (str, list))

    # 2nd call should hit cache (fast, same shape)
    r2 = requests.get(f"{API}/products/{pid}/composition", timeout=30)
    assert r2.status_code == 200
    assert r2.json()["composition"] == comp


def test_composition_404():
    r = requests.get(f"{API}/products/nope_xyz/composition", timeout=30)
    assert r.status_code == 404
