import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
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
  origin_distribution: Datum[];
  category_distribution: Datum[];
  last_scrape: string | null;
};

export default function AnalyticsScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();

  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [manQuery, setManQuery] = useState("");
  const [manufacturers, setManufacturers] = useState<{ code: string; count: number }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [manData, setManData] = useState<any>(null);
  const [manLoading, setManLoading] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    try {
      const [a, m] = await Promise.all([api.analytics(), api.manufacturers()]);
      setData(a);
      setManufacturers(m.items || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const m = await api.manufacturers(manQuery.trim() || undefined);
        setManufacturers(m.items || []);
      } catch {
        /* ignore */
      }
    }, 350);
    return () => clearTimeout(t);
  }, [manQuery]);

  const selectCode = async (code: string) => {
    setSelected(code);
    setManLoading(true);
    try {
      setManData(await api.manufacturerAnalytics(code));
    } catch {
      setManData(null);
    } finally {
      setManLoading(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }
  if (!data) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <Text style={{ color: colors.onSurfaceSecondary }}>Veri yok.</Text>
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
      contentContainerStyle={{ paddingTop: 10, paddingBottom: 120 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.brand} />}
    >
      {/* ---- Manufacturer analysis ---- */}
      <View style={{ paddingHorizontal: spacing.xl }}>
        <Text style={[styles.sectionTitle, { color: colors.onSurface }]}>Üretici Analizi</Text>
        <Text style={[styles.helper, { color: colors.brandSecondary }]}>
          Bir üretici kodunun nerede, ne ürettiğini inceleyin.
        </Text>
        <View style={[styles.search, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}>
          <Feather name="search" size={16} color={colors.brandSecondary} />
          <TextInput
            testID="manufacturer-search"
            value={manQuery}
            onChangeText={setManQuery}
            placeholder="Üretici kodu (örn. 5216)"
            placeholderTextColor={colors.brandSecondary}
            keyboardType="number-pad"
            style={{ flex: 1, marginLeft: 8, color: colors.onSurface, fontSize: 14 }}
          />
        </View>
      </View>

      <FlatList
        data={manufacturers}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(m) => m.code}
        contentContainerStyle={{ paddingHorizontal: spacing.xl, gap: 8, paddingVertical: 12 }}
        renderItem={({ item }) => {
          const active = selected === item.code;
          return (
            <Pressable
              testID={`man-chip-${item.code}`}
              onPress={() => selectCode(item.code)}
              style={[
                styles.manChip,
                { borderColor: active ? colors.brand : colors.border, backgroundColor: active ? colors.brand : "transparent" },
              ]}
            >
              <Text style={{ color: active ? colors.onBrand : colors.onSurface, fontWeight: "700", fontSize: 13 }}>
                #{item.code}
              </Text>
              <Text style={{ color: active ? colors.onBrand : colors.brandSecondary, fontSize: 11, marginLeft: 6 }}>
                {item.count}
              </Text>
            </Pressable>
          );
        }}
      />

      {selected && (
        <View style={{ paddingHorizontal: spacing.xl, marginBottom: 8 }}>
          {manLoading ? (
            <ActivityIndicator color={colors.brand} style={{ marginVertical: 20 }} />
          ) : manData ? (
            <View style={[styles.manCard, { borderColor: colors.border }]}>
              <View style={styles.manHead}>
                <Text style={[styles.manCode, { color: colors.onSurface }]}>#{manData.code}</Text>
                <Pressable testID="man-open-factory" onPress={() => router.push(`/factory/${manData.code}`)}>
                  <Text style={{ color: colors.brand, fontWeight: "700", fontSize: 12 }}>Ürünleri gör ›</Text>
                </Pressable>
              </View>
              <View style={styles.manKpis}>
                <Kpi label="ÜRÜN" value={String(manData.total)} />
                <Kpi label="ÜRETİM YERİ" value={manData.primary_origin} />
                <Kpi label="ORT. FİYAT" value={formatPrice(manData.avg_price, "€")} />
              </View>
              {manData.origin_distribution?.length > 0 && (
                <>
                  <Text style={[styles.miniTitle, { color: colors.brandSecondary }]}>ÜRETİM YERİ</Text>
                  <DonutChart data={manData.origin_distribution} total={manData.total} centerValue={String(manData.total)} centerLabel="ürün" />
                </>
              )}
              <Text style={[styles.miniTitle, { color: colors.brandSecondary, marginTop: 20 }]}>KATEGORİ</Text>
              <BarChart data={manData.category_distribution.slice(0, 8)} />
            </View>
          ) : (
            <Text style={{ color: colors.brandSecondary }}>Bu koda ait veri yok.</Text>
          )}
        </View>
      )}

      {/* ---- General overview ---- */}
      <View style={{ paddingHorizontal: spacing.xl, marginTop: 20 }}>
        <Text style={[styles.sectionTitle, { color: colors.onSurface }]}>Genel Bakış</Text>
      </View>
      <View style={[styles.kpiGrid, { paddingHorizontal: spacing.xl }]}>
        <Kpi label="TOPLAM ÜRÜN" value={String(data.total_products)} />
        <Kpi label="ÜRETİM YERİ" value={String(data.origin_count)} />
        <Kpi label="ÜRETİCİ KODU" value={String(data.supplier_count)} />
        <Kpi label="ORT. FİYAT" value={formatPrice(data.avg_price, "€")} />
      </View>

      <Section title="ÜRETİM YERİ DAĞILIMI" colors={colors} spacing={spacing}>
        <DonutChart data={data.origin_distribution.slice(0, 10)} total={data.total_products} centerLabel="ürün" centerValue={String(data.total_products)} />
      </Section>
      <Section title="KATEGORİ DAĞILIMI" colors={colors} spacing={spacing}>
        <BarChart data={data.category_distribution.slice(0, 10)} />
      </Section>

      <View style={[styles.note, { backgroundColor: colors.surfaceSecondary, marginHorizontal: spacing.xl }]}>
        <Feather name="info" size={15} color={colors.brandSecondary} />
        <Text style={[styles.noteText, { color: colors.brandSecondary }]}>
          Üretim yeri bilgileri zara.com/es üzerinden gerçek "Made in" verisiyle alınmıştır.
          Son güncelleme: {formatDate(data.last_scrape)}
        </Text>
      </View>
    </ScrollView>
  );
}

