// frontend/app/fashion.tsx
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { api, FashionItem, FashionAnalytics, SavePhotoInput } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useT } from "@/src/i18n";
import { formatDate } from "@/src/utils/format";
import { resolveBestImage, fashionImageUri } from "@/src/utils/fashionImage";
import RetryImage from "@/src/components/RetryImage";
import { SaveToBoardSheet } from "@/src/components/SaveToBoardSheet";
import { useGridColumns } from "@/src/hooks/useGridColumns";
import { useContentWidth } from "@/src/hooks/useContentWidth";
import { getLastCollection, getRecentCollections, LastCollection } from "@/src/utils/lastCollection";

const CATEGORY_VALUES = ["women", "men", "haute-couture"] as const;

export default function Fashion() {
  const { colors, spacing } = useTheme();
  const { t, formatSeason, optLabel, lang } = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width } = useContentWidth();
  const { cols, cycle: cycleCols } = useGridColumns();
  // Bug found in QA: at low column counts (2/3), the old percentage width
  // ("${100/cols}%") plus styles.grid's own `gap` overflowed the row by
  // one gap's worth, so the last card on a row wrapped early and left a
  // big empty gap. Pixel math (same pattern every other grid in the app
  // already uses — boards.tsx, brand/[id].tsx, search.tsx) accounts for
  // the gaps up front instead of layering a flex gap on top of percentages.
  const gridGap = 12;
  const gridPad = spacing.xl - 4;
  const cardW = (width - gridPad * 2 - gridGap * (cols - 1)) / cols;
  const [lastCollection, setLastCollection] = useState<LastCollection | null>(null);
  const [recentCollections, setRecentCollections] = useState<LastCollection[]>([]); // D6
  const [unread, setUnread] = useState(0); // E5
  const [menuOpen, setMenuOpen] = useState(false);
  useFocusEffect(
    useCallback(() => {
      getLastCollection().then(setLastCollection);
      getRecentCollections().then(setRecentCollections);
      api.notifications().then((r) => setUnread(r.unread || 0)).catch(() => {});
    }, []),
  );

  const [items, setItems] = useState<FashionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [analytics, setAnalytics] = useState<FashionAnalytics | null>(null);
  const [season, setSeason] = useState<string | undefined>(undefined);
  // B2: "trend özeti metni" — a season's top item/color/material words,
  // computed from already-tagged photos (no Gemini call).
  const [trends, setTrends] = useState<Awaited<ReturnType<typeof api.fashionTrends>> | null>(null);
  useEffect(() => {
    if (!season) {
      setTrends(null);
      return;
    }
    let cancelled = false;
    api
      .fashionTrends(season)
      .then((r) => {
        if (!cancelled) setTrends(r);
      })
      .catch(() => {
        if (!cancelled) setTrends(null);
      });
    return () => {
      cancelled = true;
    };
  }, [season]);

  // TR uses the backend's Turkish label directly; EN/ES try the Lens
  // filter-option translation table (built for a different, overlapping
  // vocabulary — best-effort) and fall back to a title-cased English word.
  const trendLabel = (facet: string, entry?: { value: string; label_tr: string }) => {
    if (!entry) return "";
    if (lang === "tr") return entry.label_tr;
    const titleCased = entry.value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return optLabel(facet, entry.value, titleCased);
  };
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [city, setCity] = useState<string | undefined>(undefined);
  const [source, setSource] = useState<string | undefined>(undefined);
  const [sort, setSort] = useState<"newest" | "oldest" | "updated">("newest");
  const [q, setQ] = useState("");
  const [qActive, setQActive] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // A failed request must not look like "no content" — track it separately
  // so the empty state can tell the user it's a connection problem and offer
  // a retry, instead of the misleading "content updates daily at 07:00".
  const [error, setError] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [openModal, setOpenModal] = useState<"city" | "season" | "source" | "sort" | null>(null);
  const [savedKeys, setSavedKeys] = useState<Record<string, string[]>>({});
  const [saveTarget, setSaveTarget] = useState<SavePhotoInput | null>(null);
  const refreshSaved = useCallback(() => {
    api.savedKeys().then((r) => setSavedKeys(r.saved || {})).catch(() => {});
  }, []);
  useEffect(() => { refreshSaved(); }, [refreshSaved]);

  const PAGE_SIZE = 40;

  // debounce the text box -> qActive (what actually gets queried)
  useEffect(() => {
    const t = setTimeout(() => setQActive(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      try {
        const [feed, stats] = await Promise.all([
          api.fashionCollections({ season, category, city, source, sort, q: qActive || undefined, limit: PAGE_SIZE }),
          api.fashionAnalytics(),
        ]);
        setItems(feed.items || []);
        setTotal(feed.total ?? (feed.items || []).length);
        setAnalytics(stats);
        setError(false);
      } catch {
        // Keep whatever's already on screen; just flag the failure so the
        // empty state can show "connection problem / retry" not "no content".
        setError(true);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [season, category, city, source, sort, qActive],
  );

  const loadMore = useCallback(async () => {
    if (loadingMore || items.length >= total) return;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const feed = await api.fashionCollections({
        season,
        category,
        city,
        source,
        sort,
        q: qActive || undefined,
        skip: items.length,
        limit: PAGE_SIZE,
      });
      setItems((cur) => [...cur, ...(feed.items || [])]);
      setTotal(feed.total ?? total);
    } catch {
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [season, category, city, source, sort, qActive, items.length, total, loadingMore]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // Unfiltered option lists straight from the backend (see fashion_analytics
  // in server.py) rather than derived from the currently-loaded `items` —
  // deriving from items meant picking a city silently emptied every other
  // city out of its own picker, since the feed was already filtered to just
  // that city by the time the list was rebuilt.
  const seasonChips = analytics?.season_options || [];
  const cityChips = analytics?.cities || [];

  const SORT_OPTS = [
    { value: "newest", label: t("feed.sortNewest") },
    { value: "oldest", label: t("feed.sortOldest") },
    { value: "updated", label: t("feed.sortUpdated") },
  ];
  const SOURCE_OPTS = [
    { value: "", label: t("feed.allSources") },
    { value: "firstview", label: "FirstView" },
    { value: "fashion-press", label: "fashion-press" },
  ];
  const sortLabel = SORT_OPTS.find((o) => o.value === sort)?.label || t("feed.sort");
  const sourceLabel = source ? SOURCE_OPTS.find((o) => o.value === source)?.label : undefined;

  // show all items (no 6-limit)
  const slots = items;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Header — a single row. This used to be 6 individual icon buttons
          (grown one at a time as features were added) squeezed beside the
          title, which briefly needed a two-row split just to keep the
          title from wrapping letter-by-letter on a real phone. One
          hamburger button both fixes that for good (nothing new here ever
          crowds the title again) and — per Cem — makes the options
          actually readable instead of a row of bare icons. */}
      <View
        style={[
          styles.header,
          { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: insets.top + 8, paddingHorizontal: spacing.xl, borderBottomColor: colors.divider },
        ]}
      >
        <Text numberOfLines={1} style={[styles.brandLine, { color: colors.onSurface, flex: 1 }]}>
          COZA <Text style={{ color: colors.brandSecondary }}>{t("feed.title")}</Text>
        </Text>
        <Pressable
          testID="fashion-open-menu"
          onPress={() => {
            Haptics.selectionAsync();
            setMenuOpen(true);
          }}
          style={[styles.searchBtn, { borderColor: colors.border, backgroundColor: colors.surfaceSecondary }]}
          hitSlop={8}
        >
          <Feather name="menu" size={18} color={colors.onSurface} />
          {unread > 0 && <View style={styles.unreadDot} />}
        </Pressable>
      </View>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuOverlay} onPress={() => setMenuOpen(false)}>
          <View style={[styles.menu, { backgroundColor: colors.surface, borderColor: colors.border, marginTop: insets.top + 56, marginRight: spacing.xl, alignSelf: "flex-end" }]}>
            {[
              { testID: "fashion-open-boards", icon: "bookmark", label: t("feed.menuBoards"), href: "/fashion/boards", badge: 0 },
              { testID: "fashion-open-search", icon: "search", label: t("feed.menuSearch"), href: "/fashion/search", badge: 0 },
              { testID: "fashion-open-brands", icon: "list", label: t("feed.menuBrands"), href: "/fashion/brands", badge: 0 },
              { testID: "fashion-open-weeks", icon: "calendar", label: t("feed.menuWeeks"), href: "/fashion/weeks", badge: 0 },
              { testID: "fashion-open-inbox", icon: "bell", label: t("feed.menuInbox"), href: "/fashion/inbox", badge: unread },
              { testID: "fashion-open-settings", icon: "settings", label: t("feed.menuSettings"), href: "/settings", badge: 0 },
            ].map((item) => (
              <Pressable
                key={item.href}
                testID={item.testID}
                style={styles.menuItem}
                onPress={() => {
                  setMenuOpen(false);
                  router.push(item.href as any);
                }}
              >
                <Feather name={item.icon as any} size={17} color={colors.onSurface} />
                <Text style={{ color: colors.onSurface, fontWeight: "600", marginLeft: 12, flex: 1 }}>{item.label}</Text>
                {!!item.badge && (
                  <View style={styles.menuBadge}>
                    <Text style={{ color: "#fff", fontSize: 10, fontWeight: "800" }}>{item.badge > 9 ? "9+" : item.badge}</Text>
                  </View>
                )}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      {/* Serbest metin arama */}
      <View style={[styles.searchWrap, { paddingHorizontal: spacing.xl, borderBottomColor: colors.divider }]}>
        <View style={[styles.searchBar, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}>
          <Feather name="search" size={16} color={colors.brandSecondary} />
          <TextInput
            testID="fashion-search-input"
            value={q}
            onChangeText={setQ}
            placeholder={t("feed.searchPlaceholder")}
            placeholderTextColor={colors.brandSecondary}
            style={{ flex: 1, color: colors.onSurface, fontSize: 14, paddingVertical: 8 }}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {!!q && (
            <Pressable onPress={() => setQ("")} hitSlop={8}>
              <Feather name="x" size={16} color={colors.brandSecondary} />
            </Pressable>
          )}
        </View>
      </View>

      {lastCollection && (
        <Pressable
          testID="fashion-resume"
          onPress={() =>
            router.push(
              `/fashion/brand/${encodeURIComponent(lastCollection.source_id)}?title=${encodeURIComponent(lastCollection.title)}&season=${encodeURIComponent(lastCollection.season)}`,
            )
          }
          style={[styles.resumeCard, { borderColor: colors.border, backgroundColor: colors.surfaceSecondary, marginHorizontal: spacing.xl }]}
        >
          <View style={[styles.resumeThumbWrap, { backgroundColor: colors.surfaceTertiary }]}>
            {lastCollection.image ? (
              <RetryImage uri={fashionImageUri(lastCollection.image)} style={styles.image} contentFit="cover" transition={180} />
            ) : null}
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{ color: colors.brandSecondary, fontSize: 11, fontWeight: "700" }}>{t("feed.resume")}</Text>
            <Text numberOfLines={1} style={{ color: colors.onSurface, fontWeight: "700", fontSize: 14, marginTop: 2 }}>
              {lastCollection.title}
              {lastCollection.season ? (
                <Text style={{ color: colors.brandSecondary, fontWeight: "600" }}> ({formatSeason(lastCollection.season, lastCollection.season)})</Text>
              ) : null}
            </Text>
          </View>
          <Feather name="chevron-right" size={18} color={colors.brandSecondary} />
        </Pressable>
      )}

      {recentCollections.length > 1 && (
        <View style={{ marginTop: 10 }}>
          <Text style={{ color: colors.brandSecondary, fontSize: 11, fontWeight: "700", marginHorizontal: spacing.xl, marginBottom: 8 }}>
            {t("feed.recentlyViewed")}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.xl, gap: 10 }}>
            {recentCollections.slice(1).map((c) => (
              <Pressable
                key={c.source_id}
                testID={`fashion-recent-${c.source_id}`}
                onPress={() =>
                  router.push(
                    `/fashion/brand/${encodeURIComponent(c.source_id)}?title=${encodeURIComponent(c.title)}&season=${encodeURIComponent(c.season)}`,
                  )
                }
                style={{ width: 72 }}
              >
                <View style={{ width: 72, height: 96, borderRadius: 4, overflow: "hidden", backgroundColor: colors.surfaceTertiary }}>
                  {c.image ? (
                    <RetryImage uri={fashionImageUri(c.image)} style={styles.image} contentFit="cover" />
                  ) : null}
                </View>
                <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 10, fontWeight: "600", marginTop: 4 }}>
                  {c.title}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.brand} />}
        >
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.xl, gap: 8, paddingVertical: 14 }}>
            <Chip label={t("common.all")} active={!category} onPress={() => setCategory(undefined)} colors={colors} />
            {CATEGORY_VALUES.map((c) => (
              <Chip
                key={c}
                label={t(`category.${c}`)}
                active={category === c}
                onPress={() => setCategory((cur) => (cur === c ? undefined : c))}
                colors={colors}
              />
            ))}
          </ScrollView>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ flexDirection: "row", paddingHorizontal: spacing.xl, gap: 8, paddingBottom: 14 }}
          >
            <FilterPill
              testID="fashion-filter-sort"
              label={sortLabel}
              value={sortLabel}
              active={sort !== "newest"}
              onPress={() => setOpenModal("sort")}
              colors={colors}
            />
            <FilterPill
              testID="fashion-filter-source"
              label={t("feed.source")}
              value={sourceLabel}
              active={!!source}
              onPress={() => setOpenModal("source")}
              colors={colors}
            />
            {seasonChips.length > 0 && (
              <FilterPill
                testID="fashion-filter-season"
                label={t("feed.seasonFilter")}
                value={season ? formatSeason(season, seasonChips.find((s) => s.code === season)?.label) : undefined}
                active={!!season}
                onPress={() => setOpenModal("season")}
                colors={colors}
              />
            )}
            {cityChips.length > 0 && (
              <FilterPill
                testID="fashion-filter-city"
                label={t("feed.city")}
                value={city}
                active={!!city}
                onPress={() => setOpenModal("city")}
                colors={colors}
              />
            )}
            <Pressable
              testID="fashion-grid-cols"
              onPress={() => {
                Haptics.selectionAsync();
                cycleCols();
              }}
              style={[styles.filterBtn, { borderColor: colors.border, backgroundColor: colors.surfaceSecondary }]}
            >
              <Feather name="grid" size={13} color={colors.brandSecondary} />
              <Text style={{ color: colors.onSurface, fontSize: 12, fontWeight: "700" }}>{cols}</Text>
            </Pressable>
          </ScrollView>

          {trends && trends.collections > 0 && trends.top_item[0] && trends.top_color[0] && trends.top_material[0] && (
            <View style={[styles.trendCard, { borderColor: colors.border, backgroundColor: colors.surfaceSecondary, marginHorizontal: spacing.xl }]}>
              <Feather name="trending-up" size={14} color={colors.brand} style={{ marginTop: 1 }} />
              <Text style={{ flex: 1, color: colors.onSurface, fontSize: 13, lineHeight: 19 }}>
                {t("feed.trendSummary", {
                  season: formatSeason(season, season),
                  item: trendLabel("item", trends.top_item[0]),
                  color: trendLabel("color", trends.top_color[0]),
                  material: trendLabel("material", trends.top_material[0]),
                  count: trends.collections,
                })}
              </Text>
            </View>
          )}

          {items.length === 0 ? (
            <View style={{ paddingHorizontal: spacing.xl, marginTop: 40, alignItems: "center", gap: 14 }}>
              {error ? (
                <>
                  <Feather name="wifi-off" size={26} color={colors.brandSecondary} />
                  <Text style={{ color: colors.brandSecondary, textAlign: "center" }}>
                    {t("feed.loadError")}
                  </Text>
                  <Pressable
                    testID="fashion-retry"
                    onPress={() => {
                      setLoading(true);
                      load();
                    }}
                    style={[styles.loadMoreBtn, { borderColor: colors.border, paddingHorizontal: 28, alignSelf: "center" }]}
                  >
                    <Text style={{ color: colors.onSurface, fontWeight: "700" }}>{t("common.retry")}</Text>
                  </Pressable>
                </>
              ) : (
                <Text style={{ color: colors.brandSecondary, textAlign: "center" }}>{t("feed.empty")}</Text>
              )}
            </View>
          ) : (
            <View style={[styles.grid, { paddingHorizontal: spacing.xl - 4, gap: gridGap }]}>
              {slots.map((it, idx) => (
                <FashionCard
                  key={idx}
                  item={it}
                  colors={colors}
                  cardW={cardW}
                  saved={!!it && (savedKeys[`${it.source_id}#0`]?.length ?? 0) > 0}
                  onSave={() =>
                    it &&
                    setSaveTarget({
                      source_id: it.source_id,
                      photo_index: 0,
                      image: it.image || it.image_thumb || "",
                      image_thumb: it.image_thumb || it.image || "",
                      brand_tr: it.brand_tr || it.title_tr || "",
                      season: it.season || "",
                      season_label: it.season_label || "",
                    })
                  }
                />
              ))}
            </View>
          )}

          {items.length > 0 && items.length < total && (
            <Pressable
              testID="fashion-load-more"
              onPress={loadMore}
              disabled={loadingMore}
              style={[styles.loadMoreBtn, { borderColor: colors.border, marginHorizontal: spacing.xl, opacity: loadingMore ? 0.6 : 1 }]}
            >
              {loadingMore ? (
                <ActivityIndicator color={colors.onSurface} size="small" />
              ) : moreError ? (
                <Text style={{ color: colors.brandSecondary, fontWeight: "700" }}>{t("feed.loadMoreError")}</Text>
              ) : (
                <Text style={{ color: colors.onSurface, fontWeight: "700" }}>{t("common.loadMore")} ({items.length}/{total})</Text>
              )}
            </Pressable>
          )}

          {analytics?.last_scrape && (
            <View style={[styles.note, { backgroundColor: colors.surfaceSecondary, marginHorizontal: spacing.xl }]}>
              <Feather name="info" size={14} color={colors.brandSecondary} />
              <Text style={[styles.noteText, { color: colors.brandSecondary }]}>
                {t("feed.note", { date: formatDate(analytics.last_scrape) })}
              </Text>
            </View>
          )}
        </ScrollView>
      )}

      <FashionFilterModal
        visible={openModal !== null}
        onClose={() => setOpenModal(null)}
        title={
          openModal === "city" ? t("feed.city")
            : openModal === "season" ? t("feed.seasonFilter")
              : openModal === "source" ? t("feed.source")
                : t("feed.sort")
        }
        colors={colors}
        bottomInset={insets.bottom}
        options={
          openModal === "city"
            ? [{ value: "", label: t("feed.allCities") }, ...cityChips.map((c) => ({ value: c, label: c }))]
            : openModal === "season"
              ? [{ value: "", label: t("feed.allSeasons") }, ...seasonChips.map((s) => ({ value: s.code, label: formatSeason(s.code, s.label) }))]
              : openModal === "source"
                ? SOURCE_OPTS
                : SORT_OPTS
        }
        selected={
          openModal === "city" ? city || ""
            : openModal === "season" ? season || ""
              : openModal === "source" ? source || ""
                : sort
        }
        onSelect={(v) => {
          if (openModal === "city") setCity(v || undefined);
          else if (openModal === "season") setSeason(v || undefined);
          else if (openModal === "source") setSource(v || undefined);
          else if (openModal === "sort") setSort((v || "newest") as "newest" | "oldest" | "updated");
          setOpenModal(null);
        }}
      />

      <SaveToBoardSheet
        visible={!!saveTarget}
        onClose={() => setSaveTarget(null)}
        photo={saveTarget}
        savedBoardIds={saveTarget ? savedKeys[`${saveTarget.source_id}#${saveTarget.photo_index}`] || [] : []}
        onChange={refreshSaved}
      />
    </View>
  );
}

