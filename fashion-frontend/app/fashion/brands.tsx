// frontend/app/fashion/brands.tsx — C1: A–Z brand index.
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, SectionList, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useT } from "@/src/i18n";
import { fashionImageUri } from "@/src/utils/fashionImage";
import { goBack } from "@/src/utils/nav";
import RetryImage from "@/src/components/RetryImage";

type BrandRow = { name: string; count: number; cover: string | null };

export default function Brands() {
  const { colors, spacing } = useTheme();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [items, setItems] = useState<BrandRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  useEffect(() => {
    api
      .fashionBrands()
      .then((r) => setItems(r.items || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  const sections = useMemo(() => {
    const query = q.trim().toLowerCase();
    const filtered = query ? items.filter((b) => b.name.toLowerCase().includes(query)) : items;
    const byLetter: Record<string, BrandRow[]> = {};
    filtered.forEach((b) => {
      const letter = (b.name[0] || "#").toUpperCase();
      (byLetter[letter] ||= []).push(b);
    });
    return Object.keys(byLetter)
      .sort()
      .map((letter) => ({ title: letter, data: byLetter[letter] }));
  }, [items, q]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <View style={[styles.header, { paddingTop: insets.top + 8, paddingHorizontal: spacing.xl, borderBottomColor: colors.divider }]}>
        <Pressable testID="brands-back" onPress={() => goBack(router, "/fashion")} hitSlop={10}>
          <Feather name="chevron-left" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={[styles.title, { color: colors.onSurface }]}>{t("brands.title")}</Text>
        <View style={{ width: 26 }} />
      </View>

      <View style={{ paddingHorizontal: spacing.xl, paddingTop: 10, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
        <View style={[styles.searchBar, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}>
          <Feather name="search" size={16} color={colors.brandSecondary} />
          <TextInput
            testID="brands-search"
            value={q}
            onChangeText={setQ}
            placeholder={t("brands.searchPlaceholder")}
            placeholderTextColor={colors.brandSecondary}
            style={{ flex: 1, color: colors.onSurface, fontSize: 14, paddingVertical: 8 }}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.name}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          stickySectionHeadersEnabled
          renderSectionHeader={({ section }) => (
            <View style={[styles.sectionHeader, { backgroundColor: colors.surface }]}>
              <Text style={{ color: colors.brand, fontWeight: "800", fontSize: 13 }}>{section.title}</Text>
            </View>
          )}
          renderItem={({ item }) => (
            <Pressable
              testID={`brand-row-${item.name}`}
              onPress={() => router.push(`/fashion/house?brand=${encodeURIComponent(item.name)}` as any)}
              style={[styles.row, { paddingHorizontal: spacing.xl, borderBottomColor: colors.divider }]}
            >
              <View style={[styles.cover, { backgroundColor: colors.surfaceTertiary, borderColor: colors.border }]}>
                {item.cover ? (
                  <RetryImage uri={fashionImageUri(item.cover)} style={{ width: "100%", height: "100%" }} contentFit="cover" />
                ) : (
                  <Feather name="image" size={16} color={colors.brandSecondary} />
                )}
              </View>
              <Text numberOfLines={1} style={{ flex: 1, color: colors.onSurface, fontWeight: "700", fontSize: 14, marginLeft: 12 }}>
                {item.name}
              </Text>
              <Text style={{ color: colors.brandSecondary, fontSize: 12 }}>{item.count}</Text>
            </Pressable>
          )}
          ListEmptyComponent={
            <Text style={{ color: colors.brandSecondary, textAlign: "center", marginTop: 40 }}>{t("brands.empty")}</Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingBottom: 12, borderBottomWidth: 1 },
  title: { fontSize: 18, fontWeight: "800" },
  searchBar: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12 },
  sectionHeader: { paddingHorizontal: 20, paddingVertical: 6 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: 1 },
  cover: { width: 36, height: 44, borderRadius: 4, overflow: "hidden", borderWidth: 1, alignItems: "center", justifyContent: "center" },
});
