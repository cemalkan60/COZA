import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";

import { api, Product } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useFavorites } from "@/src/context/FavoritesContext";
import { ProductCard } from "@/src/components/ProductCard";

const EMPTY_IMG =
  "https://images.unsplash.com/photo-1548768041-2fceab4c0b85?crop=entropy&cs=srgb&fm=jpg&w=800&q=80";

export default function Favorites() {
  const { colors, spacing, fontSize } = useTheme();
  const insets = useSafeAreaInsets();
  const { ids, refresh } = useFavorites();
  const [items, setItems] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      await refresh();
      const data = await api.favorites();
      setItems(data.items);
    } catch {
      // ignore
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const visible = items.filter((p) => ids.has(p.product_id));

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: spacing.xl, marginBottom: 12 }}>
        <Text style={[styles.eyebrow, { color: colors.brandSecondary }]}>KAYITLI</Text>
        <Text style={[styles.title, { color: colors.onSurface }]}>Favoriler</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : visible.length === 0 ? (
        <View style={styles.center}>
          <Image source={{ uri: EMPTY_IMG }} style={styles.emptyImg} contentFit="cover" />
          <Text style={{ color: colors.onSurface, fontSize: fontSize.lg, fontWeight: "700", marginTop: 20 }}>
            Henüz favori yok
          </Text>
          <Text style={{ color: colors.brandSecondary, marginTop: 8, textAlign: "center" }}>
            Katalogdan beğendiğiniz ürünleri{"\n"}kalp simgesiyle kaydedin.
          </Text>
        </View>
      ) : (
        <FlatList
          data={visible}
          testID="favorites-grid"
          keyExtractor={(p) => p.product_id}
          numColumns={2}
          renderItem={({ item }) => <ProductCard product={item} />}
          columnWrapperStyle={{ paddingHorizontal: spacing.lg, gap: 12 }}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24, gap: 22 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.brand} />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  eyebrow: { fontSize: 10, letterSpacing: 1.6, fontWeight: "700", marginTop: 4 },
  title: { fontSize: 28, fontWeight: "800", letterSpacing: -0.6, marginTop: 6 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  emptyImg: { width: 140, height: 140, borderRadius: 4 },
});