function FashionCard({
  item,
  colors,
  saved,
  onSave,
  cardW,
}: {
  item: FashionItem | null;
  colors: any;
  saved?: boolean;
  onSave?: () => void;
  cardW?: number;
}) {
  const router = useRouter();
  const { formatSeason } = useT();
  const saveScale = useRef(new Animated.Value(1)).current;
  const lastTapRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // D2: "ızgarada bas-göz at" — hold a tile to preview it bigger without
  // leaving the grid, release to dismiss (Pressable suppresses onPress for
  // a gesture that already fired onLongPress, so this never also navigates).
  const [peeking, setPeeking] = useState(false);

  const pulseSave = () => {
    saveScale.setValue(1);
    Animated.sequence([
      Animated.timing(saveScale, { toValue: 1.4, duration: 110, useNativeDriver: true }),
      Animated.spring(saveScale, { toValue: 1, useNativeDriver: true, friction: 4, tension: 60 }),
    ]).start();
  };

  const triggerSave = () => {
    if (!onSave) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    pulseSave();
    onSave();
  };

  useEffect(() => {
    return () => {
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    };
  }, []);
  // The grid only ever shows this card at a small fixed size, so it loads
  // the small resized copy (image_thumb) instead of the full-resolution
  // runway photo -- confirmed live as the main cause of slow/blank-looking
  // grids (downloading a 1-2MB original just to paint a ~180px tile). Full
  // resolution is still used once a collection is actually opened (see
  // app/fashion/brand/[id].tsx). Falls back to the full image for any
  // collection the thumbnail backfill hasn't reached yet.
  const gridImg = item?.image_thumb || item?.image;
  const [displayImg, setDisplayImg] = useState<string | undefined>(gridImg || undefined);

  useEffect(() => {
    let cancelled = false;
    setDisplayImg(gridImg || undefined);
    if (gridImg) {
      resolveBestImage(gridImg).then((best) => {
        if (!cancelled) setDisplayImg(best);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [gridImg]);

  const openInternal = (it: FashionItem) => {
    // Only pass id + title(+season) — the gallery screen fetches images
    // itself. (Used to also pass the raw fashion-press.net image URL here
    // so the first photo could paint before that fetch resolved, but it
    // leaked the source domain straight into the visible/shareable URL.)
    const title = encodeURIComponent(it.brand_tr || it.title_tr || "");
    const season = encodeURIComponent(it.season || "");
    router.push(`/fashion/brand/${encodeURIComponent(it.source_id)}?title=${title}&season=${season}`);
  };

  if (!item) {
    return (
      <View style={[styles.card, cardW ? { width: cardW } : null, styles.cardEmpty]}>
        <Text style={{ color: colors.brandSecondary, fontWeight: "700" }}>—</Text>
      </View>
    );
  }

  // Single tap opens the collection; a 2nd tap inside ~260ms saves instead
  // (D3: "grid tile double-tap = save"). The short hold-off before opening
  // is the usual double-tap-detection cost — not delaying it would make the
  // double tap indistinguishable from two single taps.
  const handlePress = () => {
    const now = Date.now();
    const isDoubleTap = now - lastTapRef.current < 260;
    lastTapRef.current = now;
    if (isDoubleTap) {
      if (tapTimerRef.current) {
        clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }
      triggerSave();
      return;
    }
    tapTimerRef.current = setTimeout(() => {
      tapTimerRef.current = null;
      openInternal(item);
    }, 260);
  };

  return (
    <Pressable
      testID={`fashion-card-${item.source_id}`}
      onPress={handlePress}
      onLongPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        setPeeking(true);
      }}
      onPressOut={() => setPeeking(false)}
      delayLongPress={280}
      style={({ pressed }) => [styles.card, cardW ? { width: cardW } : null, { opacity: pressed ? 0.9 : 1 }]}
    >
      <Modal visible={peeking} transparent animationType="fade" onRequestClose={() => setPeeking(false)}>
        <View style={styles.peekOverlay} pointerEvents="none">
          <View style={styles.peekCard}>
            {displayImg && (
              <RetryImage uri={fashionImageUri(displayImg)} style={styles.peekImage} contentFit="cover" />
            )}
            <Text numberOfLines={1} style={styles.peekCaption}>
              {item.brand_tr || item.title_tr}
              {item.season || item.season_label ? ` · ${formatSeason(item.season, item.season_label)}` : ""}
            </Text>
          </View>
        </View>
      </Modal>
      <View style={[styles.imageWrap, { backgroundColor: colors.surfaceTertiary, borderColor: colors.border }]}>
        {displayImg ? (
          <RetryImage
            uri={fashionImageUri(displayImg)}
            style={styles.image}
            contentFit="cover"
            transition={220}
            // expo-image's web renderer has open bugs around the blurhash
            // placeholder (github.com/expo/expo#29425) -- native-only until
            // that's actually fixed upstream, since this ran in every grid
            // card at once and is a real candidate for why Safari (a
            // different, stricter JS engine than Chromium) rendered nothing
            // at all rather than a merely-ugly placeholder.
            placeholder={Platform.OS !== "web" && item.image_blurhash ? { blurhash: item.image_blurhash } : undefined}
          />
        ) : (
          <View style={styles.imagePlaceholder}>
            <Feather name="image" size={22} color={colors.brandSecondary} />
          </View>
        )}
        {onSave && (
          <Pressable testID={`fashion-card-save-${item.source_id}`} onPress={triggerSave} hitSlop={8} style={styles.cardSave}>
            <Animated.View style={{ transform: [{ scale: saveScale }] }}>
              <Feather name="bookmark" size={14} color="#fff" style={{ opacity: saved ? 1 : 0.7 }} />
            </Animated.View>
          </Pressable>
        )}
      </View>
      <Text numberOfLines={1} style={[styles.cardBrand, { color: colors.onSurface }]}>
        {item.brand_tr || item.title_tr}
        {item.season || item.season_label ? (
          <Text style={[styles.cardSeason, { color: colors.brandSecondary }]}> ({formatSeason(item.season, item.season_label)})</Text>
        ) : null}
      </Text>
    </Pressable>
  );
}

function Chip({ label, active, onPress, colors }: { label: string; active: boolean; onPress: () => void; colors: any }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, { backgroundColor: active ? colors.brand : colors.surfaceSecondary, borderColor: active ? colors.brand : colors.border }]}>
      <Text style={{ color: active ? colors.onBrand : colors.onSurface, fontSize: 12, fontWeight: "700" }}>{label}</Text>
    </Pressable>
  );
}

