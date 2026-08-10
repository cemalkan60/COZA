import React, { useCallback, useEffect, useMemo, useState } from "react";
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
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api, Product } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { ProductCard } from "@/src/components/ProductCard";

const LIMIT = 24;

export default function Catalog() {
  const { colors, spacing, fontSize } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ category?: string; origin?: string }>();

  const category = params.category || undefined;
  const origin = params.origin || undefined;

  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const query = useMemo(
    () => ({ category, origin, q: q || undefined }),
    [category, origin, q],
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
    category ? { key: "category", label: category } : null,
    origin ? { key: "origin", label: origin } : null,
  ].filter(Boolean) as { key: string; label: string }[];

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Comprehensive search */}
      <View style={[styles.searchWrap, { paddingHorizontal: spacing.lg }]}>
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
      </View>

      {/* Active filter chips (from drawer) + count */}
      <View style={[styles.metaRow, { paddingHorizontal: spacing.lg }]}>
        <View style={styles.activeChips}>
          {activeChips.map((c) => (
            <Pressable
              key={c.key}
              testID={`active-${c.key}`}
              onPress={() => router.setParams({ [c.key]: "" } as any)}
              style={[styles.activeChip, { borderColor: colors.brand }]}
            >
              <Text style={{ color: colors.onSurface, fontSize: 12, fontWeight: "700" }}>{c.label}</Text>
              <Feather name="x" size={13} color={colors.onSurface} />
            </Pressable>
          ))}
        </View>
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
    </View>
  );
}

const styles = StyleSheet.create({
  searchWrap: { marginTop: 10, marginBottom: 10 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    height: 46,
    borderRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 12,
    gap: 8,
  },
  searchInput: { flex: 1, fontSize: 14 },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 30,
    marginBottom: 6,
  },
  activeChips: { flexDirection: "row", gap: 8, flex: 1, flexWrap: "wrap" },
  activeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    height: 30,
  },
  resultText: { fontSize: 12, letterSpacing: 0.4, fontWeight: "600", marginLeft: 8 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  retry: { marginTop: 16, paddingHorizontal: 20, height: 44, borderRadius: 4, alignItems: "center", justifyContent: "center" },
});
