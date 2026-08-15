import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
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
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { DonutChart, BarChart, Datum } from "@/src/components/Charts";
import { formatPrice, formatDate } from "@/src/utils/format";

type Analytics = {
  total_products: number;
  supplier_count: number;
  manufacturer_count: number;
  manufacturer_breakdown: { code: string; count: number }[];
  origin_count: number;
  category_count: number;
  avg_price: number;
  origin_distribution: Datum[];
  category_distribution: Datum[];
  last_scrape: string | null;
};

type FilterOptions = {
  categories: string[];
  departments: string[];
  families: string[];
  origins: string[];
};

type SelectedFilters = { family?: string; origin?: string; category?: string };

export default function AnalyticsScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [options, setOptions] = useState<FilterOptions | null>(null);
  const [filters, setFilters] = useState<SelectedFilters>({});
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Filter modal (draft state applied on "Uygula")
  const [filterVisible, setFilterVisible] = useState(false);
  const [draft, setDraft] = useState<SelectedFilters>({});

  // Manufacturer breakdown search + selected detail
  const [manQuery, setManQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [manData, setManData] = useState<any>(null);
  const [manLoading, setManLoading] = useState(false);

  const loadOptions = useCallback(async () => {
    try {
      const f = await api.filters();
      setOptions({
        categories: f.categories || [],
        departments: f.departments || [],
        families: f.families || [],
        origins: f.origins || [],
      });
    } catch {
      /* ignore */
    }
  }, []);

  const load = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      try {
        const a = await api.analytics(filters);
        setData(a);
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [filters],
  );

  useEffect(() => {
    loadOptions();
  }, [loadOptions]);

  useEffect(() => {
    setLoading(true);
    // Filtre değişince seçili üretici detayını sıfırla.
    setSelected(null);
    setManData(null);
    load();
  }, [load]);

  const openFilters = () => {
    setDraft(filters);
    setFilterVisible(true);
  };
  const applyFilters = () => {
    setFilters(draft);
    setFilterVisible(false);
  };
  const resetDraft = () => setDraft({});

  const selectCode = async (code: string) => {
    if (selected === code) {
      setSelected(null);
      setManData(null);
      return;
    }
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

  const activeChips = [
    filters.family ? { key: "family", label: filters.family } : null,
    filters.origin ? { key: "origin", label: filters.origin } : null,
    filters.category ? { key: "category", label: filters.category } : null,
  ].filter(Boolean) as { key: string; label: string }[];
  const activeCount = activeChips.length;

  const removeChip = (key: string) => setFilters((f) => ({ ...f, [key]: undefined }));

  const breakdown = useMemo(() => {
    const list = data?.manufacturer_breakdown || [];
    const q = manQuery.trim();
    return q ? list.filter((m) => m.code.startsWith(q)) : list;
  }, [data, manQuery]);

  const Kpi = ({ label, value }: { label: string; value: string }) => (
    <View style={[styles.kpi, { borderColor: colors.border }]}>
      <Text style={[styles.kpiValue, { color: colors.onSurface }]}>{value}</Text>
      <Text style={[styles.kpiLabel, { color: colors.brandSecondary }]}>{label}</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Header + filter button */}
      <View style={[styles.header, { paddingHorizontal: spacing.xl }]}>
        <Pressable
          testID="analytics-back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/hub"))}
          hitSlop={10}
          style={styles.backBtn}
        >
          <Feather name="chevron-left" size={26} color={colors.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.onSurface }]}>Analiz</Text>
          <Text style={[styles.helper, { color: colors.brandSecondary }]}>
            {activeCount > 0
              ? "Seçtiğiniz filtreye göre anlık analiz."
              : "Filtreleyerek koleksiyon ve ülke bazlı analiz yapın."}
          </Text>
        </View>
        <Pressable
          testID="analytics-open-filters"
          onPress={openFilters}
          style={[
            styles.filterBtn,
            {
              borderColor: activeCount ? colors.brand : colors.border,
              backgroundColor: activeCount ? colors.brand : colors.surfaceSecondary,
            },
          ]}
        >
          <Feather name="sliders" size={16} color={activeCount ? colors.onBrand : colors.brandSecondary} />
          {activeCount > 0 && (
            <View style={[styles.badge, { backgroundColor: colors.onBrand }]}>
              <Text style={{ fontSize: 10, fontWeight: "800", color: colors.brand }}>{activeCount}</Text>
            </View>
          )}
        </Pressable>
      </View>

      {/* Active filter chips */}
      {activeCount > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ maxHeight: 42 }}
          contentContainerStyle={{ paddingHorizontal: spacing.xl, gap: 8, paddingBottom: 8 }}
        >
          {activeChips.map((c) => (
            <Pressable
              key={c.key}
              testID={`analytics-active-${c.key}`}
              onPress={() => removeChip(c.key)}
              style={[styles.activeChip, { borderColor: colors.brand }]}
            >
              <Text style={{ color: colors.onSurface, fontSize: 12, fontWeight: "700" }}>{c.label}</Text>
              <Feather name="x" size={13} color={colors.onSurface} />
            </Pressable>
          ))}
        </ScrollView>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : !data ? (
        <View style={styles.center}>
          <Text style={{ color: colors.onSurfaceSecondary }}>Veri yok.</Text>
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 120 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.brand} />
          }
        >
          {/* KPIs for the filtered subset */}
          <View style={[styles.kpiGrid, { paddingHorizontal: spacing.xl }]}>
            <Kpi label="TOPLAM ÜRÜN" value={String(data.total_products)} />
            <Kpi label="ÜRETİCİ SAYISI" value={String(data.manufacturer_count)} />
            <Kpi label="ÜRETİM YERİ" value={String(data.origin_count)} />
            <Kpi label="ORT. FİYAT" value={formatPrice(data.avg_price, "€")} />
          </View>

          {data.total_products === 0 ? (
            <View style={{ paddingHorizontal: spacing.xl, marginTop: 30 }}>
              <Text style={{ color: colors.brandSecondary }}>
                Bu filtreye uygun ürün bulunamadı.
              </Text>
            </View>
          ) : (
            <>
              {/* Manufacturer breakdown */}
              <View style={{ paddingHorizontal: spacing.xl, marginTop: 26 }}>
                <Text style={[styles.sectionTitle, { color: colors.onSurface }]}>Üretici Dökümü</Text>
                <Text style={[styles.helper, { color: colors.brandSecondary, marginBottom: 12 }]}>
                  {data.manufacturer_count} üretici kodu. Detay için bir koda dokunun.
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

                <View style={styles.manList}>
                  {breakdown.slice(0, 80).map((m) => {
                    const active = selected === m.code;
                    return (
                      <Pressable
                        key={m.code}
                        testID={`man-chip-${m.code}`}
                        onPress={() => selectCode(m.code)}
                        style={[
                          styles.manChip,
                          {
                            borderColor: active ? colors.brand : colors.border,
                            backgroundColor: active ? colors.brand : "transparent",
                          },
                        ]}
                      >
                        <Text style={{ color: active ? colors.onBrand : colors.onSurface, fontWeight: "700", fontSize: 13 }}>
                          #{m.code}
                        </Text>
                        <Text style={{ color: active ? colors.onBrand : colors.brandSecondary, fontSize: 11, marginLeft: 6 }}>
                          {m.count}
                        </Text>
                      </Pressable>
                    );
                  })}
                  {breakdown.length === 0 && (
                    <Text style={{ color: colors.brandSecondary, fontSize: 13 }}>Eşleşen üretici yok.</Text>
                  )}
                </View>
              </View>

              {/* Selected manufacturer detail */}
              {selected && (
                <View style={{ paddingHorizontal: spacing.xl, marginTop: 14 }}>
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

              {/* Distributions for the filtered subset */}
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
            </>
          )}

          <View style={[styles.note, { backgroundColor: colors.surfaceSecondary, marginHorizontal: spacing.xl }]}>
            <Feather name="info" size={15} color={colors.brandSecondary} />
            <Text style={[styles.noteText, { color: colors.brandSecondary }]}>
              Mağazadan kalktı olarak işaretlenen ürünler analize dahil edilmez.
              Üretim yeri bilgileri zara.com/es üzerinden gerçek "Made in" verisiyle alınmıştır.
              Son güncelleme: {formatDate(data.last_scrape)}
            </Text>
          </View>
        </ScrollView>
      )}

      {/* Filter modal */}
      <Modal visible={filterVisible} animationType="slide" transparent onRequestClose={() => setFilterVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.onSurface }]}>Analizi Filtrele</Text>
              <Pressable onPress={() => setFilterVisible(false)} hitSlop={10}>
                <Feather name="x" size={22} color={colors.onSurface} />
              </Pressable>
            </View>

            <ScrollView style={{ maxHeight: 460 }} showsVerticalScrollIndicator={false}>
              {options && options.families.length > 0 && (
                <FilterSection title="Koleksiyon" colors={colors}>
                  <ChipRow
                    options={options.families}
                    selected={draft.family}
                    onSelect={(v) => setDraft((d) => ({ ...d, family: d.family === v ? undefined : v }))}
                    colors={colors}
                  />
                </FilterSection>
              )}
              {options && options.origins.length > 0 && (
                <FilterSection title="Üretim Yeri / Ülke" colors={colors}>
                  <ChipRow
                    options={options.origins}
                    selected={draft.origin}
                    onSelect={(v) => setDraft((d) => ({ ...d, origin: d.origin === v ? undefined : v }))}
                    colors={colors}
                  />
                </FilterSection>
              )}
              {options && options.categories.length > 0 && (
                <FilterSection title="Kategori" colors={colors}>
                  <ChipRow
                    options={options.categories}
                    selected={draft.category}
                    onSelect={(v) => setDraft((d) => ({ ...d, category: d.category === v ? undefined : v }))}
                    colors={colors}
                  />
                </FilterSection>
              )}
            </ScrollView>

            <View style={styles.modalActions}>
              <Pressable
                testID="analytics-filters-reset"
                onPress={resetDraft}
                style={[styles.resetBtn, { borderColor: colors.border }]}
              >
                <Text style={{ color: colors.onSurface, fontWeight: "700" }}>Temizle</Text>
              </Pressable>
              <Pressable
                testID="analytics-filters-apply"
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