// Pill button that opens a bottom-sheet option list (FashionFilterModal)
// instead of spelling every option out as its own chip — same pattern as
// the "Kombin Arama" screen's filter row (app/fashion/search.tsx), used here
// so a filter with many values (season, city) doesn't turn into a wall of
// chips across the top of the feed.
function FilterPill({
  label,
  value,
  active,
  onPress,
  colors,
  testID,
}: {
  label: string;
  value?: string;
  active: boolean;
  onPress: () => void;
  colors: any;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={[styles.filterBtn, { borderColor: active ? colors.brand : colors.border, backgroundColor: active ? colors.brand : colors.surfaceSecondary }]}
    >
      <Text numberOfLines={1} style={{ color: active ? colors.onBrand : colors.onSurface, fontSize: 12, fontWeight: "700", maxWidth: 140 }}>
        {value || label}
      </Text>
      <Feather name="chevron-down" size={13} color={active ? colors.onBrand : colors.brandSecondary} />
    </Pressable>
  );
}

function FashionFilterModal({
  visible,
  onClose,
  title,
  colors,
  bottomInset,
  options,
  selected,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  colors: any;
  bottomInset: number;
  options: { value: string; label: string }[];
  selected: string;
  onSelect: (v: string) => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={[styles.modalSheet, { backgroundColor: colors.surface, paddingBottom: bottomInset + 16 }]}>
          <View style={styles.modalHeader}>
            <Text style={[styles.modalTitle, { color: colors.onSurface }]}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Feather name="x" size={22} color={colors.onSurface} />
            </Pressable>
          </View>
          <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
            {options.map((o) => {
              const active = selected === o.value;
              return (
                <Pressable
                  key={o.value || "all"}
                  testID={`fashion-filter-option-${o.value || "all"}`}
                  onPress={() => onSelect(o.value)}
                  style={[styles.optionRow, active && { backgroundColor: colors.surfaceSecondary }]}
                >
                  <Text style={{ color: colors.onSurface, fontSize: 14, fontWeight: active ? "800" : "500", flex: 1 }}>{o.label}</Text>
                  {active && <Feather name="check" size={16} color={colors.brand} />}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  peekOverlay: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.55)", padding: 40 },
  peekCard: { width: "100%", maxWidth: 320, borderRadius: 10, overflow: "hidden", backgroundColor: "#111" },
  peekImage: { width: "100%", aspectRatio: 3 / 4 },
  peekCaption: { color: "#fff", fontWeight: "700", fontSize: 13, padding: 10 },
  resumeCard: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    marginTop: 14,
  },
  resumeThumbWrap: { width: 44, height: 58, borderRadius: 4, overflow: "hidden" },
  trendCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 14,
  },
  header: {
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  brandLine: { fontSize: 20, fontWeight: "800", letterSpacing: 1 },
  searchWrap: { paddingTop: 10, paddingBottom: 10, borderBottomWidth: 1 },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
  },
  searchBtn: {
    width: 40,
    height: 40,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadDot: {
    position: "absolute", top: 6, right: 6, width: 9, height: 9, borderRadius: 999,
    backgroundColor: "#D32F2F",
  },
  menuOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  menu: { borderRadius: 12, borderWidth: 1, paddingVertical: 6, minWidth: 220 },
  menuItem: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 16 },
  menuBadge: {
    minWidth: 18, height: 18, borderRadius: 999, backgroundColor: "#D32F2F",
    alignItems: "center", justifyContent: "center", paddingHorizontal: 4,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  filterBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
  },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  modalSheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 18,
    maxHeight: "80%",
  },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  modalTitle: { fontSize: 18, fontWeight: "800" },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  // No justifyContent:"space-between" — combined with an explicit `gap`
  // it overflowed each row by one gap's worth at low column counts (see
  // the cardW comment above), wrapping the last card early and leaving a
  // stray empty gap. Pixel-width cards + `gap` alone is enough.
  grid: { flexDirection: "row", flexWrap: "wrap" },
  // 6 columns layout
  card: { width: "16.6%", marginBottom: 18 },
  cardEmpty: { alignItems: "center", justifyContent: "center", height: 220, backgroundColor: "transparent", borderRadius: 4 },
  cardSave: {
    position: "absolute",
    top: 5,
    right: 5,
    width: 26,
    height: 26,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  imageWrap: {
    width: "100%",
    aspectRatio: 3 / 4,
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 8,
  },
  image: { width: "100%", height: "100%" },
  imagePlaceholder: { flex: 1, alignItems: "center", justifyContent: "center" },
  cardBrand: { fontSize: 13, fontWeight: "700", letterSpacing: -0.2 },
  cardSeason: { fontSize: 12, fontWeight: "600" },
  loadMoreBtn: {
    height: 44,
    borderWidth: 1,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  note: { flexDirection: "row", gap: 10, padding: 14, borderRadius: 4, marginTop: 20 },
  noteText: { flex: 1, fontSize: 11, lineHeight: 17 },
});
