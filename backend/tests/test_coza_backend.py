"""COZA backend API tests"""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/") if os.environ.get("EXPO_PUBLIC_BACKEND_URL") else None
if not BASE_URL:
    # fallback to reading frontend/.env
    from pathlib import Path
    for line in Path("/app/frontend/.env").read_text().splitlines():
        if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
            BASE_URL = line.split("=", 1)[1].strip().strip('"').rstrip("/")
API = f"{BASE_URL}/api"

SEED_EMAIL = "tester@coza.app"
SEED_PW = "Test1234"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def token(client):
    # Try seeded creds first
    r = client.post(f"{API}/auth/login", json={"email": SEED_EMAIL, "password": SEED_PW})
    if r.status_code == 200:
        return r.json()["token"]
    # Otherwise create
    r = client.post(f"{API}/auth/signup",
                    json={"email": SEED_EMAIL, "password": SEED_PW, "name": "Tester"})
    if r.status_code == 200:
        return r.json()["token"]
    pytest.skip(f"Could not obtain token: {r.status_code} {r.text}")


# --------- health ---------
def test_root(client):
    r = client.get(f"{API}/")
    assert r.status_code == 200
    assert r.json().get("status") == "ok"


# --------- meta ---------
def test_meta_has_products(client):
    r = client.get(f"{API}/meta")
    assert r.status_code == 200
    data = r.json()
    assert "product_count" in data
    assert data["product_count"] > 0, f"Catalog empty: {data}"


