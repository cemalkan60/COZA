import { storage } from "@/src/utils/storage";

const BASE = `${process.env.EXPO_PUBLIC_BACKEND_URL}/api`;
export const TOKEN_KEY = "coza.auth.token";

export type Product = {
  product_id: string;
  name: string;
  price: number;
  currency: string;
  category: string;
  family: string;
  color: string;
  images: string[];
  reference: string;
  display_reference: string;
  origin: string;
  supplier_code: string;
  seo_keyword: string;
  seo_product_id: string;
};

async function request(path: string, init: RequestInit = {}, auth = false) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (auth) {
    const token = await storage.secureGet<string>(TOKEN_KEY, "");
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.detail || `Bir hata oluştu (${res.status})`;
    throw new Error(typeof message === "string" ? message : "İstek başarısız");
  }
  return data;
}

export type ProductQuery = {
  category?: string;
  origin?: string;
  supplier?: string;
  q?: string;
  min_price?: number;
  max_price?: number;
  sort?: string;
  skip?: number;
  limit?: number;
};

function toQuery(params: Record<string, unknown>) {
  const parts: string[] = [];
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") {
      parts.push(`${k}=${encodeURIComponent(String(v))}`);
    }
  });
  return parts.length ? `?${parts.join("&")}` : "";
}

export const api = {
  signup: (email: string, password: string, name: string) =>
    request("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    }),
  login: (email: string, password: string) =>
    request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  me: () => request("/auth/me", {}, true),

  products: (query: ProductQuery = {}) =>
    request(`/products${toQuery(query as Record<string, unknown>)}`),
  product: (id: string) => request(`/products/${id}`),
  filters: () => request("/filters"),
  analytics: () => request("/analytics"),
  meta: () => request("/meta"),
  scrape: () => request("/admin/scrape", { method: "POST" }, true),

  favorites: () => request("/favorites", {}, true),
  favoriteIds: () => request("/favorites/ids", {}, true),
  addFavorite: (product_id: string) =>
    request("/favorites", { method: "POST", body: JSON.stringify({ product_id }) }, true),
  removeFavorite: (product_id: string) =>
    request(`/favorites/${product_id}`, { method: "DELETE" }, true),
};
