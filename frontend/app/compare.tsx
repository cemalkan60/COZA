import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api, Product } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useCompare } from "@/src/context/CompareContext";
import { formatPrice } from "@/src/utils/format";

type Row = { label: string; a?: string; b?: string; highlight?: boolean };

export default function Compare() {
  const { colors, spacing, fontSize } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const compare = useCompare();

  const [products, setProducts] = useState<(Product | null)[]>([null, null]);
  const [comps, setComps] = useState<string[]>(["", ""]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [a, b] = await Promise.all(
          compare.ids.slice(0, 2).map((id) => api.product(id)),
        );
        setProducts([a, b]);
        const [ca, cb] = await Promise.all(
          compare.ids.slice(0, 2).map(async (id) => {
            try {
              const r = await api.composition(id);
              return (r.composition || [])
                .map((c: any) => `${c.area}: ${c.materials}`)
                .join("\n");
            } catch {
              return "—";
            }
          }),
        );
        setComps([ca || "—", cb || "—"]);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [a, b] = products;

  const rows: Row[] = [
    { label: "Fiyat", a: a && formatPrice(a.price), b: b && formatPrice(b.price), highlight: true },
    { label: "Üretim Yeri", a: a?.origin, b: b?.origin },
    { label: "Üretici Kodu", a: a && `#${a.manufacturer_code}`, b: b && `#${b.manufacturer_code}` },
    { label: "Tam Kod", a: a?.full_code, b: b?.full_code },
    { label: "Kategori", a: a?.category, b: b?.category },
    { label: "Renk", a: a?.color || "—", b: b?.color || "—" },
    { label: "Kompozisyon", a: comps[0], b: comps[1] },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface, paddingTop: insets.top }}>
      <View style={[styles.header, { paddingHorizontal: spacing.lg }]}>
        <Pressable testID="compare-back" onPress={() => router.back()} hitSlop={8} style={styles.back}>
          <Feather name="chevron-left" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.onSurface }]}>Karşılaştır</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : !a || !b ? (
        <View style={styles.center}>
          <Text style={{ color: colors.onSurfaceSecondary, textAlign: "center" }}>
            Karşılaştırmak için katalogdan 2 ürün seçin.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 30 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Product heads */}
          <View style={styles.heads}>
            {[a, b].map((p, i) => (
              <View key={i} style={styles.headCol}>
                <Image
                  source={{ uri: p!.images[0] }}
                  style={[styles.headImg, { backgroundColor: colors.surfaceSecondary }]}
                  contentFit="cover"
                />
                <Text numberOfLines={2} style={[styles.headName, { color: colors.onSurface }]}>
                  {p!.name}
                </Text>
              </View>
            ))}
          </View>

          {/* Comparison rows */}
          <View style={[styles.table, { borderColor: colors.border }]}>
            {rows.map((r, i) => (
              <View
                key={r.label}
                style={[
                  styles.rowGroup,
                  i < rows.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.divider },
                ]}
              >
                <Text style={[styles.rowLabel, { color: colors.brandSecondary }]}>
                  {r.label.toLocaleUpperCase("tr-TR")}
                </Text>
                <View style={styles.rowValues}>
                  <Text
                    style={[
                      styles.rowVal,
                      { color: colors.onSurface, fontWeight: r.highlight ? "800" : "600" },
                    ]}
                  >
                    {r.a || "—"}
                  </Text>
                  <View style={[styles.vDivider, { backgroundColor: colors.divider }]} />
                  <Text
                    style={[
                      styles.rowVal,
                      { color: colors.onSurface, fontWeight: r.highlight ? "800" : "600" },
                    ]}
                  >
                    {r.b || "—"}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { height: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  back: { width: 40, height: 40, justifyContent: "center" },
  headerTitle: { fontSize: 16, fontWeight: "800", letterSpacing: 0.3 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  heads: { flexDirection: "row", gap: 12, marginBottom: 18 },
  headCol: { flex: 1 },
  headImg: { width: "100%", aspectRatio: 3 / 4, borderRadius: 4 },
  headName: { fontSize: 13, fontWeight: "600", marginTop: 8, lineHeight: 18 },
  table: { borderWidth: 1, borderRadius: 4 },
  rowGroup: { paddingVertical: 14, paddingHorizontal: 14 },
  rowLabel: { fontSize: 10, letterSpacing: 1.2, fontWeight: "700", marginBottom: 8 },
  rowValues: { flexDirection: "row", alignItems: "flex-start" },
  rowVal: { flex: 1, fontSize: 13, lineHeight: 19 },
  vDivider: { width: 1, alignSelf: "stretch", marginHorizontal: 12 },
});
