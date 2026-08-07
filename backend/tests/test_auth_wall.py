"""COZA iteration 4 — Closed auth wall + scheduler config tests.

Verifies:
- POST /api/auth/login for all 5 fixed accounts (cem admin, ece/burak/beyza/ferdi viewers)
- Wrong credentials / unknown username return 401
- POST /api/auth/signup no longer exists (404 / 405)
- Admin-only endpoints: cem 200, viewer 403
- GET /api/auth/me returns correct role
- db.users converged to exactly the 5 fixed users
"""
import os
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

FIXED_USERS = [
    ("cem", "Umutcem1085", "admin"),
    ("ece", "ece123", "viewer"),
    ("burak", "burak123", "viewer"),
    ("beyza", "beyza123", "viewer"),
    ("ferdi", "ferdi123", "viewer"),
]


@pytest.fixture(scope="module")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _login(client, username, password):
    return client.post(f"{API}/auth/login", json={"email": username, "password": password})


@pytest.fixture(scope="module")
def admin_token(api_client):
    r = _login(api_client, "cem", "Umutcem1085")
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def viewer_token(api_client):
    r = _login(api_client, "ferdi", "ferdi123")
    assert r.status_code == 200, r.text
    return r.json()["token"]


# ---- Login: all 5 fixed users succeed ----
@pytest.mark.parametrize("username,password,role", FIXED_USERS)
def test_login_success_all_fixed_users(api_client, username, password, role):
    r = _login(api_client, username, password)
    assert r.status_code == 200, f"{username}: {r.status_code} {r.text}"
    data = r.json()
    assert "token" in data and isinstance(data["token"], str) and len(data["token"]) > 20
    assert "user" in data
    u = data["user"]
    assert u["email"] == username
    assert u["role"] == role
    assert "id" in u and u["id"]


def test_login_case_insensitive_admin(api_client):
    r = _login(api_client, "CEM", "Umutcem1085")
    assert r.status_code == 200
    assert r.json()["user"]["role"] == "admin"


# ---- Login failures ----
def test_login_wrong_password_admin(api_client):
    r = _login(api_client, "cem", "wrongPassword")
    assert r.status_code == 401


def test_login_wrong_password_viewer(api_client):
    r = _login(api_client, "ferdi", "not-ferdi")
    assert r.status_code == 401


def test_login_unknown_username(api_client):
    r = _login(api_client, "admin@still", "cozaadmin2026")
    assert r.status_code == 401


def test_login_removed_legacy_username(api_client):
    r = _login(api_client, "cem@still", "cem123")
    assert r.status_code == 401


# ---- Signup removed ----
def test_signup_endpoint_removed(api_client):
    r = api_client.post(
        f"{API}/auth/signup",
        json={"email": "x@x.com", "password": "xxxxxxxx", "name": "x"},
    )
    # FastAPI returns 404 when the route doesn't exist
    assert r.status_code in (404, 405), f"expected signup gone, got {r.status_code} {r.text}"


# ---- /auth/me ----
def test_me_admin_role(api_client, admin_token):
    r = api_client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 200
    data = r.json()
    assert data["email"] == "cem"
    assert data["role"] == "admin"
    assert "password_hash" not in data


def test_me_viewer_role(api_client, viewer_token):
    r = api_client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {viewer_token}"})
    assert r.status_code == 200
    data = r.json()
    assert data["email"] == "ferdi"
    assert data["role"] == "viewer"


def test_me_requires_auth(api_client):
    r = api_client.get(f"{API}/auth/me")
    assert r.status_code in (401, 403)


# ---- Admin-only endpoints: viewer forbidden, admin allowed ----
def test_admin_settings_viewer_403(api_client, viewer_token):
    r = api_client.get(
        f"{API}/admin/settings", headers={"Authorization": f"Bearer {viewer_token}"}
    )
    assert r.status_code == 403


def test_admin_settings_admin_200(api_client, admin_token):
    r = api_client.get(
        f"{API}/admin/settings", headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert r.status_code == 200
    data = r.json()
    assert "proxy_api_key_masked" in data
    assert "db_name" in data


def test_admin_enrich_viewer_403(api_client, viewer_token):
    r = api_client.post(
        f"{API}/admin/enrich-origins",
        headers={"Authorization": f"Bearer {viewer_token}"},
    )
    assert r.status_code == 403


def test_admin_enrich_admin_ok(api_client, admin_token):
    # Idempotent trigger — either starts or reports already running.
    r = api_client.post(
        f"{API}/admin/enrich-origins",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data.get("status") in ("started", "already_running")


def test_admin_scrape_viewer_403(api_client, viewer_token):
    # Do NOT call as admin — full scrape is heavy. Only assert 403 for viewer.
    r = api_client.post(
        f"{API}/admin/scrape", headers={"Authorization": f"Bearer {viewer_token}"}
    )
    assert r.status_code == 403


# ---- DB integrity: exactly 5 users, matching allow-list ----
def test_db_contains_exactly_five_users():
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "test_database")
    with MongoClient(mongo_url) as c:
        users = list(c[db_name].users.find({}, {"_id": 0, "email": 1, "role": 1}))
    emails = sorted(u["email"] for u in users)
    assert emails == sorted(u[0] for u in FIXED_USERS), f"user set drifted: {emails}"
    role_by_email = {u["email"]: u["role"] for u in users}
    assert role_by_email["cem"] == "admin"
    for viewer in ("ece", "burak", "beyza", "ferdi"):
        assert role_by_email[viewer] == "viewer"
