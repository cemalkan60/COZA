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
  // D5: blur placeholder for the cover thumbnail only (not every photo —
  // see image_store.blurhash_for_url). Absent until the backfill sweep
  // reaches this collection.
  image_blurhash?: string | null;
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
  season?: string;
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
  q?: string;
  skip?: number;
};

export type Board = {
  id: string;
  name: string;
  parent_id: string | null;
  photo_count?: number;
  cover?: string | null;
  created_at?: string;
  updated_at?: string;
  archived?: boolean; // A3
  summary?: string; // A7, cached
  summary_lang?: string;
  public?: boolean; // F5
  share_token?: string; // F5
  smart_filter?: Record<string, string> | null; // A8
  shared?: boolean; // E1 — true if this board was shared WITH me (not mine)
  is_owner?: boolean; // E1
  shared_with?: string[]; // E1, owner view only
};

export type BoardComment = {
  id: string;
  board_id: string;
  board_name?: string; // only present on /notifications rows
  source_id: string | null;
  photo_index: number | null;
  user_id: string;
  user_name: string;
  text: string;
  mentions: string[];
  mentioned_you?: boolean; // only present on /notifications rows
  created_at: string;
};

export type SavedPhoto = {
  board_id: string;
  source_id: string;
  photo_index: number;
  image: string;
  image_thumb: string;
  brand_tr: string;
  season: string;
  season_label: string;
  url: string;
  added_at: string;
  note?: string; // A1
  custom_tags?: string[]; // A1
};

