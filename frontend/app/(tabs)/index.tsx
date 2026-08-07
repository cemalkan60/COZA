import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { BottomSheetModal } from "@gorhom/bottom-sheet";
import { useFocusEffect } from "expo-router";
import * as Haptics from "expo-haptics";

import { api, Product } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { ProductCard } from "@/src/components/ProductCard";
import { FilterSheet, Filters, PRICE_RANGES } from "@/src/components/FilterSheet";
import { Logo } from "@/src/components/Logo";

const LIMIT = 24;

export default function Catalog() {
  const { colors, spacing, fontSize } = useTheme();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);

  const [categories, setCategories] = useState<string[]>([]);
  const [origins, setOrigins] = useState<string[]>([]);
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Filters>({ sort: "featured", price: "all" });

  const [items, setItems] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    api
      .filters()
      .then((f) => {
        setCategories(f.categories || []);
        setOrigins(f.origins || []);
      })
      .catch(() => {});
  }, []);

  // Dismiss the filter sheet when leaving this tab so it never overlays other screens.
  useFocusEffect(
    useCallback(() => {
      return () => sheetRef.current?.dismiss();
    }, []),
  );

  // debounce search
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const priceRange = PRICE_RANGES[filters.price ?? "all"] || {};

  const query = useMemo(
    () => ({
      category,
      origin: filters.origin,
      supplier: filters.supplier,
      q: q || undefined,
      sort: filters.sort,
      min_price: priceRange.min,
      max_price: priceRange.max,
    }),
    [category, filters, q, priceRange.min, priceRange.max],
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
      // ignore
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, loading, items.length, total, query]);

  const activeFilterCount =
    (filters.origin ? 1 : 0) +
    (filters.supplier ? 1 : 0) +
    (filters.sort !== "featured" ? 1 : 0) +
    (filters.price && filters.price !== "all" ? 1 : 0);

  const chips = ["Tümü", ...categories];

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface, paddingTop: insets.top }}>
      {/* Sticky header: logo (→ home) + search toggle */}
      <View style={[styles.header, { paddingHorizontal: spacing.lg }]}>
        <Logo size={22} home />
        <Pressable
          testID="toggle-search"
          onPress={() => setSearchOpen((s) => !s)}
          style={[styles.iconBtn, { borderColor: colors.border }]}
        >
          <Feather name={searchOpen ? "x" : "search"} size={17} color={colors.onSurface} />
        </Pressable>
      </View>

      {searchOpen && (
        <View style={[styles.searchWrap, { paddingHorizontal: spacing.lg }]}>
          <View style={[styles.search, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}>
            <Feather name="search" size={16} color={colors.brandSecondary} />
            <TextInput
              testID="search-input"
              value={searchInput}
              onChangeText={setSearchInput}
              placeholder="Ürün veya üretici kodu (örn. 8497)"
              placeholderTextColor={colors.brandSecondary}
              style={[styles.searchInput, { color: colors.onSurface }]}
              autoCapitalize="none"
              autoFocus
              returnKeyType="search"
            />
            {searchInput.length > 0 && (
              <Pressable testID="search-clear" onPress={() => setSearchInput("")} hitSlop={8}>
                <Feather name="x" size={16} color={colors.brandSecondary} />
              </Pressable>
            )}
          </View>
        </View>
      )}

      {/* Controls: filter on the LEFT + result count on the right */}
      <View style={[styles.controls, { paddingHorizontal: spacing.lg }]}>
        <Pressable
          testID="open-filters"
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            sheetRef.current?.present();
          }}
          style={[styles.filterPill, { borderColor: activeFilterCount ? colors.brand : colors.border }]}
        >
          <Feather name="sliders" size={15} color={colors.onSurface} />
          <Text style={[styles.filterPillText, { color: colors.onSurface }]}>Filtrele</Text>
          {activeFilterCount > 0 && (
            <View style={[styles.badgeInline, { backgroundColor: colors.brand }]}>
              <Text style={[styles.badgeText, { color: colors.onBrand }]}>{activeFilterCount}</Text>
            </View>
          )}
        </Pressable>
        <Text style={[styles.resultText, { color: colors.brandSecondary }]}>
          {loading ? "…" : `${total} ürün${category ? " · " + category : ""}`}
        </Text>
      </View>

      {/* Category chips — single horizontal scroller */}
      <View style={styles.chipRow}>
        <FlatList
          data={chips}
          horizontal
          showsHorizontalScrollIndicator={false}
          keyExtractor={(c) => c}
          contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: 8, alignItems: "center" }}
          renderItem={({ item }) => {
            const active = item === "Tümü" ? !category : category === item;
            return (
              <Pressable
                testID={`category-chip-${item}`}
                onPress={() => {
                  Haptics.selectionAsync();
                  setCategory(item === "Tümü" ? undefined : item);
                }}
                style={[
                  styles.chip,
                  {
                    borderColor: active ? colors.brand : colors.border,
                    backgroundColor: active ? colors.brand : "transparent",
                  },
                ]}
              >
                <Text
                  style={{
                    color: active ? colors.onBrand : colors.onSurfaceSecondary,
                    fontWeight: active ? "700" : "500",
                    fontSize: 13,
                    letterSpacing: 0.2,
                  }}
                >
                  {item}
                </Text>
              </Pressable>
            );
          }}
        />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.onSurface, fontSize: fontSize.lg, fontWeight: "600" }}>
            Ürünler yüklenirken bir hata oluştu.
          </Text>
          <Pressable
            testID="retry"
            onPress={() => load("initial")}
            style={[styles.retry, { backgroundColor: colors.brand }]}
          >
            <Text style={{ color: colors.onBrand, fontWeight: "700" }}>Tekrar Dene</Text>
          </Pressable>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Feather name="search" size={40} color={colors.borderStrong} />
          <Text style={{ color: colors.onSurfaceSecondary, marginTop: 12 }}>
            Henüz ürün bulunamadı.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          testID="product-grid"
          keyExtractor={(p) => p.product_id}
          numColumns={2}
          renderItem={({ item }) => <ProductCard product={item} />}
          columnWrapperStyle={{ paddingHorizontal: spacing.lg, gap: 12 }}
          contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 90, gap: 22 }}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load("refresh")}
              tintColor={colors.brand}
            />
          }
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator color={colors.brand} style={{ marginVertical: 20 }} />
            ) : null
          }
        />
      )}

      <FilterSheet
        ref={sheetRef}
        origins={origins}
        initial={filters}
        onApply={(f) => {
          setFilters(f);
          sheetRef.current?.dismiss();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    height: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
    marginBottom: 6,
  },
  filterPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
  },
  filterPillText: { fontSize: 13, fontWeight: "700", letterSpacing: 0.2 },
  badgeInline: {
    minWidth: 18,
    height: 18,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  badge: {
    position: "absolute",
    top: -5,
    right: -5,
    minWidth: 18,
    height: 18,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  badgeText: { fontSize: 10, fontWeight: "800" },
  searchWrap: { marginTop: 6, marginBottom: 10 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    height: 44,
    borderRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 12,
    gap: 8,
  },
  searchInput: { flex: 1, fontSize: 14 },
  chipRow: { height: 56, justifyContent: "center" },
  chip: {
    height: 36,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  resultRow: { paddingBottom: 4 },
  resultText: { fontSize: 12, letterSpacing: 0.4, fontWeight: "600" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  retry: { marginTop: 16, paddingHorizontal: 20, height: 44, borderRadius: 4, alignItems: "center", justifyContent: "center" },
});
