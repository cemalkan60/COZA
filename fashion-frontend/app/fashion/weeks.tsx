// frontend/app/fashion/weeks.tsx — C2/C3: the fashion-week CALENDAR
// (city/season/dates, past and upcoming), sourced from nowfashion.com's own
// schedule page — see the note on GET /fashion/fashion-weeks in server.py.
// No photos here on purpose (Cem: "normal koleksiyon çekimi istemiyorum
// sadece tarihler falan olsun") — tapping a row opens nowfashion.com's own
// page for it, since that's the only place with actual show content.
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useT } from "@/src/i18n";
import { goBack } from "@/src/utils/nav";

type WeekEntry = {
  source_id: string;
  city: string;
  category: string | null;
  season: string;
  date_range: string | null;
  collections_count: number | null;
  happening_now: boolean;
  starts_in_days: number | null;
  url: string;
};

const CITY_DOT: Record<string, string> = {
  Paris: "#3B82F6",
  Milan: "#EF4444",
  London: "#22C55E",
  "New York": "#F59E0B",
  "Gran Canaria": "#F59E0B",
};

export default function FashionWeeks() {
  const { colors, spacing } = useTheme();
  const { t, formatSeason } = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [items, setItems] = useState<WeekEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // QA flagged "Henüz moda haftası verisi yok." indistinguishable from a
  // failed request — track which one it actually was.
  const [error, setError] = useState(false);

  const load = () => {
    setLoading(true);
    api
      .fashionWeeks()
      .then((r) => {
        setItems((r.items || []) as WeekEntry[]);
        setError(false);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <View style={[styles.header, { paddingTop: insets.top + 8, paddingHorizontal: spacing.xl, borderBottomColor: colors.divider }]}>
        <Pressable testID="weeks-back" onPress={() => goBack(router, "/fashion")} hitSlop={10}>
          <Feather name="chevron-left" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={[styles.title, { color: colors.onSurface }]}>{t("weeks.title")}</Text>
        <View style={{ width: 26 }} />
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: insets.bottom + 32 }}>
          <Text style={{ color: colors.brandSecondary, fontSize: 12, marginBottom: 16, lineHeight: 17 }}>
            {t("weeks.hint")}
          </Text>
          {items.map((w) => (
            <Pressable
              key={w.source_id}
              testID={`week-${w.source_id}`}
              onPress={() => Linking.openURL(w.url)}
              style={[
                styles.row,
                {
                  borderColor: w.happening_now ? colors.brand : colors.border,
                  backgroundColor: w.happening_now ? colors.surfaceSecondary : "transparent",
                },
              ]}
            >
              <View style={[styles.dot, { backgroundColor: CITY_DOT[w.city] || colors.brandSecondary }]} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.onSurface, fontWeight: "800", fontSize: 15 }}>{w.city}</Text>
                <Text style={{ color: colors.brandSecondary, fontSize: 12, marginTop: 2 }}>
                  {w.category ? `${t(`category.${w.category}`)} · ` : ""}
                  {formatSeason(w.season, w.season)}
                </Text>
                {!!w.date_range && (
                  <Text style={{ color: colors.onSurface, fontSize: 13, fontWeight: "600", marginTop: 4 }}>{w.date_range}</Text>
                )}
                {w.collections_count != null && (
                  <Text style={{ color: colors.brandSecondary, fontSize: 11, marginTop: 2 }}>
                    {t("weeks.collectionsCount", { n: w.collections_count })}
                  </Text>
                )}
              </View>
              <View style={{ alignItems: "flex-end", gap: 6 }}>
                {w.happening_now && (
                  <View style={[styles.badge, { backgroundColor: colors.brand }]}>
                    <Text style={{ color: colors.onBrand, fontSize: 10, fontWeight: "800" }}>{t("weeks.happeningNow")}</Text>
                  </View>
                )}
                {!w.happening_now && w.starts_in_days != null && (
                  <Text style={{ color: colors.brand, fontSize: 11, fontWeight: "700" }}>
                    {t("weeks.startsInDays", { n: w.starts_in_days })}
                  </Text>
                )}
                <Feather name="external-link" size={14} color={colors.brandSecondary} />
              </View>
            </Pressable>
          ))}
          {items.length === 0 && (
            <View style={{ alignItems: "center", marginTop: 40, gap: 10 }}>
              <Text style={{ color: colors.brandSecondary, textAlign: "center" }}>
                {error ? t("feed.loadError") : t("weeks.empty")}
              </Text>
              {error && (
                <Pressable onPress={load} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 18 }}>
                  <Text style={{ color: colors.onSurface, fontWeight: "700" }}>{t("common.retry")}</Text>
                </Pressable>
              )}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingBottom: 12, borderBottomWidth: 1 },
  title: { fontSize: 18, fontWeight: "800" },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 10 },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 5 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
});
