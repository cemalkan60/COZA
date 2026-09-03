import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api, Product } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { ProductCard } from "@/src/components/ProductCard";

const LIMIT = 24;

const SORT_OPTIONS = [
  { key: "featured", label: "Öne Çıkanlar" },
  { key: "price_asc", label: "Fiyat: Artan" },
  { key: "price_desc", label: "Fiyat: Azalan" },
  { key: "name", label: "İsim" },
];

export default function Catalog() {
  const { colors, spacing, fontSize } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{
    category?: string;
    origin?: string;
    department?: string;
    min_price?: string;
    max_price?: string;
    sort?: string;
  }>();

  const category = params.category || undefined;
  const origin = params.origin || undefined;
  const department = params.department || undefined;
  const minPrice = params.min_price ? Number(params.min_price) : undefined;
  const maxPrice = params.max_price ? Number(params.max_price) : undefined;
  const sort = params.sort || undefined;

  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  // Filter panel state
  const [filterVisible, setFilterVisible] = useState(false);
  const [filterOptions, setFilterOptions] = useState<{
    categories: string[];
    departments: string[];
    origins: string[];
    price_min: number;
    price_max: number;
  } | null>(null);

  // Draft state inside the modal (only applied on "Uygula")
  const [draftDepartment, setDraftDepartment] = useState<string | undefined>(department);
  const [draftCategory, setDraftCategory] = useState<string | undefined>(category);
  const [draftOrigin, setDraftOrigin] = useState<string | undefined>(origin);
  const [draftMin, setDraftMin] = useState(minPrice ? String(minPrice) : "");
  const [draftMax, setDraftMax] = useState(maxPrice ? String(maxPrice) : "");
  const [draftSort, setDraftSort] = useState<string | undefined>(sort);

  useEffect(() => {
    api
      .filters()
      .then(setFilterOptions)
      .catch(() => setFilterOptions(null));
  }, []);

  const openFilters = () => {
    setDraftDepartment(department);
    setDraftCategory(category);
    setDraftOrigin(origin);
    setDraftMin(minPrice ? String(minPrice) : "");
    setDraftMax(maxPrice ? String(maxPrice) : "");
    setDraftSort(sort);
    setFilterVisible(true);
  };

  const applyFilters = () => {
    router.setParams({
      department: draftDepartment || "",
      category: draftCategory || "",
      origin: draftOrigin || "",
      min_price: draftMin || "",
      max_price: draftMax || "",
      sort: draftSort || "",
    } as any);
    setFilterVisible(false);
  };

  const resetFilters = () => {
    setDraftDepartment(undefined);
    setDraftCategory(undefined);
    setDraftOrigin(undefined);
    setDraftMin("");
    setDraftMax("");
    setDraftSort(undefined);
  };

  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const query = useMemo(
    () => ({
      category,
      origin,
      department,
      min_price: minPrice,
      max_price: maxPrice,
      sort,
      q: q || undefined,
    }),
    [category, origin, department, minPrice, maxPrice, sort, q],
  );

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      if (mode === "refresh") setRefreshing(true);
      else setLoading(true);
      setError(false);
      try {
        const data = await api.products({ ...query, skip: 0, limit: LIMIT });
        setItems(data.items);
        setTotal(data.total);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [query],
  );

  useEffect(() => {
    load("initial");
  }, [load]);

  const loadMore = useCallback(async () => {
    if (loadingMore || loading || items.length >= total) return;
    setLoadingMore(true);
    try {
      const data = await api.products({ ...query, skip: items.length, limit: LIMIT });
      setItems((prev) => [...prev, ...data.items]);
    } catch {
      /* ignore */
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, loading, items.length, total, query]);

  const activeChips = [
    department ? { key: "department", label: department } : null,
    category ? { key: "category", label: category } : null,
    origin ? { key: "origin", label: origin } : null,
    minPrice || maxPrice
      ? {
          key: "price",
          label: `${minPrice ?? "0"}₺ - ${maxPrice ?? "∞"}₺`,
        }
      : null,
    sort ? { key: "sort", label: SORT_OPTIONS.find((s) => s.key === sort)?.label || sort } : null,
  ].filter(Boolean) as { key: string; label: string }[];

  const removeChip = (key: string) => {
    if (key === "price") {
      router.setParams({ min_price: "", max_price: "" } as any);
    } else {
      router.setParams({ [key]: "" } as any);
    }
  };

  const activeFilterCount = activeChips.length;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Search + filter button */}
      <View style={[styles.searchWrap, { paddingHorizontal: spacing.lg }]}>
        <Pressable
          testID="catalog-back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)"))}
          hitSlop={10}
          style={styles.backBtn}
        >
          <Feather name="chevron-left" size={22} color={colors.onSurface} />
        </Pressable>
        <View style={[styles.search, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}>
          <Feather name="search" size={16} color={colors.brandSecondary} />
          <TextInput
            testID="search-input"
            value={searchInput}
            onChangeText={setSearchInput}
            placeholder="ARA"
            placeholderTextColor={colors.brandSecondary}
            style={[styles.searchInput, { color: colors.onSurface }]}
            autoCapitalize="none"
            returnKeyType="search"
          />
          {searchInput.length > 0 && (
            <Pressable testID="search-clear" onPress={() => setSearchInput("")} hitSlop={8}>
              <Feather name="x" size={16} color={colors.brandSecondary} />
            </Pressable>
          )}
        </View>
        <Pressable
          testID="open-filters"
          onPress={openFilters}
          style={[
            styles.filterBtn,
            {
              borderColor: activeFilterCount ? colors.brand : colors.border,
              backgroundColor: activeFilterCount ? colors.brand : colors.surfaceSecondary,
            },
          ]}
        >
          <Feather name="sliders" size={16} color={activeFilterCount ? colors.onBrand : colors.brandSecondary} />
          {activeFilterCount > 0 && (
            <View style={[styles.badge, { backgroundColor: colors.onBrand }]}>
              <Text style={{ fontSize: 10, fontWeight: "800", color: colors.brand }}>{activeFilterCount}</Text>
            </View>
          )}
        </Pressable>
      </View>

      {/* Active filter chips + count */}
      <View style={[styles.metaRow, { paddingHorizontal: spacing.lg }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.activeChips}>
          {activeChips.map((c) => (
            <Pressable
              key={c.key}
              testID={`active-${c.key}`}
              onPress={() => removeChip(c.key)}
              style={[styles.activeChip, { borderColor: colors.brand }]}
            >
              <Text style={{ color: colors.onSurface, fontSize: 12, fontWeight: "700" }}>{c.label}</Text>
              <Feather name="x" size={13} color={colors.onSurface} />
            </Pressable>
          ))}
        </ScrollView>
        <Text style={[styles.resultText, { color: colors.brandSecondary }]}>
          {loading ? "…" : `${total} ürün`}
        </Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.onSurface, fontSize: fontSize.lg, fontWeight: "600" }}>
            Ürünler yüklenemedi.
          </Text>
          <Pressable testID="retry" onPress={() => load("initial")} style={[styles.retry, { backgroundColor: colors.brand }]}>
            <Text style={{ color: colors.onBrand, fontWeight: "700" }}>Tekrar Dene</Text>
          </Pressable>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Feather name="search" size={40} color={colors.borderStrong} />
          <Text style={{ color: colors.onSurfaceSecondary, marginTop: 12 }}>Ürün bulunamadı.</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          testID="product-grid"
          keyExtractor={(p) => p.product_id}
          numColumns={2}
          renderItem={({ item }) => <ProductCard product={item} />}
          columnWrapperStyle={{ paddingHorizontal: spacing.lg, gap: 12 }}
          contentContainerStyle={{ paddingTop: 6, paddingBottom: insets.bottom + 90, gap: 22 }}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load("refresh")} tintColor={colors.brand} />
          }
          ListFooterComponent={
            loadingMore ? <ActivityIndicator color={colors.brand} style={{ marginVertical: 20 }} /> : null
          }
        />
      )}

      {/* Filter modal */}
      <Modal visible={filterVisible} animationType="slide" transparent onRequestClose={() => setFilterVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.onSurface }]}>Filtrele</Text>
              <Pressable onPress={() => setFilterVisible(false)} hitSlop={10}>
                <Feather name="x" size={22} color={colors.onSurface} />
              </Pressable>
            </View>

            <ScrollView style={{ maxHeight: 460 }} showsVerticalScrollIndicator={false}>
              {/* Department */}
              {filterOptions && filterOptions.departments.length > 0 && (
                <FilterSection title="Departman">
                  <ChipRow
                    options={filterOptions.departments}
                    selected={draftDepartment}
                    onSelect={(v) => setDraftDepartment(draftDepartment === v ? undefined : v)}
                    colors={colors}
                  />
                </FilterSection>
              )}

              {/* Category */}
              {filterOptions && filterOptions.categories.length > 0 && (
                <FilterSection title="Kategori">
                  <ChipRow
                    options={filterOptions.categories}
                    selected={draftCategory}
                    onSelect={(v) => setDraftCategory(draftCategory === v ? undefined : v)}
                    colors={colors}
                  />
                </FilterSection>
              )}

              {/* Origin */}
              {filterOptions && filterOptions.origins.length > 0 && (
                <FilterSection title="Üretim Yeri">
                  <ChipRow
                    options={filterOptions.origins}
                    selected={draftOrigin}
                    onSelect={(v) => setDraftOrigin(draftOrigin === v ? undefined : v)}
                    colors={colors}
                  />
                </FilterSection>
              )}

              {/* Price range */}
              <FilterSection title="Fiyat Aralığı">
                <View style={styles.priceRow}>
                  <TextInput
                    value={draftMin}
                    onChangeText={setDraftMin}
                    placeholder="Min"
                    placeholderTextColor={colors.brandSecondary}
                    keyboardType="numeric"
                    style={[styles.priceInput, { borderColor: colors.border, color: colors.onSurface }]}
                  />
                  <Text style={{ color: colors.brandSecondary }}>—</Text>
                  <TextInput
                    value={draftMax}
                    onChangeText={setDraftMax}
                    placeholder="Max"
                    placeholderTextColor={colors.brandSecondary}
                    keyboardType="numeric"
                    style={[styles.priceInput, { borderColor: colors.border, color: colors.onSurface }]}
                  />
                </View>
              </FilterSection>

              {/* Sort */}
              <FilterSection title="Sıralama">
                <ChipRow
                  options={SORT_OPTIONS.map((s) => s.label)}
                  selected={SORT_OPTIONS.find((s) => s.key === draftSort)?.label}
                  onSelect={(label) => {
                    const found = SORT_OPTIONS.find((s) => s.label === label);
                    setDraftSort(draftSort === found?.key ? undefined : found?.key);
                  }}
                  colors={colors}
                />
              </FilterSection>
            </ScrollView>

            <View style={styles.modalActions}>
              <Pressable
                testID="filters-reset"
                onPress={resetFilters}
                style={[styles.resetBtn, { borderColor: colors.border }]}
              >
                <Text style={{ color: colors.onSurface, fontWeight: "700" }}>Temizle</Text>
              </Pressable>
              <Pressable
                testID="filters-apply"
                onPress={applyFilters}
                style={[styles.applyBtn, { backgroundColor: colors.brand }]}
              >
                <Text style={{ color: colors.onBrand, fontWeight: "800" }}>Uygula</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ marginBottom: 22 }}>
      <Text style={[styles.sectionTitle, { color: colors.brandSecondary }]}>{title}</Text>
      {children}
    </View>
  );
}