export type SavePhotoInput = {
  source_id: string;
  photo_index: number;
  image: string;
  image_thumb?: string;
  brand_tr?: string;
  season?: string;
  season_label?: string;
  url?: string;
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
      source?: string;
      brand?: string;
      sort?: "newest" | "oldest" | "updated";
      q?: string;
      skip?: number;
      limit?: number;
    } = {},
  ) => request(`/fashion/collections${toQuery(params as Record<string, unknown>)}`, {}, true),
  fashionSimilar: (
    sourceId: string,
  ): Promise<{ items: { source_id: string; brand_tr: string; season: string; season_label: string; image: string | null }[] }> =>
    request(`/fashion/collections/${encodeURIComponent(sourceId)}/similar`, {}, true),
  // C5: the next/previous collection in main-feed order, for swiping past
  // a collection's last (or before its first) photo into the next one.
  fashionAdjacentCollection: (
    sourceId: string,
    direction: "next" | "prev",
  ): Promise<{ item: { source_id: string; brand_tr: string; season: string } | null }> =>
    request(`/fashion/collections/${encodeURIComponent(sourceId)}/adjacent${toQuery({ direction })}`, {}, true),
  // Not auth-gated on the backend (same public data brand/[id].tsx already
  // fetches directly) — used for the "more from this show" strip (C4).
  fashionCollectionDetail: (
    sourceId: string,
  ): Promise<{ images: string[]; images_thumb: string[]; tagged_count?: number; taggable_count?: number }> =>
    request(`/fashion/collections/${encodeURIComponent(sourceId)}`),
  // B1: "Bu görünümü anlat" — one-sentence AI description, cached per
  // (photo, language) on the backend so re-opening never re-calls Gemini.
  fashionDescribePhoto: (
    sourceId: string,
    index: number,
    lang: string,
  ): Promise<{ description: string; cached: boolean }> =>
    request(
      `/fashion/collections/${encodeURIComponent(sourceId)}/describe?index=${index}&lang=${encodeURIComponent(lang)}`,
      { method: "POST" },
      true,
    ),
  // B2: trend-summary sentence — top item/color/material/pattern words
  // tagged across a season's collections (counts only, no Gemini call).
  fashionTrends: (
    season: string,
  ): Promise<{
    season: string;
    collections: number;
    top_item: { value: string; label_tr: string; count: number }[];
    top_color: { value: string; label_tr: string; count: number }[];
    top_material: { value: string; label_tr: string; count: number }[];
    top_pattern: { value: string; label_tr: string; count: number }[];
  }> => request(`/fashion/trends?season=${encodeURIComponent(season)}`, {}, true),
  fashionAnalytics: () => request("/fashion/analytics", {}, true),
  fashionMeta: () => request("/fashion/meta", {}, true),
  fashionLookFilters: (): Promise<FashionLookFilters> => request("/fashion/looks/filters", {}, true),
  fashionLooks: (params: FashionLookQuery = {}): Promise<{ items: FashionLookItem[] }> =>
    request(`/fashion/looks${toQuery(params as Record<string, unknown>)}`, {}, true),
  // B4: "şuna benzeyenleri bul" — tag-based (item/color/material/pattern
  // overlap), not true image-embedding similarity — see server.py's note.
  fashionLookSimilar: (lookId: string): Promise<{ items: FashionLookItem[] }> =>
    request(`/fashion/looks/${encodeURIComponent(lookId)}/similar`, {}, true),

  // ---- COZA Lens boards (saved photos in nested folders) ----
  boardsList: (): Promise<{ boards: Board[] }> => request("/fashion/boards", {}, true),
  boardCreate: (name: string, parent_id?: string | null, smart_filter?: Record<string, string> | null): Promise<Board> =>
    request("/fashion/boards", { method: "POST", body: JSON.stringify({ name, parent_id: parent_id ?? null, smart_filter: smart_filter ?? null }) }, true),
  boardUpdate: (id: string, patch: { name?: string; parent_id?: string | null }) =>
    request(`/fashion/boards/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }, true),
  // A8: re-run the board's saved filter, save any newly-matching photo.
  boardSmartRefresh: (id: string): Promise<{ status: string; added: number }> =>
    request(`/fashion/boards/${encodeURIComponent(id)}/smart-refresh`, { method: "POST" }, true),
  boardDelete: (id: string) =>
    request(`/fashion/boards/${encodeURIComponent(id)}`, { method: "DELETE" }, true),
  boardPhotos: (id: string, skip = 0): Promise<{ items: SavedPhoto[] }> =>
    request(`/fashion/boards/${encodeURIComponent(id)}/photos${toQuery({ skip })}`, {}, true),
  savePhoto: (boardId: string, photo: SavePhotoInput) =>
    request(`/fashion/boards/${encodeURIComponent(boardId)}/photos`, { method: "POST", body: JSON.stringify(photo) }, true),
  unsavePhoto: (boardId: string, sourceId: string, photoIndex: number) =>
    request(
      `/fashion/boards/${encodeURIComponent(boardId)}/photos/${encodeURIComponent(sourceId)}/${photoIndex}`,
      { method: "DELETE" },
      true,
    ),
  savedKeys: (): Promise<{ saved: Record<string, string[]> }> => request("/fashion/saved-keys", {}, true),
  // A1: personal note + custom tags on a saved photo (the user's own, not the AI's).
  updateSavedPhotoNote: (boardId: string, sourceId: string, photoIndex: number, patch: { note?: string; tags?: string[] }) =>
    request(
      `/fashion/boards/${encodeURIComponent(boardId)}/photos/${encodeURIComponent(sourceId)}/${photoIndex}`,
      { method: "PATCH", body: JSON.stringify(patch) },
      true,
    ),
  // A3: copy / archive a board.
  boardDuplicate: (boardId: string): Promise<{ id: string; status: string; photos_copied: number }> =>
    request(`/fashion/boards/${encodeURIComponent(boardId)}/duplicate`, { method: "POST" }, true),
  boardArchive: (boardId: string, archived: boolean) =>
    request(`/fashion/boards/${encodeURIComponent(boardId)}/archive${toQuery({ archived })}`, { method: "POST" }, true),
  // F5: public, view-only link. Not auth-gated on the read side by design.
  boardShare: (boardId: string): Promise<{ status: string; token: string }> =>
    request(`/fashion/boards/${encodeURIComponent(boardId)}/share`, { method: "POST" }, true),
  boardUnshare: (boardId: string) =>
    request(`/fashion/boards/${encodeURIComponent(boardId)}/unshare`, { method: "POST" }, true),
  publicBoard: (token: string): Promise<{ name: string; photos: SavedPhoto[] }> =>
    request(`/public/boards/${encodeURIComponent(token)}`),
  // E1: the other 4 team members (invite picker, @mention autocomplete).
  fashionTeam: (): Promise<{ items: { id: string; name: string }[] }> => request("/fashion/team", {}, true),
  boardInvite: (boardId: string, userId: string) =>
    request(`/fashion/boards/${encodeURIComponent(boardId)}/invite`, { method: "POST", body: JSON.stringify({ user_id: userId }) }, true),
  boardUninvite: (boardId: string, userId: string) =>
    request(`/fashion/boards/${encodeURIComponent(boardId)}/uninvite`, { method: "POST", body: JSON.stringify({ user_id: userId }) }, true),
  // E2/E3: board (or per-photo) comments, @mentions parsed server-side.
  boardComments: (boardId: string): Promise<{ items: BoardComment[] }> =>
    request(`/fashion/boards/${encodeURIComponent(boardId)}/comments`, {}, true),
  addComment: (boardId: string, text: string, sourceId?: string, photoIndex?: number): Promise<BoardComment> =>
    request(
      `/fashion/boards/${encodeURIComponent(boardId)}/comments`,
      { method: "POST", body: JSON.stringify({ text, source_id: sourceId ?? null, photo_index: photoIndex ?? null }) },
      true,
    ),
  deleteComment: (boardId: string, commentId: string) =>
    request(`/fashion/boards/${encodeURIComponent(boardId)}/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" }, true),
  // E4: one emoji per (user, photo) — posting the same one again clears it.
  toggleReaction: (boardId: string, sourceId: string, photoIndex: number, emoji: string): Promise<{ emoji: string | null }> =>
    request(
      `/fashion/boards/${encodeURIComponent(boardId)}/react`,
      { method: "POST", body: JSON.stringify({ source_id: sourceId, photo_index: photoIndex, emoji }) },
      true,
    ),
  boardReactions: (boardId: string): Promise<{ items: { source_id: string; photo_index: number; user_id: string; emoji: string }[] }> =>
    request(`/fashion/boards/${encodeURIComponent(boardId)}/reactions`, {}, true),
  // E5: "Bana gönderilenler".
  notifications: (): Promise<{ items: BoardComment[]; unread: number }> => request("/notifications", {}, true),
  markNotificationsSeen: () => request("/notifications/seen", { method: "POST" }, true),
  // A7: AI moodboard-direction paragraph, cached on the board.
  boardSummarize: (boardId: string, lang: string, force = false): Promise<{ summary: string; cached: boolean }> =>
    request(`/fashion/boards/${encodeURIComponent(boardId)}/summarize${toQuery({ lang, force })}`, { method: "POST" }, true),
  // B3: free sentence -> Lens filter values (Gemini), applied by the caller.
  fashionParseQuery: (text: string): Promise<{ filters: Record<string, string> }> =>
    request("/fashion/looks/parse-query", { method: "POST", body: JSON.stringify({ text }) }, true),
  // C1: A-Z brand index.
  fashionBrands: (): Promise<{ items: { name: string; count: number; cover: string | null }[] }> =>
    request("/fashion/brands", {}, true),
  // C2/C3: retrospective fashion-week index (city+season pairs that
  // actually happened) — NOT a forward calendar/countdown, see server.py.
  fashionWeeks: (): Promise<{
    items: { city: string; season: string; season_label: string; count: number; cover: string | null }[];
  }> => request("/fashion/fashion-weeks", {}, true),
  // G2: "bu kapak/marka yanlış" -> admin queue.
  fashionReportCollection: (sourceId: string, reason: string, note = "") =>
    request(
      `/fashion/collections/${encodeURIComponent(sourceId)}/report`,
      { method: "POST", body: JSON.stringify({ reason, note }) },
      true,
    ),
  // A5: "dışarıdan görsel ekle" — link path works everywhere; web also gets
  // an actual file picker (addUserPhotoUpload), native doesn't have one
  // installed (no expo-image-picker in this project — see COZA-YOL-
  // HARITASI.md notes) so it's link-only there.
  addUserPhotoByUrl: (url: string): Promise<{ source_id: string; tagged: boolean }> =>
    request("/fashion/user-photos", { method: "POST", body: JSON.stringify({ image_url: url }) }, true),
  addUserPhotoUpload: async (file: File): Promise<{ source_id: string; tagged: boolean }> => {
    const form = new FormData();
    form.append("file", file);
    const token = await storage.secureGet<string>(TOKEN_KEY, "");
    const res = await fetch(`${BASE}/fashion/user-photos/upload`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form, // NOT JSON.stringify — browser sets the multipart Content-Type (with boundary) itself
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.detail || `Bir hata oluştu (${res.status})`);
    return data;
  },
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
  // Delete collections older than the rolling recent-months window.
  fashionPruneOld: () => request("/admin/fashion-prune", { method: "POST" }, true),
  // Delete the collections no automatic sweep can repair: undated ones
  // (season never parsed) and non-fashion-press ones stuck at <= 1 photo.
  // See run_fashion_clean_cruft in server.py.
  fashionCleanCruft: () => request("/admin/fashion-clean-cruft", { method: "POST" }, true),
  // Rewrite cached photo URLs to the bucket that actually holds them now
  // (fixes 404s after the R2 bucket count changed). No re-download.
  fashionRepairUrls: () => request("/admin/fashion-repair-urls", { method: "POST" }, true),
  // Drop photo entries that 404 on every R2 bucket from every collection
  // (ghosts left after the buckets were emptied by hand). Keeps images /
  // images_thumb / image_tags aligned; never deletes from R2 or touches
  // source-site URLs. See run_fashion_drop_dead_images in server.py.
  fashionDropDeadImages: () => request("/admin/fashion-drop-dead-images", { method: "POST" }, true),
  // One-time (safe to re-run) sweep: rewrite any stored photo URL still on
  // a bare pub-<hash>.r2.dev address to the current R2_PUBLIC_BASE_URL
  // (a Custom Domain) — a hostname swap only, the object never moved.
  // See run_fashion_migrate_image_domain in server.py.
  fashionMigrateImageDomain: () => request("/admin/fashion-migrate-image-domain", { method: "POST" }, true),
  // Copies every photo from the 2 secondary R2 accounts (added back when
  // storage needed to spread across several accounts' free 10GB tiers)
  // into the primary one, now that it's on a paid plan. Run alongside
  // fashionMigrateImageDomain — that one only fixes which domain a URL
  // points to, this makes sure the object is actually there.
  fashionConsolidateR2: () => request("/admin/fashion-consolidate-r2", { method: "POST" }, true),
  // Diagnostic: probes every (key, model) slot the tagging rotation uses.
  geminiCheck: (): Promise<{
    enabled: boolean;
    key_count: number;
    models: string[];
    slot_count: number;
    slots_ok: number;
    keys: {
      index: number; tail: string; ok: boolean; quota_exhausted: boolean;
      models_ok: number; models_total: number; detail: string;
    }[];
    slots: { key_index: number; key_tail: string; model: string; ok: boolean; quota_exhausted: boolean; detail: string }[];
    // Bottom line: can tagging actually run right now? Same logic as the
    // Settings tag button's tag_state (see _tagging_readiness in server.py).
    verdict?: { can_run: boolean; label: string; untagged?: number };
  }> => request("/admin/gemini-check", {}, true),
  // Probe candidate Gemini models — each working one is another free-tier
  // daily quota bucket to add to GEMINI_MODELS. See discover_models.
  geminiModels: (): Promise<{
    configured: string[];
    candidates: { model: string; ok: boolean; quota_exhausted: boolean; configured: boolean; detail: string }[];
    suggested_env: string;
  }> => request("/admin/gemini-models", {}, true),
  // Everything the admin dashboard renders, in one call. Admin-only (403 for viewers).
  adminDashboard: (): Promise<AdminDashboard> => request("/admin/dashboard", {}, true),
  // D5: cover-photo blur-placeholder backfill sweep.
  fashionFixBlurhash: () => request("/admin/fashion-fix-blurhash", { method: "POST" }, true),
  // G2: the report queue.
  adminFashionReports: (status = "open"): Promise<{ items: FashionReport[] }> =>
    request(`/admin/fashion-reports${toQuery({ status })}`, {}, true),
  adminResolveFashionReport: (id: string) =>
    request(`/admin/fashion-reports/${encodeURIComponent(id)}/resolve`, { method: "POST" }, true),
  // G3: fashion-press.net-only on-demand re-fetch.
  adminRefetchCollection: (sourceId: string): Promise<{ status: string; photo_count?: number; detail?: string }> =>
    request(`/admin/fashion-collections/${encodeURIComponent(sourceId)}/refetch`, { method: "POST" }, true),
  // G5/G6: brand merge tools.
  adminFashionBrands: (q?: string): Promise<{ items: { name: string; count: number }[] }> =>
    request(`/admin/fashion-brands${toQuery({ q })}`, {}, true),
  adminMergeBrands: (fromNames: string[], toName: string): Promise<{ status: string; renamed: number }> =>
    request("/admin/fashion-brands/merge", { method: "POST", body: JSON.stringify({ from_names: fromNames, to_name: toName }) }, true),
  adminSuggestBrandMerges: (): Promise<{ suggestions: { canonical: string; variants: string[] }[] }> =>
    request("/admin/fashion-brands/suggest-merges", { method: "POST" }, true),
  // H1/H2: usage counters (NOT real billing) + per-user last-active.
  adminUsage: (): Promise<AdminUsage> => request("/admin/usage", {}, true),
};

