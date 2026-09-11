// frontend/app/fashion.tsx
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Dimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
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

const { width } = Dimensions.get("window");

const CATEGORY_VALUES = ["women", "men", "haute-couture"] as const;

export default function Fashion() {
  const { colors, spacing } = useTheme();
  const { t, formatSeason } = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { cols, cycle: cycleCols, widthPct } = useGridColumns();

  const [items, setItems] = useState<FashionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [analytics, setAnalytics] = useState<FashionAnalytics | null>(null);
  const [season, setSeason] = useState<string | undefined>(undefined);
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
      {/* Header */}
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, paddingHorizontal: spacing.xl, borderBottomColor: colors.divider },
        ]}
      >
        <View style={{ flex: 1 }}>
          <Text style={[styles.brandLine, { color: colors.onSurface }]}>
            COZA <Text style={{ color: colors.brandSecondary }}>{t("feed.title")}</Text>
          </Text>
        </View>
        <Pressable
          testID="fashion-open-boards"
          onPress={() => router.push("/fashion/boards" as any)}
          style={[styles.searchBtn, { borderColor: colors.border, backgroundColor: colors.surfaceSecondary }]}
          hitSlop={8}
        >
          <Feather name="bookmark" size={18} color={colors.onSurface} />
        </Pressable>
        <Pressable
          testID="fashion-open-search"
          onPress={() => router.push("/fashion/search" as any)}
          style={[styles.searchBtn, { borderColor: colors.border, backgroundColor: colors.surfaceSecondary, marginLeft: 8 }]}
          hitSlop={8}
        >
          <Feather name="search" size={18} color={colors.onSurface} />
        </Pressable>
        <Pressable
          testID="fashion-open-settings"
          onPress={() => router.push("/settings" as any)}
          style={[styles.searchBtn, { borderColor: colors.border, backgroundColor: colors.surfaceSecondary, marginLeft: 8 }]}
          hitSlop={8}
        >
          <Feather name="settings" size={18} color={colors.onSurface} />
        </Pressable>
      </View>

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
            <View style={[styles.grid, { paddingHorizontal: spacing.xl - 4 }]}>
              {slots.map((it, idx) => (
                <FashionCard
                  key={idx}
                  item={it}
                  colors={colors}
                  widthPct={widthPct}
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
  widthPct,
}: {
  item: FashionItem | null;
  colors: any;
  saved?: boolean;
  onSave?: () => void;
  widthPct?: string;
}) {
  const router = useRouter();
  const { formatSeason } = useT();
  const saveScale = useRef(new Animated.Value(1)).current;
  const lastTapRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      <View style={[styles.card, widthPct ? { width: widthPct } : null, styles.cardEmpty]}>
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
      style={({ pressed }) => [styles.card, widthPct ? { width: widthPct } : null, { opacity: pressed ? 0.9 : 1 }]}
    >
      <View style={[styles.imageWrap, { backgroundColor: colors.surfaceTertiary, borderColor: colors.border }]}>
        {displayImg ? (
          <RetryImage uri={fashionImageUri(displayImg)} style={styles.image} contentFit="cover" transition={220} />
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
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
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 12 },
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