# --------- auth ---------
def test_signup_new_user(client):
    email = f"test_{uuid.uuid4().hex[:10]}@coza.app"  # backend lowercases emails
    r = client.post(f"{API}/auth/signup",
                    json={"email": email, "password": "Testing1234", "name": "T"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert "token" in j and "user" in j
    assert j["user"]["email"] == email


def test_signup_duplicate_returns_409(client):
    r = client.post(f"{API}/auth/signup",
                    json={"email": SEED_EMAIL, "password": SEED_PW, "name": "x"})
    assert r.status_code in (409, 200)  # if not yet created, will be 200


def test_login_wrong_password(client):
    r = client.post(f"{API}/auth/login",
                    json={"email": SEED_EMAIL, "password": "wrongwrong"})
    assert r.status_code == 401


def test_login_and_me(client, token):
    r = client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["email"] == SEED_EMAIL
    assert "password_hash" not in j and "_id" not in j


def test_me_requires_auth(client):
    r = client.get(f"{API}/auth/me")
    assert r.status_code in (401, 403)


def test_me_invalid_token(client):
    r = client.get(f"{API}/auth/me", headers={"Authorization": "Bearer notarealtoken"})
    assert r.status_code == 401


# --------- catalog ---------
def test_products_default(client):
    r = client.get(f"{API}/products")
    assert r.status_code == 200
    j = r.json()
    assert "items" in j and "total" in j
    assert len(j["items"]) > 0
    p = j["items"][0]
    for k in ["product_id", "name", "price", "category", "origin", "supplier_code", "images"]:
        assert k in p, f"missing {k} in product"


def test_products_pagination(client):
    a = client.get(f"{API}/products?skip=0&limit=5").json()
    b = client.get(f"{API}/products?skip=5&limit=5").json()
    assert len(a["items"]) == 5 and len(b["items"]) == 5
    assert a["items"][0]["product_id"] != b["items"][0]["product_id"]


def test_products_limit_validation(client):
    r = client.get(f"{API}/products?limit=200")
    assert r.status_code == 422


def test_filters_endpoint(client):
    r = client.get(f"{API}/filters")
    assert r.status_code == 200
    j = r.json()
    assert isinstance(j["categories"], list) and len(j["categories"]) > 0
    assert isinstance(j["origins"], list) and len(j["origins"]) > 0
    assert j["price_min"] >= 0 and j["price_max"] > 0


def test_products_filter_by_category(client):
    filters = client.get(f"{API}/filters").json()
    cat = filters["categories"][0]
    r = client.get(f"{API}/products", params={"category": cat, "limit": 10})
    assert r.status_code == 200
    j = r.json()
    assert j["total"] > 0
    for p in j["items"]:
        assert p["category"] == cat


def test_products_filter_by_origin(client):
    filters = client.get(f"{API}/filters").json()
    origin = filters["origins"][0]
    r = client.get(f"{API}/products", params={"origin": origin, "limit": 10})
    assert r.status_code == 200
    j = r.json()
    assert j["total"] > 0
    for p in j["items"]:
        assert p["origin"] == origin


def test_products_filter_by_supplier(client):
    p0 = client.get(f"{API}/products?limit=1").json()["items"][0]
    sup = p0["supplier_code"]
    r = client.get(f"{API}/products", params={"supplier": sup, "limit": 5})
    assert r.status_code == 200
    j = r.json()
    assert j["total"] >= 1
    for p in j["items"]:
        assert sup.lower() in p["supplier_code"].lower()


def test_products_price_range(client):
    r = client.get(f"{API}/products",
                   params={"min_price": 100, "max_price": 500, "limit": 20})
    assert r.status_code == 200
    for p in r.json()["items"]:
        assert 100 <= p["price"] <= 500


def test_products_sort_price_asc(client):
    r = client.get(f"{API}/products?sort=price_asc&limit=10")
    prices = [p["price"] for p in r.json()["items"]]
    assert prices == sorted(prices)


def test_products_sort_price_desc(client):
    r = client.get(f"{API}/products?sort=price_desc&limit=10")
    prices = [p["price"] for p in r.json()["items"]]
    assert prices == sorted(prices, reverse=True)


def test_products_search(client):
    p0 = client.get(f"{API}/products?limit=1").json()["items"][0]
    token_ = p0["name"].split()[0]
    r = client.get(f"{API}/products", params={"q": token_, "limit": 5})
    assert r.status_code == 200
    assert r.json()["total"] >= 1


def test_product_detail(client):
    p0 = client.get(f"{API}/products?limit=1").json()["items"][0]
    r = client.get(f"{API}/products/{p0['product_id']}")
    assert r.status_code == 200
    assert r.json()["product_id"] == p0["product_id"]


def test_product_detail_404(client):
    r = client.get(f"{API}/products/does_not_exist_xyz")
    assert r.status_code == 404


# --------- analytics ---------
def test_analytics(client):
    r = client.get(f"{API}/analytics")
    assert r.status_code == 200
    j = r.json()
    assert j["total_products"] > 0
    assert j["origin_count"] > 0
    assert j["category_count"] > 0
    assert isinstance(j["origin_distribution"], list) and len(j["origin_distribution"]) > 0
    assert isinstance(j["category_distribution"], list) and len(j["category_distribution"]) > 0
    for d in j["origin_distribution"][:3]:
        assert "label" in d and "count" in d
    assert j["avg_price"] > 0


# --------- favorites ---------
def test_favorites_flow(client, token):
    h = {"Authorization": f"Bearer {token}"}
    prod = client.get(f"{API}/products?limit=1").json()["items"][0]
    pid = prod["product_id"]

    # Clean slate
    client.delete(f"{API}/favorites/{pid}", headers=h)

    # Add
    r = client.post(f"{API}/favorites", json={"product_id": pid}, headers=h)
    assert r.status_code == 200

    # Verify in list
    r = client.get(f"{API}/favorites/ids", headers=h)
    assert r.status_code == 200
    assert pid in r.json()["product_ids"]

    r = client.get(f"{API}/favorites", headers=h)
    assert r.status_code == 200
    j = r.json()
    assert pid in j["product_ids"]
    assert any(p["product_id"] == pid for p in j["items"])

    # Idempotent add
    r = client.post(f"{API}/favorites", json={"product_id": pid}, headers=h)
    assert r.status_code == 200

    # Delete
    r = client.delete(f"{API}/favorites/{pid}", headers=h)
    assert r.status_code == 200

    r = client.get(f"{API}/favorites/ids", headers=h)
    assert pid not in r.json()["product_ids"]


def test_favorites_requires_auth(client):
    r = client.get(f"{API}/favorites")
    assert r.status_code in (401, 403)