export type FashionReport = {
  id: string;
  source_id: string;
  brand_tr: string;
  season_label: string;
  user_name: string;
  reason: string;
  note: string;
  status: "open" | "resolved";
  created_at: string;
};

export type AdminUsage = {
  month: string;
  gemini_calls_this_month: number;
  gemini_photos_tagged_this_month: number;
  r2_photos_cached: number;
  collections: number;
  users: { name: string; email: string; role: string; last_active: string | null }[];
};

type LabelCount = { label: string; count: number };
export type JobRun = {
  job: string;
  label: string;
  status: "ok" | "partial" | "error";
  detail: string;
  reason: string;
  done: number | null;
  total: number | null;
  pct: number | null;
  started_at: string | null;
  finished_at: string;
};
export type AdminDashboard = {
  generated_at: string;
  collections: {
    total: number;
    by_source: LabelCount[];
    by_season: LabelCount[];
    by_category: LabelCount[];
    by_city: LabelCount[];
  };
  photos: {
    photos: number;
    tagged: number;
    taggable: number;
    cap_per_collection: number;
    by_source: { label: string; photos: number; tagged: number; taggable: number }[];
  };
  health: {
    single_photo?: number;
    missing_thumbs?: number;
    untagged?: number;
    fp_thin_cover?: number;
    older_than_window?: number;
    undated?: number;
  };
  window: { recent_months: number; last_prune: string | null };
  tagging: { running: boolean; phase: string | null; run_done: number; run_total: number };
  job_runs: JobRun[];
  scrape: {
    fashion_last: string | null;
    fashion_running: boolean;
    fashion_phase: string | null;
    catalog_last: string | null;
    scheduled_jobs: { id: string; next_run: string | null }[];
    progress?: {
      sources_done: number; sources_total: number;
      groups_done: number; groups_total: number;
      covers_done: number; covers_total: number;
      thumbs_done: number; thumbs_total: number;
      merge_done: number; merge_total: number;
      repair_done?: number; repair_total?: number;
    };
  };
  gemini: { enabled: boolean; key_count: number; models: string[]; batch: number };
  users: { email?: string; name?: string; role?: string }[];
  system: {
    db_name: string;
    sources?: {
      active: string[];
      disabled: { name: string; reason: string }[];
      yield_baseline?: Record<string, { ewma: number; samples: number }>;
    };
    r2?: {
      enabled: boolean; buckets: number; hosts: string[]; fullres_max_px: number | null;
      cors?: { index: number; bucket: string; host: string; ok: boolean; detail: string }[];
    };
    counts: Record<string, number>;
  };
};
