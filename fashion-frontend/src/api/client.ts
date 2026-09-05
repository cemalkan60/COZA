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
  // Small resized copies of `image`/`images`, for grid/list display — much
  // faster to load than the full-resolution originals. Falls back to the
  // full-resolution field wherever a thumbnail hasn't been generated yet
  // (an older doc, or the backfill sweep hasn't reached it) — see callers
  // of these fields for the fallback.
  image_thumb?: string | null;
  images_thumb?: string[];
  // Per-photo AI tags (garment/color/pattern/material), same index order as
  // `images` — see gemini_client.tag_image / run_fashion_tag_firstview.
  // Filled in gradually by the tagging sweep (FirstView first), so this can
  // be shorter than `images` or absent entirely on a doc that hasn't been
  // reached yet.
  image_tags?: { item: string; color: string; pattern: string; material: string }[];
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
  // Unfiltered option lists for the feed's city/season filter pickers —
  // always the full set, regardless of any filter currently applied.
  cities: string[];
  season_options: { code: string; label: string }[];
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
  // One-off sweep that gives every fashion-press collection a real cover
  // photo (instead of the low-res listing-page thumbnail) by fetching its
  // gallery early instead of waiting for someone to open it. See
  // run_fashion_cover_fix in server.py.
  fashionFixCovers: () => request("/admin/fashion-fix-covers", { method: "POST" }, true),
  // One-off sweep that merges collections saved twice under different keys
  // because fashion-press and firstview spelled the same season
  // differently, and deletes the now-redundant duplicate photo from R2.
  // See run_fashion_merge_duplicates in server.py.
  fashionMergeDuplicates: () => request("/admin/fashion-merge-duplicates", { method: "POST" }, true),
  // One-off sweep that generates a small grid/list thumbnail for every
  // collection that only has full-resolution photos cached (saved before
  // thumbnails existed) — never re-hits fashion-press.net/firstview.com,
  // only re-reads photos already on our own R2 bucket. See
  // run_fashion_thumbnails_backfill in server.py.
  fashionFixThumbnails: () => request("/admin/fashion-fix-thumbnails", { method: "POST" }, true),
  fashionTagFirstview: () => request("/admin/fashion-tag-firstview", { method: "POST" }, true),
};