function FilterSection({ title, children, colors }: React.PropsWithChildren<{ title: string; colors: any }>) {
  return (
    <View style={{ marginBottom: 22 }}>
      <Text style={[styles.filterSectionTitle, { color: colors.brandSecondary }]}>{title}</Text>
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
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 12, paddingBottom: 8 },
  backBtn: { paddingRight: 2 },
  title: { fontSize: 24, fontWeight: "800", letterSpacing: -0.4 },
  helper: { fontSize: 12, marginTop: 4 },
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
  activeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    height: 30,
  },
  sectionTitle: { fontSize: 20, fontWeight: "800", letterSpacing: -0.3 },
  search: { flexDirection: "row", alignItems: "center", height: 46, borderRadius: 4, borderWidth: 1, paddingHorizontal: 12 },
  manList: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 },
  manChip: { flexDirection: "row", alignItems: "center", height: 38, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1 },
  manCard: { borderWidth: 1, borderRadius: 6, padding: 16 },
  manHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
  manCode: { fontSize: 24, fontWeight: "800" },
  manKpis: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 18 },
  miniTitle: { fontSize: 10, letterSpacing: 1.2, fontWeight: "700", marginBottom: 14 },
  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 8 },
  kpi: { minWidth: "30%", flexGrow: 1, borderWidth: 1, borderRadius: 4, paddingVertical: 14, paddingHorizontal: 12 },
  kpiValue: { fontSize: 16, fontWeight: "800", letterSpacing: -0.3 },
  kpiLabel: { fontSize: 9, letterSpacing: 1, fontWeight: "700", marginTop: 6 },
  note: { flexDirection: "row", gap: 10, padding: 14, borderRadius: 4, marginTop: 30 },
  noteText: { flex: 1, fontSize: 11, lineHeight: 17 },
  // Filter modal
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  modalSheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 18,
    maxHeight: "85%",
  },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 18 },
  modalTitle: { fontSize: 18, fontWeight: "800" },
  filterSectionTitle: { fontSize: 11, fontWeight: "700", letterSpacing: 1.2, marginBottom: 10, textTransform: "uppercase" },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  optionChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  modalActions: { flexDirection: "row", gap: 12, marginTop: 18 },
  resetBtn: { flex: 1, height: 50, borderRadius: 4, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  applyBtn: { flex: 2, height: 50, borderRadius: 4, alignItems: "center", justifyContent: "center" },
});
