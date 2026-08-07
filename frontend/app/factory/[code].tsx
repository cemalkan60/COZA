import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api, Product } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { ProductCard } from "@/src/components/ProductCard";

export default function FactoryDetail() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { colors, spacing, fontSize } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [items, setItems] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .products({ code: String(code), limit: 60, sort: "featured" })
      .then((d) => {
        setItems(d.items);
        setTotal(d.total);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [code]);

  const origin = items[0]?.origin;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface, paddingTop: insets.top }}>
      <View style={[styles.header, { paddingHorizontal: spacing.lg }]}>
        <Pressable testID="factory-back" onPress={() => router.back()} hitSlop={8} style={styles.back}>
          <Feather name="chevron-left" size={24} color={colors.onSurface} />
        </Pressable>
      </View>

      <View style={{ paddingHorizontal: spacing.xl, marginBottom: 12 }}>
        <Text style={[styles.eyebrow, { color: colors.brandSecondary }]}>ÜRETİCİ / STİL KODU</Text>
        <Text style={[styles.title, { color: colors.onSurface }]}>#{code}</Text>
        {!loading && (
          <View style={styles.metaRow}>
            <View style={[styles.pill, { borderColor: colors.border }]}>
              <Feather name="package" size={13} color={colors.brandSecondary} />
              <Text style={[styles.pillText, { color: colors.onSurfaceSecondary }]}>{total} ürün</Text>
            </View>
            {origin && (
              <View style={[styles.pill, { borderColor: colors.border }]}>
                <Feather name="map-pin" size={13} color={colors.brandSecondary} />
                <Text style={[styles.pillText, { color: colors.onSurfaceSecondary }]}>{origin}</Text>
              </View>
            )}
          </View>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Text style={{ color: colors.onSurfaceSecondary }}>Bu koda ait ürün bulunamadı.</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          testID="factory-grid"
          keyExtractor={(p) => p.product_id}
          numColumns={2}
          renderItem={({ item }) => <ProductCard product={item} />}
          columnWrapperStyle={{ paddingHorizontal: spacing.lg, gap: 12 }}
          contentContainerStyle={{ paddingBottom: insets.bottom + 30, gap: 22 }}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { height: 48, justifyContent: "center" },
  back: { width: 40, height: 40, justifyContent: "center" },
  eyebrow: { fontSize: 10, letterSpacing: 1.6, fontWeight: "700", marginTop: 2 },
  title: { fontSize: 30, fontWeight: "800", letterSpacing: 0, marginTop: 6 },
  metaRow: { flexDirection: "row", gap: 8, marginTop: 14 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    height: 32,
  },
  pillText: { fontSize: 12, fontWeight: "600" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
});