function Section({ title, children, colors, spacing }: React.PropsWithChildren<{ title: string; colors: any; spacing: any }>) {
  return (
    <View style={{ paddingHorizontal: spacing.xl, marginTop: 30 }}>
      <Text style={{ color: colors.brandSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 1.4, marginBottom: 20 }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  sectionTitle: { fontSize: 22, fontWeight: "800", letterSpacing: -0.4 },
  helper: { fontSize: 12, marginTop: 4, marginBottom: 14 },
  search: { flexDirection: "row", alignItems: "center", height: 46, borderRadius: 4, borderWidth: 1, paddingHorizontal: 12 },
  manChip: { flexDirection: "row", alignItems: "center", height: 38, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1 },
  manCard: { borderWidth: 1, borderRadius: 6, padding: 16 },
  manHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
  manCode: { fontSize: 24, fontWeight: "800" },
  manKpis: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 18 },
  miniTitle: { fontSize: 10, letterSpacing: 1.2, fontWeight: "700", marginBottom: 14 },
  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 16 },
  kpi: { minWidth: "30%", flexGrow: 1, borderWidth: 1, borderRadius: 4, paddingVertical: 14, paddingHorizontal: 12 },
  kpiValue: { fontSize: 16, fontWeight: "800", letterSpacing: -0.3 },
  kpiLabel: { fontSize: 9, letterSpacing: 1, fontWeight: "700", marginTop: 6 },
  note: { flexDirection: "row", gap: 10, padding: 14, borderRadius: 4, marginTop: 30 },
  noteText: { flex: 1, fontSize: 11, lineHeight: 17 },
});
