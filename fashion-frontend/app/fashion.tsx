// frontend/app/fashion.tsx
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Dimensions,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api, FashionItem, FashionAnalytics } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { formatDate } from "@/src/utils/format";
import { resolveBestImage, fashionImageUri } from "@/src/utils/fashionImage";

const { width } = Dimensions.get("window");

const CATEGORIES: { value: string; label: string }[] = [
  { value: "women", label: "Kadın" },
  { value: "men", label: "Erkek" },
  { value: "haute-couture", label: "Haute Couture" },
];

export default function Fashion() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [items, setItems] = useState<FashionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [analytics, setAnalytics] = useState<FashionAnalytics | null>(null);
  const [season, setSeason] = useState<string | undefined>(undefined);
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [city, setCity] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openModal, setOpenModal] = useState<"city" | "season" | null>(null);

  const PAGE_SIZE = 40;

  const load = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      try {
        const [feed, stats] = await Promise.all([
          api.fashionCollections({ season, category, city, limit: PAGE_SIZE }),
          api.fashionAnalytics(),
        ]);
        setItems(feed.items || []);
        setTotal(feed.total ?? (feed.items || []).length);
        setAnalytics(stats);
      } catch {
        /* sessizce geç */
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [season, category, city],
  );

  const loadMore = useCallback(async () => {
    if (loadingMore || items.length >= total) return;
    setLoadingMore(true);
    try {
      const feed = await api.fashionCollections({
        season,
        category,
        city,
        skip: items.length,
        limit: PAGE_SIZE,
      });
      setItems((cur) => [...cur, ...(feed.items || [])]);
      setTotal(feed.total ?? total);
    } catch {
      /* sessizce geç */
    } finally {
      setLoadingMore(false);
    }
  }, [season, category, city, items.length, total, loadingMore]);

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
            COZA <Text style={{ color: colors.brandSecondary }}>FASHION</Text>
          </Text>
        </View>
        <Pressable
          testID="fashion-open-search"
          onPress={() => router.push("/fashion/search" as any)}
          style={[styles.searchBtn, { borderColor: colors.border, backgroundColor: colors.surfaceSecondary }]}
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
            <Chip label="Tümü" active={!category} onPress={() => setCategory(undefined)} colors={colors} />
            {CATEGORIES.map((c) => (
              <Chip
                key={c.value}
                label={c.label}
                active={category === c.value}
                onPress={() => setCategory((cur) => (cur === c.value ? undefined : c.value))}
                colors={colors}
              />
            ))}
          </ScrollView>

          {(cityChips.length > 0 || seasonChips.length > 0) && (
            <View style={{ flexDirection: "row", paddingHorizontal: spacing.xl, gap: 8, paddingBottom: 14 }}>
              {cityChips.length > 0 && (
                <FilterPill
                  testID="fashion-filter-city"
                  label="Şehir"
                  value={city}
                  active={!!city}
                  onPress={() => setOpenModal("city")}
                  colors={colors}
                />
              )}
              {seasonChips.length > 0 && (
                <FilterPill
                  testID="fashion-filter-season"
                  label="Sezon"
                  value={season ? seasonChips.find((s) => s.code === season)?.label : undefined}
                  active={!!season}
                  onPress={() => setOpenModal("season")}
                  colors={colors}
                />
              )}
            </View>
          )}

          {items.length === 0 ? (
            <View style={{ paddingHorizontal: spacing.xl, marginTop: 40 }}>
              <Text style={{ color: colors.brandSecondary, textAlign: "center" }}>Henüz içerik yok. İçerik her gün 07:00'de otomatik güncellenir.</Text>
            </View>
          ) : (
            <View style={[styles.grid, { paddingHorizontal: spacing.xl - 4 }]}>
              {slots.map((it, idx) => (
                <FashionCard key={idx} item={it} colors={colors} />
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
              ) : (
                <Text style={{ color: colors.onSurface, fontWeight: "700" }}>Daha Fazla Yükle ({items.length}/{total})</Text>
              )}
            </Pressable>
          )}

          {analytics?.last_scrape && (
            <View style={[styles.note, { backgroundColor: colors.surfaceSecondary, marginHorizontal: spacing.xl }]}>
              <Feather name="info" size={14} color={colors.brandSecondary} />
              <Text style={[styles.noteText, { color: colors.brandSecondary }]}>
                İçerik fashion-press.net, NOWFASHION ve FirstView'dan derlenir. Her gün 07:00'de otomatik güncellenir. Son güncelleme: {formatDate(analytics.last_scrape)}
              </Text>
            </View>
          )}
        </ScrollView>
      )}

      <FashionFilterModal
        visible={openModal !== null}
        onClose={() => setOpenModal(null)}
        title={openModal === "city" ? "Şehir" : "Sezon"}
        colors={colors}
        bottomInset={insets.bottom}
        options={
          openModal === "city"
            ? [{ value: "", label: "Tüm Şehirler" }, ...cityChips.map((c) => ({ value: c, label: c }))]
            : [{ value: "", label: "Tüm Sezonlar" }, ...seasonChips.map((s) => ({ value: s.code, label: s.label }))]
        }
        selected={(openModal === "city" ? city : season) || ""}
        onSelect={(v) => {
          if (openModal === "city") setCity(v || undefined);
          else if (openModal === "season") setSeason(v || undefined);
          setOpenModal(null);
        }}
      />
    </View>
  );
}

function FashionCard({ item, colors }: { item: FashionItem | null; colors: any }) {
  const router = useRouter();
  const [displayImg, setDisplayImg] = useState<string | undefined>(item?.image);

  useEffect(() => {
    let cancelled = false;
    setDisplayImg(item?.image);
    if (item?.image) {
      resolveBestImage(item.image).then((best) => {
        if (!cancelled) setDisplayImg(best);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [item?.image]);

  const openInternal = (it: FashionItem) => {
    // Only pass id + title(+season) — the gallery screen fetches images
    // itself. (Used to also pass the raw fashion-press.net image URL here
    // so the first photo could paint before that fetch resolved, but it
    // leaked the source domain straight into the visible/shareable URL.)
    const title = encodeURIComponent(it.brand_tr || it.title_tr || "");
    const season = encodeURIComponent(it.season_label || "");
    router.push(`/fashion/brand/${encodeURIComponent(it.source_id)}?title=${title}&season=${season}`);
  };

  if (!item) {
    return (
      <View style={[styles.card, styles.cardEmpty]}>
        <Text style={{ color: colors.brandSecondary, fontWeight: "700" }}>—</Text>
      </View>
    );
  }

  return (
    <Pressable testID={`fashion-card-${item.source_id}`} onPress={() => openInternal(item)} style={({ pressed }) => [styles.card, { opacity: pressed ? 0.9 : 1 }]}>
      <View style={[styles.imageWrap, { backgroundColor: colors.surfaceTertiary, borderColor: colors.border }]}>
        {displayImg ? (
          <Image source={{ uri: fashionImageUri(displayImg) }} style={styles.image} contentFit="cover" transition={220} />
        ) : (
          <View style={styles.imagePlaceholder}>
            <Feather name="image" size={22} color={colors.brandSecondary} />
          </View>
        )}
      </View>
      <Text numberOfLines={1} style={[styles.cardBrand, { color: colors.onSurface }]}>
        {item.brand_tr || item.title_tr}
        {item.season_label ? (
          <Text style={[styles.cardSeason, { color: colors.brandSecondary }]}> ({item.season_label})</Text>
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
