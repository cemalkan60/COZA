import { storage } from "@/src/utils/storage";

// EXPO_PUBLIC_* env vars are baked into the JS bundle at BUILD time, not read
// at runtime — so if a particular EAS build profile/environment doesn't have
// EXPO_PUBLIC_BACKEND_URL configured on Expo's side when the build runs, this
// silently comes back as `undefined` in that build forever (rebuilding the
// backend or the app later doesn't fix it — only rebuilding the app WITH the
// variable set does). That turned BASE into the literal string
// "undefined/api", so every request — including login — failed instantly
// with "Network request failed" and no more specific error, which was hard
// to tell apart from an actual connectivity problem. Falling back to our own
// production backend here means a build missing that variable still works,
// instead of shipping unusable until someone notices and fixes the Expo
// project's environment variables and rebuilds.
const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || "https://coza-production.up.railway.app";
const BASE = `${BACKEND_URL}/api`;
export const TOKEN_KEY = "coza.auth.token";

// ---- COZA Fashion (runway collections aggregated from multiple sources) ----
export type FashionItem = {
  source_id: string;
  url: string;
  image: string | null;
  images?: string[];
  title_ja?: string;
  title_tr: string;
  brand_tr: string;
  season: string;
  season_label: string;
  category?: "women" | "men" | "haute-couture" | string;
  city?: string | null;
  sources?: string[];
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

  fashionCollections: (
    params: {
      season?: string;
      category?: string;
      city?: string;
      q?: string;
      skip?: number;
      limit?: number;
    } = {},
  ) => request(`/fashion/collections${toQuery(params as Record<string, unknown>)}`, {}, true),
  fashionAnalytics: () => request("/fashion/analytics", {}, true),
  fashionMeta: () => request("/fashion/meta", {}, true),
  fashionLookFilters: (): Promise<FashionLookFilters> => request("/fashion/looks/filters", {}, true),
  fashionLooks: (params: FashionLookQuery = {}): Promise<{ items: FashionLookItem[] }> =>
    request(`/fashion/looks${toQuery(params as Record<string, unknown>)}`, {}, true),
  fashionScrape: () => request("/admin/fashion-scrape", { method: "POST" }, true),
  // One-off full historical pull (everything since Jan 2026, not just each
  // source's latest page) — much slower than fashionScrape, see its comment
  // in server.py. Separate button in Settings, not part of the schedule.
  fashionBackfill: () => request("/admin/fashion-backfill", { method: "POST" }, true),
};
