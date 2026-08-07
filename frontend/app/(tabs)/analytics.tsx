import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { DonutChart, BarChart, Datum } from "@/src/components/Charts";
import { formatPrice, formatDate } from "@/src/utils/format";

type Analytics = {
  total_products: number;
  supplier_count: number;
  origin_count: number;
  category_count: number;
  avg_price: number;
  min_price: number;
  max_price: number;
  origin_distribution: Datum[];
  category_distribution: Datum[];
  last_scrape: string | null;
};

export default function AnalyticsScreen() {
  const { colors, spacing, fontSize } = useTheme();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    try {
      const d = await api.analytics();
      setData(d);
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

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }

  if (!data || data.total_products === 0) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <Text style={{ color: colors.onSurfaceSecondary }}>Görüntülenecek veri yok.</Text>
      </View>
    );
  }

  const Kpi = ({ label, value }: { label: string; value: string }) => (
    <View style={[styles.kpi, { borderColor: colors.border }]}>
      <Text style={[styles.kpiValue, { color: colors.onSurface }]}>{value}</Text>
      <Text style={[styles.kpiLabel, { color: colors.brandSecondary }]}>{label}</Text>
    </View>
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.surface }}
      contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 32 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.brand} />
      }
    >
      <View style={{ paddingHorizontal: spacing.xl }}>
        <Text style={[styles.eyebrow, { color: colors.brandSecondary }]}>TEDARİK · ANALİZ</Text>
        <Text style={[styles.title, { color: colors.onSurface }]}>Tedarik Panosu</Text>
      </View>

      <View style={[styles.kpiGrid, { paddingHorizontal: spacing.xl }]}>
        <Kpi label="TOPLAM ÜRÜN" value={String(data.total_products)} />
        <Kpi label="ÜRETİM YERİ" value={String(data.origin_count)} />
        <Kpi label="TEDARİKÇİ KODU" value={String(data.supplier_count)} />
        <Kpi label="ORT. FİYAT" value={formatPrice(data.avg_price)} />
      </View>

      <Section title="ÜRETİM YERİ DAĞILIMI" colors={colors} spacing={spacing}>
        <DonutChart
          data={data.origin_distribution.slice(0, 10)}
          total={data.total_products}
          centerLabel="ürün"
          centerValue={String(data.total_products)}
        />
      </Section>

      <Section title="KATEGORİ DAĞILIMI" colors={colors} spacing={spacing}>
        <BarChart data={data.category_distribution.slice(0, 10)} />
      </Section>

      <View
        style={[
          styles.note,
          { backgroundColor: colors.surfaceSecondary, marginHorizontal: spacing.xl },
        ]}
      >
        <Feather name="info" size={15} color={colors.brandSecondary} />
        <Text style={[styles.noteText, { color: colors.brandSecondary }]}>
          Üretim yeri, Zara ürün referans kodlarından Inditex kamuya açık tedarik dağılımına göre
          modellenmiştir. Son güncelleme: {formatDate(data.last_scrape)}
        </Text>
      </View>
    </ScrollView>
  );
}

function Section({
  title,
  children,
  colors,
  spacing,
}: React.PropsWithChildren<{ title: string; colors: any; spacing: any }>) {
  return (
    <View style={{ paddingHorizontal: spacing.xl, marginTop: 34 }}>
      <Text
        style={{
          color: colors.brandSecondary,
          fontSize: 11,
          fontWeight: "700",
          letterSpacing: 1.4,
          marginBottom: 20,
        }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  eyebrow: { fontSize: 10, letterSpacing: 1.6, fontWeight: "700", marginTop: 6 },
  title: { fontSize: 28, fontWeight: "800", letterSpacing: -0.6, marginTop: 6 },
  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 22 },
  kpi: {
    width: "47.5%",
    borderWidth: 1,
    borderRadius: 4,
    paddingVertical: 16,
    paddingHorizontal: 14,
  },
  kpiValue: { fontSize: 20, fontWeight: "800", letterSpacing: -0.4 },
  kpiLabel: { fontSize: 10, letterSpacing: 1, fontWeight: "700", marginTop: 6 },
  note: {
    flexDirection: "row",
    gap: 10,
    padding: 14,
    borderRadius: 4,
    marginTop: 34,
  },
  noteText: { flex: 1, fontSize: 11, lineHeight: 17, letterSpacing: 0.2 },
});
