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

// One fashion house: all its collections, newest first.
export default function House() {
  const { colors, spacing } = useTheme();
  const { formatSeason } = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams();
  const brand = decodeURIComponent((params.brand as string) || "");

  const [items, setItems] = useState<FashionItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.fashionCollections({ brand, sort: "newest", limit: 60 });
      setItems(res.items || []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [brand]);

  useEffect(() => {
    load();
  }, [load]);

  const cols = width >= 1200 ? 5 : width >= 900 ? 4 : width >= 600 ? 3 : 2;
  const gap = 12;
  const pad = spacing.xl - 4;
  const cardW = (width - pad * 2 - gap * (cols - 1)) / cols;

  const open = (it: FashionItem) => {
    const title = encodeURIComponent(it.brand_tr || it.title_tr || "");
    const season = encodeURIComponent(it.season || "");
    router.push(`/fashion/brand/${encodeURIComponent(it.source_id)}?title=${title}&season=${season}`);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <View style={[styles.header, { paddingTop: insets.top + 8, paddingHorizontal: spacing.xl, borderBottomColor: colors.divider }]}>
        <Pressable testID="house-back" onPress={() => goBack(router, "/fashion")} hitSlop={10}>
          <Feather name="chevron-left" size={26} color={colors.onSurface} />
        </Pressable>
        <Text numberOfLines={1} style={[styles.title, { color: colors.onSurface }]}>
          {brand}
        </Text>
        <View style={{ width: 26 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: pad, paddingTop: 16, paddingBottom: insets.bottom + 40 }}>
          <Text style={{ color: colors.brandSecondary, fontSize: 12, marginBottom: 14 }}>
            {items.length}
          </Text>
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
                  {formatSeason(it.season, it.season_label)}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 12, borderBottomWidth: 1 },
  title: { fontSize: 18, fontWeight: "800", flex: 1, letterSpacing: 0.3 },
  card: { width: "100%", aspectRatio: 3 / 4, borderRadius: 4, overflow: "hidden", borderWidth: 1 },
  ph: { flex: 1, alignItems: "center", justifyContent: "center" },
});
