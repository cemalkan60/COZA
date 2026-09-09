// frontend/app/fashion/search.tsx
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api, FashionLookFilters, FashionLookItem, FashionLookOption } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useT } from "@/src/i18n";
import { ZoomableImage } from "@/src/components/ZoomableImage";
import { SaveToBoardSheet } from "@/src/components/SaveToBoardSheet";
import { fashionImageUri } from "@/src/utils/fashionImage";
import { goBack } from "@/src/utils/nav";
import { storage } from "@/src/utils/storage";

// Lens source_id is "<collection source_id>#<photo index>" (see fashion_looks).
function splitLookId(sid: string): { source_id: string; photo_index: number } {
  const i = sid.lastIndexOf("#");
  return i < 0
    ? { source_id: sid, photo_index: 0 }
    : { source_id: sid.slice(0, i), photo_index: parseInt(sid.slice(i + 1), 10) || 0 };
}

type FilterKey = "season" | "item" | "color" | "material" | "pattern";

const FILTER_KEYS: FilterKey[] = ["season", "item", "color", "material", "pattern"];

export default function FashionSearch() {
  const { colors, spacing } = useTheme();
  const { t, formatSeason } = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width, height } = useWindowDimensions();

  const [filters, setFilters] = useState<FashionLookFilters | null>(null);
  const [gender, setGender] = useState("");
  const [selected, setSelected] = useState<Record<FilterKey, string>>({
    season: "",
    item: "",
    color: "",
    material: "",
    pattern: "",
  });
  const [items, setItems] = useState<FashionLookItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [openModal, setOpenModal] = useState<FilterKey | null>(null);
  const [viewerItem, setViewerItem] = useState<FashionLookItem | null>(null);
  const [saveItem, setSaveItem] = useState<FashionLookItem | null>(null);
  const [savedKeys, setSavedKeys] = useState<Record<string, string[]>>({});
  const refreshSaved = useCallback(() => {
    api.savedKeys().then((r) => setSavedKeys(r.saved || {})).catch(() => {});
  }, []);
  useEffect(() => { refreshSaved(); }, [refreshSaved]);
  const [q, setQ] = useState("");
  const [qActive, setQActive] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const recentReady = useRef(false);

  const PAGE = 90;

  useEffect(() => {
    const t = setTimeout(() => setQActive(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  // Recent searches — device-local, newest first, capped at 10. Stored as a
  // newline-joined string (storage only round-trips primitives).
  const RECENT_KEY = "coza.lens.recent";
  useEffect(() => {
    storage
      .getItem<string>(RECENT_KEY, "")
      .then((raw) => setRecent((raw || "").split("\n").filter(Boolean).slice(0, 10)))
      .finally(() => {
        recentReady.current = true;
      });
  }, []);
  useEffect(() => {
    const term = qActive.trim();
    if (!recentReady.current || term.length < 2) return;
    setRecent((cur) => {
      const next = [term, ...cur.filter((r) => r.toLowerCase() !== term.toLowerCase())].slice(0, 10);
      storage.setItem(RECENT_KEY, next.join("\n"));
      return next;
    });
  }, [qActive]);

  useEffect(() => {
    api
      .fashionLookFilters()
      .then(setFilters)
      .catch(() => {});
  }, []);

  const load = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await api.fashionLooks({ gender: gender || undefined, ...selected, q: qActive || undefined });
        const list = res.items || [];
        setItems(list);
        setHasMore(list.length >= PAGE);
      } catch {
        setItems([]);
        setHasMore(false);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [gender, selected, qActive],
  );

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const res = await api.fashionLooks({ gender: gender || undefined, ...selected, q: qActive || undefined, skip: items.length });
      const list = res.items || [];
      setItems((cur) => [...cur, ...list]);
      setHasMore(list.length >= PAGE);
    } catch {
      /* sessizce geç */
    } finally {
      setLoadingMore(false);
    }
  }, [gender, selected, qActive, items.length, hasMore, loadingMore]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gender, selected, qActive]);

  const setFilter = (key: FilterKey, value: string) => {
    setSelected((s) => ({ ...s, [key]: value }));
    setOpenModal(null);
  };

  const filterLabel = (key: FilterKey): string =>
    key === "season" ? t("feed.seasonFilter") : t(`lens.${key}`);

  const genderTabs: FashionLookOption[] = filters?.genders || [
    { value: "", label: t("common.all") },
    { value: "female", label: t("category.women") },
    { value: "male", label: t("category.men") },
  ];

  const flatOptionsFor = (key: FilterKey): FashionLookOption[] | undefined => {
    if (!filters) return undefined;
    if (key === "season") return filters.seasons;
    if (key === "color") return filters.colors;
    if (key === "material") return filters.materials;
    if (key === "pattern") return filters.patterns;
    return undefined;
  };

  const currentLabel = (key: FilterKey): string => {
    const val = selected[key];
    if (!val) return filterLabel(key);
    if (key === "season") return formatSeason(val, flatOptionsFor("season")?.find((o) => o.value === val)?.label);
    if (key === "item") {
      for (const g of filters?.items || []) {
        const opt = g.options.find((o) => o.value === val);
        if (opt) return opt.label;
      }
      return val;
    }
    return flatOptionsFor(key)?.find((o) => o.value === val)?.label || val;
  };

  const columns = width >= 1200 ? 5 : width >= 900 ? 4 : width >= 600 ? 3 : 2;
  const gap = 10;
  const gridPad = spacing.xl - 4;
  const cardWidth = (width - gridPad * 2 - gap * (columns - 1)) / columns;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, paddingHorizontal: spacing.xl, borderBottomColor: colors.divider },
        ]}
      >
        <Pressable testID="fashion-search-back" onPress={() => goBack(router, "/fashion")} hitSlop={10}>
          <Feather name="chevron-left" size={26} color={colors.onSurface} />
        </Pressable>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "baseline" }}>
          <Text style={[styles.title, { color: colors.onSurface, letterSpacing: 3, fontWeight: "800" }]}>COZA</Text>
          <Text style={[styles.title, { color: colors.brandSecondary, letterSpacing: 3, fontWeight: "300", marginLeft: 6 }]}>LENS</Text>
        </View>
      </View>

      <View style={{ paddingHorizontal: spacing.xl, paddingTop: 10, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
        <View style={[styles.searchBar, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}>
          <Feather name="search" size={16} color={colors.brandSecondary} />
          <TextInput
            testID="look-search-input"
            value={q}
            onChangeText={setQ}
            placeholder={t("lens.searchPlaceholder")}
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

        {!q.trim() && recent.length > 0 && (
          <View style={{ marginTop: 10 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <Text style={{ color: colors.brandSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 0.4 }}>
                {t("lens.recent").toUpperCase()}
              </Text>
              <Pressable
                onPress={() => {
                  setRecent([]);
                  storage.setItem("coza.lens.recent", "");
                }}
                hitSlop={8}
              >
                <Text style={{ color: colors.brandSecondary, fontSize: 11, fontWeight: "700" }}>{t("lens.clearRecent")}</Text>
              </Pressable>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {recent.map((r) => (
                <Pressable
                  key={r}
                  onPress={() => setQ(r)}
                  style={{
                    paddingHorizontal: 12,
                    height: 30,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: colors.border,
                    backgroundColor: colors.surfaceSecondary,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: colors.onSurface, fontSize: 12, fontWeight: "600" }}>{r}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}
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
          {/* Gender tabs */}
          <View style={[styles.tabRow, { paddingHorizontal: spacing.xl, borderBottomColor: colors.divider }]}>
            {genderTabs.map((g) => {
              const active = gender === g.value;
              return (
                <Pressable
                  key={g.value || "all"}
                  testID={`look-gender-${g.value || "all"}`}
                  onPress={() => setGender(g.value)}
                  style={styles.tabItem}
                >
                  <Text
                    style={{
                      color: active ? colors.onSurface : colors.brandSecondary,
                      fontWeight: active ? "800" : "600",
                      fontSize: 14,
                    }}
                  >
                    {g.label}
                  </Text>
                  {active && <View style={[styles.tabUnderline, { backgroundColor: colors.onSurface }]} />}
                </Pressable>
              );
            })}
          </View>

          {/* Filter dropdowns */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: spacing.xl, gap: 8, paddingVertical: 12 }}
          >
            {FILTER_KEYS.map((f) => {
              const active = !!selected[f];
              return (
                <Pressable
                  key={f}
                  testID={`look-filter-${f}`}
                  onPress={() => setOpenModal(f)}
                  style={[
                    styles.filterBtn,
                    { borderColor: active ? colors.brand : colors.border, backgroundColor: active ? colors.brand : colors.surfaceSecondary },
                  ]}
                >
                  <Text
                    numberOfLines={1}
                    style={{ color: active ? colors.onBrand : colors.onSurface, fontSize: 12, fontWeight: "700", maxWidth: 130 }}
                  >
                    {currentLabel(f)}
                  </Text>
                  <Feather name="chevron-down" size={13} color={active ? colors.onBrand : colors.brandSecondary} />
                </Pressable>
              );
            })}
          </ScrollView>

          {items.length === 0 ? (
            <View style={{ paddingHorizontal: spacing.xl, marginTop: 40 }}>
              <Text style={{ color: colors.brandSecondary, textAlign: "center" }}>{t("lens.empty")}</Text>
            </View>
          ) : (
            <>
              <View style={[styles.grid, { gap, paddingHorizontal: gridPad, paddingTop: 6 }]}>
                {items.map((it, idx) => (
                  <LookCard
                    key={`${it.source_id}-${idx}`}
                    item={it}
                    width={cardWidth}
                    colors={colors}
                    saved={(savedKeys[it.source_id]?.length ?? 0) > 0}
                    onPress={() => setViewerItem(it)}
                    onSave={() => setSaveItem(it)}
                  />
                ))}
              </View>
              {hasMore && (
                <Pressable
                  testID="look-load-more"
                  onPress={loadMore}
                  disabled={loadingMore}
                  style={[
                    styles.loadMoreBtn,
                    { borderColor: colors.border, marginHorizontal: spacing.xl, opacity: loadingMore ? 0.6 : 1 },
                  ]}
                >
                  {loadingMore ? (
                    <ActivityIndicator color={colors.onSurface} size="small" />
                  ) : (
                    <Text style={{ color: colors.onSurface, fontWeight: "700" }}>
                      {t("common.loadMore")} ({items.length})
                    </Text>
                  )}
                </Pressable>
              )}
            </>
          )}
        </ScrollView>
      )}

      <FilterModal
        visible={!!openModal}
        onClose={() => setOpenModal(null)}
        title={openModal ? filterLabel(openModal) : ""}
        colors={colors}
        bottomInset={insets.bottom}
        selected={openModal ? selected[openModal] : ""}
        onSelect={(v) => openModal && setFilter(openModal, v)}
        flatOptions={openModal && openModal !== "item" ? flatOptionsFor(openModal) : undefined}
        groupedOptions={openModal === "item" ? filters?.items : undefined}
      />

      <Modal visible={!!viewerItem} animationType="fade" transparent onRequestClose={() => setViewerItem(null)}>
        <View style={styles.viewerOverlay}>
          {/* Tapping the dark area around the photo closes the viewer. */}
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setViewerItem(null)} />
          <Pressable
            testID="look-viewer-close"
            onPress={() => setViewerItem(null)}
            style={[styles.viewerClose, { top: insets.top + 12 }]}
            hitSlop={12}
          >
            <Feather name="x" size={26} color="#fff" />
          </Pressable>
          {viewerItem && (
            <Pressable
              testID="look-viewer-save"
              onPress={() => setSaveItem(viewerItem)}
              style={[styles.viewerClose, { top: insets.top + 12, left: 16, right: undefined }]}
              hitSlop={12}
            >
              <Feather
                name="bookmark"
                size={22}
                color="#fff"
                style={{ opacity: (savedKeys[viewerItem.source_id]?.length ?? 0) > 0 ? 1 : 0.55 }}
              />
            </Pressable>
          )}
          {viewerItem && (
            <View style={styles.viewerImageWrap} pointerEvents="box-none">
              <ZoomableImage
                uri={fashionImageUri(viewerItem.image)}
                width={width * 0.92}
                height={height * 0.7}
                contentFit="contain"
              />
              {(viewerItem.brand_tr || viewerItem.season_text_tr) && (
                <Text style={styles.viewerCaption}>
                  {[viewerItem.brand_tr, viewerItem.season_text_tr].filter(Boolean).join(" · ")}
                </Text>
              )}
            </View>
          )}
        </View>
      </Modal>

      <SaveToBoardSheet
        visible={!!saveItem}
        onClose={() => setSaveItem(null)}
        photo={
          saveItem
            ? {
                ...splitLookId(saveItem.source_id),
                image: saveItem.image || "",
                image_thumb: saveItem.image || "",
                brand_tr: saveItem.brand_tr || "",
                season_label: saveItem.season_text_tr || "",
              }
            : null
        }
        savedBoardIds={saveItem ? savedKeys[saveItem.source_id] || [] : []}
        onChange={refreshSaved}
      />
    </View>
  );
}

function LookCard({
  item,
  width,
  colors,
  onPress,
  onSave,
  saved,
}: {
  item: FashionLookItem;
  width: number;
  colors: any;
  onPress: () => void;
  onSave: () => void;
  saved: boolean;
}) {
  return (
    <Pressable
      testID={`look-card-${item.source_id}`}
      onPress={onPress}
      style={({ pressed }) => [{ width, opacity: pressed ? 0.9 : 1 }]}
    >
      <View style={[styles.cardImageWrap, { backgroundColor: colors.surfaceTertiary, borderColor: colors.border }]}>
        {item.image ? (
          <Image source={{ uri: fashionImageUri(item.image) }} style={styles.cardImage} contentFit="cover" transition={220} />
        ) : (
          <View style={styles.cardImagePlaceholder}>
            <Feather name="image" size={20} color={colors.brandSecondary} />
          </View>
        )}
        <Pressable testID={`look-card-save-${item.source_id}`} onPress={onSave} hitSlop={8} style={styles.cardSave}>
          <Feather name="bookmark" size={15} color="#fff" style={{ opacity: saved ? 1 : 0.7 }} />
        </Pressable>
      </View>
      <Text numberOfLines={1} style={[styles.cardBrand, { color: colors.onSurface }]}>
        {item.brand_tr || "—"}
      </Text>
      {!!item.season_text_tr && (
        <Text numberOfLines={1} style={[styles.cardSeason, { color: colors.brandSecondary }]}>
          {item.season_text_tr}
        </Text>
      )}
    </Pressable>
  );
}

function FilterModal({
  visible,
  onClose,
  title,
  colors,
  bottomInset,
  selected,
  onSelect,
  flatOptions,
  groupedOptions,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  colors: any;
  bottomInset: number;
  selected: string;
  onSelect: (v: string) => void;
  flatOptions?: FashionLookOption[];
  groupedOptions?: { group: string; options: FashionLookOption[] }[];
}) {
  const { t } = useT();
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
            <OptionRow label={t("common.all")} active={!selected} onPress={() => onSelect("")} colors={colors} />
            {flatOptions?.map((o) => (
              <OptionRow
                key={o.value}
                label={o.label}
                hex={o.hex}
                active={selected === o.value}
                onPress={() => onSelect(o.value)}
                colors={colors}
              />
            ))}
            {groupedOptions?.map((g) => (
              <View key={g.group} style={{ marginTop: 14 }}>
                <Text style={[styles.groupLabel, { color: colors.brandSecondary }]}>{g.group.toUpperCase()}</Text>
                {g.options.map((o) => (
                  <OptionRow
                    key={o.value}
                    label={o.label}
                    active={selected === o.value}
                    onPress={() => onSelect(o.value)}
                    colors={colors}
                  />
                ))}
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function OptionRow({
  label,
  hex,
  active,
  onPress,
  colors,
}: {
  label: string;
  hex?: string;
  active: boolean;
  onPress: () => void;
  colors: any;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.optionRow, active && { backgroundColor: colors.surfaceSecondary }]}>
      {hex && <View style={[styles.swatch, { backgroundColor: hex, borderColor: colors.border }]} />}
      <Text style={{ color: colors.onSurface, fontSize: 14, fontWeight: active ? "800" : "500", flex: 1 }}>{label}</Text>
      {active && <Feather name="check" size={16} color={colors.brand} />}
    </Pressable>
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
  title: { fontSize: 18, fontWeight: "800", letterSpacing: -0.2 },
  helper: { fontSize: 11, marginTop: 3, letterSpacing: 0.2 },
  tabRow: { flexDirection: "row", gap: 22, paddingTop: 14, borderBottomWidth: 1 },
  tabItem: { paddingBottom: 12, alignItems: "center" },
  tabUnderline: { height: 2, width: "100%", marginTop: 8, borderRadius: 1 },
  filterBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
  },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
  },
  loadMoreBtn: {
    height: 44,
    borderWidth: 1,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 14,
  },
  cardImageWrap: {
    width: "100%",
    aspectRatio: 5 / 7,
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 8,
  },
  cardImage: { width: "100%", height: "100%" },
  cardImagePlaceholder: { flex: 1, alignItems: "center", justifyContent: "center" },
  cardSave: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 28,
    height: 28,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  cardBrand: { fontSize: 12, fontWeight: "700", letterSpacing: -0.1 },
  cardSeason: { fontSize: 11, marginTop: 2 },
  // Single-image viewer
  viewerOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.95)", alignItems: "center", justifyContent: "center" },
  viewerImageWrap: { alignItems: "center", justifyContent: "center", width: "100%" },
  viewerCaption: { color: "#fff", fontSize: 13, fontWeight: "700", marginTop: 16, textAlign: "center", paddingHorizontal: 24 },
  viewerClose: {
    position: "absolute",
    right: 16,
    zIndex: 10,
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  // Filter option modal
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
  groupLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 1.2, marginBottom: 6 },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  swatch: { width: 16, height: 16, borderRadius: 999, borderWidth: 1 },
});
