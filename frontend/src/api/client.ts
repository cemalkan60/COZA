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
  department: string;
  color: string;
  images: string[];
  reference: string;
  display_reference: string;
  full_code: string;
  manufacturer_code: string;
  supplier_code: string;
  origin: string;
  is_new?: boolean;
  removed?: boolean;
  seo_keyword: string;
  seo_product_id: string;
};

export type Composition = { area: string; materials: string }[];

// ---- COZA Fashion (fashion-press.net runway collections) ----
export type FashionItem = {
  source_id: string;
  url: string;
  image: string | null;
  title_ja: string;
  title_tr: string;
  brand_tr: string;
  season: string;
  season_label: string;
  updated_at?: string;
};

export type FashionAnalytics = {
  total: number;
  seasons: { label: string; count: number }[];
  brands: { label: string; count: number }[];
  brand_count: number;
  last_scrape: string | null;
};

// ---- COZA Fashion coordinate search ("kombin arama") ----
export type FashionLookItem = {
  source_id: string;
  url: string;
  image: string | null;
  brand_tr: string;
  season_text_tr: string;
};

export type FashionLookOption = { value: string; label: string; hex?: string };
export type FashionLookItemGroup = { group: string; options: FashionLookOption[] };

export type FashionLookFilters = {
  genders: FashionLookOption[];
  seasons: FashionLookOption[];
  items: FashionLookItemGroup[];
  colors: FashionLookOption[];
  materials: FashionLookOption[];
  patterns: FashionLookOption[];
};

export type FashionLookQuery = {
  gender?: string;
  season?: string;
  item?: string;
  color?: string;
  material?: string;
  pattern?: string;
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
  department?: string;
  origin?: string;
  supplier?: string;
  code?: string;
  q?: string;
  is_new?: boolean;
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
  login: (email: string, password: string) =>
    request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  me: () => request("/auth/me", {}, true),

  products: (query: ProductQuery = {}) =>
    request(`/products${toQuery(query as Record<string, unknown>)}`),
  product: (id: string) => request(`/products/${id}`),
  setRemoved: (product_id: string, removed: boolean) =>
    request(
      `/products/${product_id}/removed`,
      { method: "POST", body: JSON.stringify({ removed }) },
      true,
    ),
  composition: (id: string) => request(`/products/${id}/composition`),
  filters: () => request("/filters"),
  analytics: (
    params: { department?: string; category?: string; family?: string; origin?: string } = {},
  ) => request(`/analytics${toQuery(params as Record<string, unknown>)}`),
  manufacturers: (q?: string) => request(`/manufacturers${toQuery({ q, limit: 24 })}`),
  manufacturerAnalytics: (code: string) => request(`/analytics/manufacturer/${code}`),
  meta: () => request("/meta"),
  scrape: () => request("/admin/scrape", { method: "POST" }, true),
  adminSettings: () => request("/admin/settings", {}, true),
  updateAdminSettings: (proxy_api_key: string, storage_note: string) =>
    request(
      "/admin/settings",
      { method: "PUT", body: JSON.stringify({ proxy_api_key, storage_note }) },
      true,
    ),

  // ---- COZA Fashion ----
  fashionCollections: (
    params: { season?: string; q?: string; skip?: number; limit?: number } = {},
  ) => request(`/fashion/collections${toQuery(params as Record<string, unknown>)}`, {}, true),
  fashionAnalytics: () => request("/fashion/analytics", {}, true),
  fashionMeta: () => request("/fashion/meta", {}, true),
  fashionLookFilters: (): Promise<FashionLookFilters> => request("/fashion/looks/filters", {}, true),
  fashionLooks: (params: FashionLookQuery = {}): Promise<{ items: FashionLookItem[] }> =>
    request(`/fashion/looks${toQuery(params as Record<string, unknown>)}`, {}, true),

  favorites: () => request("/favorites", {}, true),
  favoriteIds: () => request("/favorites/ids", {}, true),
  addFavorite: (product_id: string) =>
    request("/favorites", { method: "POST", body: JSON.stringify({ product_id }) }, true),
  removeFavorite: (product_id: string) =>
    request(`/favorites/${product_id}`, { method: "DELETE" }, true),
};