function ChipRow({
  options,
  selected,
  onSelect,
  colors,
}: {
  options: string[];
  selected?: string;
  onSelect: (v: string) => void;
  colors: any;
}) {
  return (
    <View style={styles.chipWrap}>
      {options.map((opt) => {
        const active = opt === selected;
        return (
          <Pressable
            key={opt}
            onPress={() => onSelect(opt)}
            style={[
              styles.optionChip,
              {
                backgroundColor: active ? colors.brand : colors.surfaceSecondary,
                borderColor: active ? colors.brand : colors.border,
              },
            ]}
          >
            <Text style={{ color: active ? colors.onBrand : colors.onSurface, fontSize: 12, fontWeight: "700" }}>
              {opt}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  searchWrap: { marginTop: 10, marginBottom: 10, flexDirection: "row", gap: 8, alignItems: "center" },
  backBtn: { paddingRight: 2 },
  search: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    height: 46,
    borderRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 12,
    gap: 8,
  },
  searchInput: { flex: 1, fontSize: 14 },
  filterBtn: {
    width: 46,
    height: 46,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    top: -6,
    right: -6,
    minWidth: 18,
    height: 18,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 30,
    marginBottom: 6,
  },
  activeChips: { flexDirection: "row", flex: 1 },
  activeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    height: 30,
    marginRight: 8,
  },
  resultText: { fontSize: 12, letterSpacing: 0.4, fontWeight: "600", marginLeft: 8 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  retry: { marginTop: 16, paddingHorizontal: 20, height: 44, borderRadius: 4, alignItems: "center", justifyContent: "center" },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  modalSheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 18,
    maxHeight: "85%",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 18,
  },
  modalTitle: { fontSize: 18, fontWeight: "800" },
  sectionTitle: { fontSize: 11, fontWeight: "700", letterSpacing: 1.2, marginBottom: 10, textTransform: "uppercase" },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  optionChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  priceRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  priceInput: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  modalActions: { flexDirection: "row", gap: 12, marginTop: 18 },
  resetBtn: {
    flex: 1,
    height: 50,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  applyBtn: {
    flex: 2,
    height: 50,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
});
