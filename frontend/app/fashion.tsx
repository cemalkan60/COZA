// frontend/app/fashion.tsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Dimensions,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api, FashionItem, FashionAnalytics } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { formatDate } from "@/src/utils/format";
import { resolveBestImage, fashionImageUri } from "@/src/utils/fashionImage";

const { width } = Dimensions.get("window");

export default function Fashion() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [items, setItems] = useState<FashionItem[]>([]);
  const [analytics, setAnalytics] = useState<FashionAnalytics | null>(null);
  const [season, setSeason] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (refresh = false) => {
      if (refresh) setRefreshing(true);
      try {
        const [feed, stats] = await Promise.all([api.fashionCollections({ season, limit: 40 }), api.fashionAnalytics()]);
        setItems(feed.items || []);
        setAnalytics(stats);
      } catch {
        /* sessizce geç */
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [season],
  );

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const seasonChips = useMemo(() => {
    const map = new Map<string, string>();
    items.forEach((it) => {
      if (it.season && it.season_label) map.set(it.season, it.season_label);
    });
    return Array.from(map.entries()).map(([code, label]) => ({ code, label }));
  }, [items]);

  // show all items (no 6-limit)
  const slots = items;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, paddingHorizontal: spacing.xl, borderBottomColor: colors.divider },
        ]}
      >
        <Pressable testID="fashion-back" onPress={() => router.replace("/hub")} hitSlop={10}>
          <Feather name="chevron-left" size={26} color={colors.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={[styles.brandLine, { color: colors.onSurface }]}>
            COZA <Text style={{ color: colors.brandSecondary }}>FASHION</Text>
          </Text>
        </View>
        <Pressable
          testID="fashion-open-search"
          onPress={() => router.push("/fashion/search" as any)}
          style={[styles.searchBtn, { borderColor: colors.border, backgroundColor: colors.surfaceSecondary }]}
          hitSlop={8}
        >
          <Feather name="search" size={18} color={colors.onSurface} />
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.brand} />}
        >
          {seasonChips.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.xl, gap: 8, paddingVertical: 14 }}>
              <Chip label="Tümü" active={!season} onPress={() => setSeason(undefined)} colors={colors} />
              {seasonChips.map((s) => (
                <Chip key={s.code} label={s.label} active={season === s.code} onPress={() => setSeason((cur) => (cur === s.code ? undefined : s.code))} colors={colors} />
              ))}
            </ScrollView>
          )}

          {items.length === 0 ? (
            <View style={{ paddingHorizontal: spacing.xl, marginTop: 40 }}>
              <Text style={{ color: colors.brandSecondary, textAlign: "center" }}>Henüz içerik yok. İçerik her Pazartesi otomatik güncellenir.</Text>
            </View>
          ) : (
            <View style={[styles.grid, { paddingHorizontal: spacing.xl - 4 }]}>
              {slots.map((it, idx) => (
                <FashionCard key={idx} item={it} colors={colors} />
              ))}
            </View>
          )}

          {analytics?.last_scrape && (
            <View style={[styles.note, { backgroundColor: colors.surfaceSecondary, marginHorizontal: spacing.xl }]}>
              <Feather name="info" size={14} color={colors.brandSecondary} />
              <Text style={[styles.noteText, { color: colors.brandSecondary }]}>
                İçerik fashion-press.net kaynağından derlenir ve Türkçeye çevrilir. Her Pazartesi otomatik güncellenir. Son güncelleme: {formatDate(analytics.last_scrape)}
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

function FashionCard({ item, colors }: { item: FashionItem | null; colors: any }) {
  const router = useRouter();
  const [displayImg, setDisplayImg] = useState<string | undefined>(item?.image);

  useEffect(() => {
    let cancelled = false;
    setDisplayImg(item?.image);
    if (item?.image) {
      resolveBestImage(item.image).then((best) => {
        if (!cancelled) setDisplayImg(best);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [item?.image]);

  const openInternal = (it: FashionItem) => {
    // Only pass id + title — the gallery screen fetches images itself.
    // (Used to also pass the raw fashion-press.net image URL here so the
    // first photo could paint before that fetch resolved, but it leaked the
    // source domain straight into the visible/shareable URL.)
    const title = encodeURIComponent(it.brand_tr || it.title_tr || "");
    router.push(`/fashion/brand/${encodeURIComponent(it.source_id)}?title=${title}`);
  };

  if (!item) {
    return (
      <View style={[styles.card, styles.cardEmpty]}>
        <Text style={{ color: colors.brandSecondary, fontWeight: "700" }}>—</Text>
      </View>
    );
  }

  return (
    <Pressable testID={`fashion-card-${item.source_id}`} onPress={() => openInternal(item)} style={({ pressed }) => [styles.card, { opacity: pressed ? 0.9 : 1 }]}>
      <View style={[styles.imageWrap, { backgroundColor: colors.surfaceTertiary, borderColor: colors.border }]}>
        {displayImg ? (
          <Image source={{ uri: fashionImageUri(displayImg) }} style={styles.image} contentFit="cover" transition={220} />
        ) : (
          <View style={styles.imagePlaceholder}>
            <Feather name="image" size={22} color={colors.brandSecondary} />
          </View>
        )}
      </View>
      <Text numberOfLines={1} style={[styles.cardBrand, { color: colors.onSurface }]}>
        {item.brand_tr || item.title_tr}
      </Text>
    </Pressable>
  );
}

function Chip({ label, active, onPress, colors }: { label: string; active: boolean; onPress: () => void; colors: any }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, { backgroundColor: active ? colors.brand : colors.surfaceSecondary, borderColor: active ? colors.brand : colors.border }]}>
      <Text style={{ color: active ? colors.onBrand : colors.onSurface, fontSize: 12, fontWeight: "700" }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  brandLine: { fontSize: 20, fontWeight: "800", letterSpacing: 1 },
  searchBtn: {
    width: 40,
    height: 40,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 12 },
  // 6 columns layout
  card: { width: "16.6%", marginBottom: 18 },
  cardEmpty: { alignItems: "center", justifyContent: "center", height: 220, backgroundColor: "transparent", borderRadius: 4 },
  imageWrap: {
    width: "100%",
    aspectRatio: 3 / 4,
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 8,
  },
  image: { width: "100%", height: "100%" },
  imagePlaceholder: { flex: 1, alignItems: "center", justifyContent: "center" },
  cardBrand: { fontSize: 13, fontWeight: "700", letterSpacing: -0.2 },
  note: { flexDirection: "row", gap: 10, padding: 14, borderRadius: 4, marginTop: 20 },
  noteText: { flex: 1, fontSize: 11, lineHeight: 17 },
});
