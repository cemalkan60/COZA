// frontend/app/fashion/search.tsx
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
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api, FashionLookFilters, FashionLookItem, FashionLookOption } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { ZoomableImage } from "@/src/components/ZoomableImage";

type FilterKey = "season" | "item" | "color" | "material" | "pattern";

const FILTER_META: { key: FilterKey; label: string }[] = [
  { key: "season", label: "Mevsim" },
  { key: "item", label: "Öğe" },
  { key: "color", label: "Renk" },
  { key: "material", label: "Malzeme" },
  { key: "pattern", label: "Model" },
];

export default function FashionSearch() {
  const { colors, spacing } = useTheme();
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
  const [openModal, setOpenModal] = useState<FilterKey | null>(null);
  const [viewerItem, setViewerItem] = useState<FashionLookItem | null>(null);

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
        const res = await api.fashionLooks({ gender: gender || undefined, ...selected });
        setItems(res.items || []);
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [gender, selected],
  );

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gender, selected]);

  const setFilter = (key: FilterKey, value: string) => {
    setSelected((s) => ({ ...s, [key]: value }));
    setOpenModal(null);
  };

  const genderTabs: FashionLookOption[] = filters?.genders || [
    { value: "", label: "Tümü" },
    { value: "female", label: "Bayanlar" },
    { value: "male", label: "Erkekler" },
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
    if (!val) return FILTER_META.find((f) => f.key === key)!.label;
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
        <Pressable testID="fashion-search-back" onPress={() => router.back()} hitSlop={10}>
          <Feather name="chevron-left" size={26} color={colors.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.onSurface }]}>Kombin Arama</Text>
          <Text style={[styles.helper, { color: colors.brandSecondary }]}>Koleksiyon koordinasyon araması</Text>
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
            {FILTER_META.map((f) => {
              const active = !!selected[f.key];
              return (
                <Pressable
                  key={f.key}
                  testID={`look-filter-${f.key}`}
                  onPress={() => setOpenModal(f.key)}
                  style={[
                    styles.filterBtn,
                    { borderColor: active ? colors.brand : colors.border, backgroundColor: active ? colors.brand : colors.surfaceSecondary },
                  ]}
                >
                  <Text
                    numberOfLines={1}
                    style={{ color: active ? colors.onBrand : colors.onSurface, fontSize: 12, fontWeight: "700", maxWidth: 130 }}
                  >
                    {currentLabel(f.key)}
                  </Text>
                  <Feather name="chevron-down" size={13} color={active ? colors.onBrand : colors.brandSecondary} />
                </Pressable>
              );
            })}
          </ScrollView>

          {items.length === 0 ? (
            <View style={{ paddingHorizontal: spacing.xl, marginTop: 40 }}>
              <Text style={{ color: colors.brandSecondary, textAlign: "center" }}>
                Bu filtreye uygun kombin bulunamadı.
              </Text>
            </View>
          ) : (
            <View style={[styles.grid, { gap, paddingHorizontal: gridPad, paddingTop: 6 }]}>
              {items.map((it, idx) => (
                <LookCard
                  key={`${it.source_id}-${idx}`}
                  item={it}
                  width={cardWidth}
                  colors={colors}
                  onPress={() => setViewerItem(it)}
                />
              ))}
            </View>
          )}
        </ScrollView>
      )}

      <FilterModal
        visible={!!openModal}
        onClose={() => setOpenModal(null)}
        title={openModal ? FILTER_META.find((f) => f.key === openModal)!.label : ""}
        colors={colors}
        bottomInset={insets.bottom}
        selected={openModal ? selected[openModal] : ""}
        onSelect={(v) => openModal && setFilter(openModal, v)}
        flatOptions={openModal && openModal !== "item" ? flatOptionsFor(openModal) : undefined}
        groupedOptions={openModal === "item" ? filters?.items : undefined}
      />

      <Modal visible={!!viewerItem} animationType="fade" transparent onRequestClose={() => setViewerItem(null)}>
        <View style={styles.viewerOverlay}>
          <Pressable
            testID="look-viewer-close"
            onPress={() => setViewerItem(null)}
            style={[styles.viewerClose, { top: insets.top + 12 }]}
            hitSlop={12}
          >
            <Feather name="x" size={26} color="#fff" />
          </Pressable>
          {viewerItem && (
            <View style={styles.viewerImageWrap}>
              <ZoomableImage
                uri={viewerItem.image || ""}
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
    </View>
  );
}

function LookCard({
  item,
  width,
  colors,
  onPress,
}: {
  item: FashionLookItem;
  width: number;
  colors: any;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={`look-card-${item.source_id}`}
      onPress={onPress}
      style={({ pressed }) => [{ width, opacity: pressed ? 0.9 : 1 }]}
    >
      <View style={[styles.cardImageWrap, { backgroundColor: colors.surfaceTertiary, borderColor: colors.border }]}>
        {item.image ? (
          <Image source={{ uri: item.image }} style={styles.cardImage} contentFit="cover" transition={220} />
        ) : (
          <View style={styles.cardImagePlaceholder}>
            <Feather name="image" size={20} color={colors.brandSecondary} />
          </View>
        )}
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
            <OptionRow label="Tümü" active={!selected} onPress={() => onSelect("")} colors={colors} />
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
  cardImageWrap: {
    width: "100%",
    aspectRatio: 5 / 7,
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 8,
  },
  cardImage: { width: "100%", height: "100%" },
  cardImagePlaceholder: { flex: 1, alignItems: "center", justifyContent: "center" },
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
