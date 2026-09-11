// frontend/app/fashion/week.tsx — C2/C3 detail: one fashion week (city +
// season), all its collections. Reuses /fashion/collections?city=&season=
// directly (already supported) instead of a new endpoint.
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api, FashionItem } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useT } from "@/src/i18n";
import { fashionImageUri } from "@/src/utils/fashionImage";
import { goBack } from "@/src/utils/nav";
import RetryImage from "@/src/components/RetryImage";

const PAGE_SIZE = 60;

export default function FashionWeek() {
  const { colors, spacing } = useTheme();
  const { t, formatSeason } = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams();
  const city = decodeURIComponent((params.city as string) || "");
  const season = decodeURIComponent((params.season as string) || "");

  const [items, setItems] = useState<FashionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.fashionCollections({ city, season, sort: "newest", limit: PAGE_SIZE });
      setItems(res.items || []);
      setTotal(res.total ?? 0);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [city, season]);

  useEffect(() => {
    load();
  }, [load]);

  const loadMore = async () => {
    if (loadingMore || items.length >= total) return;
    setLoadingMore(true);
    try {
      const res = await api.fashionCollections({ city, season, sort: "newest", limit: PAGE_SIZE, skip: items.length });
      setItems((cur) => [...cur, ...(res.items || [])]);
    } catch {
    } finally {
      setLoadingMore(false);
    }
  };

  const cols = width >= 1200 ? 5 : width >= 900 ? 4 : width >= 600 ? 3 : 2;
  const gap = 12;
  const pad = spacing.xl - 4;
  const cardW = (width - pad * 2 - gap * (cols - 1)) / cols;

  const open = (it: FashionItem) => {
    const title = encodeURIComponent(it.brand_tr || it.title_tr || "");
    const s = encodeURIComponent(it.season || "");
    router.push(`/fashion/brand/${encodeURIComponent(it.source_id)}?title=${title}&season=${s}`);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <View style={[styles.header, { paddingTop: insets.top + 8, paddingHorizontal: spacing.xl, borderBottomColor: colors.divider }]}>
        <Pressable testID="week-back" onPress={() => goBack(router, "/fashion/weeks")} hitSlop={10}>
          <Feather name="chevron-left" size={26} color={colors.onSurface} />
        </Pressable>
        <Text numberOfLines={1} style={[styles.title, { color: colors.onSurface }]}>
          {city} · {formatSeason(season, season)}
        </Text>
        <View style={{ width: 26 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: pad, paddingTop: 16, paddingBottom: insets.bottom + 40 }}>
          <Text style={{ color: colors.brandSecondary, fontSize: 12, marginBottom: 14 }}>{total}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap }}>
            {items.map((it) => (
              <Pressable key={it.source_id} onPress={() => open(it)} style={{ width: cardW }}>
                <View style={[styles.card, { backgroundColor: colors.surfaceTertiary, borderColor: colors.border }]}>
                  {it.image_thumb || it.image ? (
                    <RetryImage uri={fashionImageUri(it.image_thumb || it.image || "")} style={{ width: "100%", height: "100%" }} contentFit="cover" transition={200} />
                  ) : (
                    <View style={styles.ph}>
                      <Feather name="image" size={22} color={colors.brandSecondary} />
                    </View>
                  )}
                </View>
                <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 13, fontWeight: "700", marginTop: 6 }}>
                  {it.brand_tr || it.title_tr}
                </Text>
              </Pressable>
            ))}
          </View>
          {items.length < total && (
            <Pressable
              testID="week-load-more"
              onPress={loadMore}
              disabled={loadingMore}
              style={{ marginTop: 20, alignItems: "center", paddingVertical: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}
            >
              {loadingMore ? (
                <ActivityIndicator color={colors.onSurface} size="small" />
              ) : (
                <Text style={{ color: colors.onSurface, fontWeight: "700" }}>
                  {t("common.loadMore")} ({items.length}/{total})
                </Text>
              )}
            </Pressable>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 12, borderBottomWidth: 1 },
  title: { fontSize: 16, fontWeight: "800", flex: 1, textAlign: "center" },
  card: { width: "100%", aspectRatio: 3 / 4, borderRadius: 4, overflow: "hidden", borderWidth: 1 },
  ph: { flex: 1, alignItems: "center", justifyContent: "center" },
});
