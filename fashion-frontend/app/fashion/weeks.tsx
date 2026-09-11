// frontend/app/fashion/weeks.tsx — C2/C3: "Moda haftası merkezi", a
// retrospective index of city+season fashion weeks (not a forward-looking
// calendar/countdown — see the note on /fashion/fashion-weeks in server.py).
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useT } from "@/src/i18n";
import { fashionImageUri } from "@/src/utils/fashionImage";
import { goBack } from "@/src/utils/nav";
import RetryImage from "@/src/components/RetryImage";

type Week = { city: string; season: string; season_label: string; count: number; cover: string | null };

export default function FashionWeeks() {
  const { colors, spacing } = useTheme();
  const { t, formatSeason } = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width } = useWindowDimensions();

  const [items, setItems] = useState<Week[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .fashionWeeks()
      .then((r) => setItems(r.items || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  const cols = width >= 900 ? 3 : 2;
  const cardW = (width - spacing.xl * 2 - 12 * (cols - 1)) / cols;

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
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
            {items.map((w) => (
              <Pressable
                key={`${w.city}#${w.season}`}
                testID={`week-${w.city}-${w.season}`}
                onPress={() =>
                  router.push(
                    `/fashion/week?city=${encodeURIComponent(w.city)}&season=${encodeURIComponent(w.season)}` as any,
                  )
                }
                style={{ width: cardW }}
              >
                <View style={[styles.cover, { backgroundColor: colors.surfaceTertiary, borderColor: colors.border }]}>
                  {w.cover ? (
                    <RetryImage uri={fashionImageUri(w.cover)} style={{ width: "100%", height: "100%" }} contentFit="cover" />
                  ) : (
                    <Feather name="image" size={20} color={colors.brandSecondary} />
                  )}
                </View>
                <Text numberOfLines={1} style={{ color: colors.onSurface, fontWeight: "800", fontSize: 14, marginTop: 6 }}>
                  {w.city}
                </Text>
                <Text style={{ color: colors.brandSecondary, fontSize: 12 }}>
                  {formatSeason(w.season, w.season_label)} · {w.count}
                </Text>
              </Pressable>
            ))}
          </View>
          {items.length === 0 && (
            <Text style={{ color: colors.brandSecondary, textAlign: "center", marginTop: 40 }}>{t("weeks.empty")}</Text>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingBottom: 12, borderBottomWidth: 1 },
  title: { fontSize: 18, fontWeight: "800" },
  cover: { width: "100%", aspectRatio: 1, borderRadius: 8, overflow: "hidden", borderWidth: 1, alignItems: "center", justifyContent: "center" },
});
