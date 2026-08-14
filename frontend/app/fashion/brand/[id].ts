// frontend/app/fashion/brand/[id].tsx
import React, { useEffect, useState } from "react";
import { View, FlatList, Image, Dimensions, ActivityIndicator, StyleSheet, Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useTheme } from "@/src/theme/ThemeContext";

const { width } = Dimensions.get("window");

export default function BrandGallery() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const { colors } = useTheme();
  const id = params.id as string;
  const primaryImg = (params.img as string) || "";
  const title = (params.title as string) || "";

  const [images, setImages] = useState<string[]>(primaryImg ? [decodeURIComponent(primaryImg)] : []);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function fetchMore() {
      try {
        const base = process.env.EXPO_PUBLIC_BACKEND_URL || "";
        if (!base) {
          setLoading(false);
          return;
        }
        const res = await fetch(`${base}/api/fashion/collections/${encodeURIComponent(id)}`);
        if (!res.ok) {
          setLoading(false);
          return;
        }
        const data = await res.json();
        const imgs: string[] = [];
        if (Array.isArray(data.images)) imgs.push(...data.images);
        if (Array.isArray(data.items)) {
          data.items.forEach((it: any) => {
            if (Array.isArray(it.images)) imgs.push(...it.images);
            if (it.image) imgs.push(it.image);
          });
        }
        const merged = Array.from(new Set([...(primaryImg ? [decodeURIComponent(primaryImg)] : []), ...imgs]));
        if (!cancelled && merged.length) setImages(merged);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchMore();
    return () => {
      cancelled = true;
    };
  }, [id, primaryImg]);

  if (loading) return <ActivityIndicator style={{ marginTop: 60 }} color={colors.brand} />;

  if (!images.length) {
    return (
      <View style={[styles.noContent, { backgroundColor: colors.surface }]}>
        <Text style={{ color: colors.brandSecondary }}>Bu koleksiyona ait görsel bulunamadı.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.surface }]}>
      {title ? <Text style={[styles.title, { color: colors.onSurface }]}>{decodeURIComponent(title)}</Text> : null}
      <FlatList
        data={images}
        keyExtractor={(_, i) => String(i)}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        renderItem={({ item }) => (
          <Image source={{ uri: item }} style={{ width, height: width * 0.85 }} resizeMode="contain" />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "flex-start" },
  title: { fontSize: 18, fontWeight: "800", marginTop: 16, marginBottom: 8 },
  noContent: { flex: 1, alignItems: "center", justifyContent: "center" },
});
