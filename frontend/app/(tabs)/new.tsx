import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api, Product } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { ProductCard } from "@/src/components/ProductCard";

export default function NewArrivals() {
  const { colors, spacing, fontSize } = useTheme();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const data = await api.products({ is_new: true, limit: 60, sort: "featured" });
      setItems(data.items);
      setTotal(data.total);
    } catch {
      // ignore
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface, paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: spacing.xl, marginBottom: 12 }}>
        <Text style={[styles.eyebrow, { color: colors.brandSecondary }]}>SON GÜNCELLEME</Text>
        <Text style={[styles.title, { color: colors.onSurface }]}>Yeni Gelenler</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Feather name="zap" size={40} color={colors.borderStrong} />
          <Text style={{ color: colors.onSurface, fontSize: fontSize.lg, fontWeight: "700", marginTop: 18 }}>
            Yeni ürün yok
          </Text>
          <Text style={{ color: colors.brandSecondary, marginTop: 8, textAlign: "center", lineHeight: 20 }}>
            Katalog her gün 08:00'de güncellenir.{"\n"}Yeni eklenen ürünler burada{"\n"}"YENİ" etiketiyle listelenir.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          testID="new-grid"
          keyExtractor={(p) => p.product_id}
          numColumns={2}
          renderItem={({ item }) => <ProductCard product={item} />}
          columnWrapperStyle={{ paddingHorizontal: spacing.lg, gap: 12 }}
          contentContainerStyle={{ paddingBottom: insets.bottom + 90, gap: 22 }}
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
});
