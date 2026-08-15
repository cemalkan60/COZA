// frontend/app/fashion/brand/[id].tsx
import React, { useEffect, useState } from "react";
import {
  View,
  FlatList,
  Image as RNImage,
  ActivityIndicator,
  StyleSheet,
  Text,
  Platform,
  Pressable,
  Modal,
  useWindowDimensions,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useTheme } from "@/src/theme/ThemeContext";

// SSR-safe image probe
async function probeImage(url: string) {
  if (!url) return false;
  // If server-side render, don't try DOM APIs
  if (typeof window === "undefined") return false;

  if (Platform.OS === "web") {
    return await new Promise<boolean>((resolve) => {
      try {
        const img = new (window as any).Image();
        img.referrerPolicy = "no-referrer";
        let done = false;
        const onOK = () => {
          if (done) return;
          done = true;
          resolve(true);
        };
        const onFail = () => {
          if (done) return;
          done = true;
          resolve(false);
        };
        const t = setTimeout(() => onFail(), 4000);
        img.onload = () => {
          clearTimeout(t);
          onOK();
        };
        img.onerror = () => {
          clearTimeout(t);
          onFail();
        };
        img.src = url;
      } catch {
        resolve(false);
      }
    });
  } else {
    try {
      // @ts-ignore
      const ok = await RNImage.prefetch(url);
      return !!ok;
    } catch {
      return false;
    }
  }
}

// Try highest resolution variants first; fall back to the low-res original
// only if none of the larger sizes are available.
function makeCandidates(original: string) {
  if (!original) return [original];
  const re = /\/w(\d+)_/;
  const m = original.match(re);
  const sized: string[] = [];
  if (m) {
    ["1200", "1024", "768"].forEach((s) => sized.push(original.replace(re, `/w${s}_`)));
  } else {
    sized.push(original.replace("/w300_top", "/w1200_top"));
    sized.push(original.replace("/w300_top", "/w768_top"));
  }
  return Array.from(new Set([...sized, original]));
}

async function resolveBest(original: string) {
  const candidates = makeCandidates(original);
  for (const c of candidates) {
    if (!c) continue;
    const ok = await probeImage(c);
    if (ok) return c;
  }
  return original;
}

export default function BrandGallery() {
  const params = useLocalSearchParams();
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width } = useWindowDimensions();

  const id = (params.id as string) || "";
  const primaryImgParam = (params.img as string) || "";
  const titleParam = (params.title as string) || "";
  const title = titleParam ? decodeURIComponent(titleParam) : "";

  const primaryImg = primaryImgParam ? decodeURIComponent(primaryImgParam) : "";
  const [images, setImages] = useState<string[]>(primaryImg ? [primaryImg] : []);
  const [loading, setLoading] = useState(true);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchAndResolve() {
      try {
        let resolvedPrimary = primaryImg;
        if (primaryImg) {
          try {
            resolvedPrimary = await resolveBest(primaryImg);
          } catch {
            resolvedPrimary = primaryImg;
          }
        }

        const base = process.env.EXPO_PUBLIC_BACKEND_URL || "";
        const fetchedImgs: string[] = [];
        if (base) {
          try {
            const res = await fetch(`${base}/api/fashion/collections/${encodeURIComponent(id)}`);
            if (res.ok) {
              const data = await res.json();
              if (Array.isArray(data.images)) fetchedImgs.push(...data.images);
              if (Array.isArray(data.items)) {
                data.items.forEach((it: any) => {
                  if (it.image) fetchedImgs.push(it.image);
                  if (Array.isArray(it.images)) fetchedImgs.push(...it.images);
                });
              }
            }
          } catch {
            // ignore fetch errors (best-effort)
          }
        }

        const merged = Array.from(
          new Set([...(resolvedPrimary ? [resolvedPrimary] : []), ...fetchedImgs.filter(Boolean)])
        );

        if (!cancelled) {
          if (merged.length) setImages(merged);
          else if (primaryImg && !images.length) setImages([resolvedPrimary]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAndResolve();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, primaryImg]);

  const columns = width >= 1200 ? 6 : width >= 900 ? 5 : width >= 700 ? 4 : width >= 480 ? 3 : 2;
  const gap = 10;
  const gridPad = spacing.xl;
  const cardWidth = (width - gridPad * 2 - gap * (columns - 1)) / columns;

  const header = (
    <View
      style={[
        styles.header,
        { paddingTop: insets.top + 8, paddingHorizontal: spacing.xl, borderBottomColor: colors.divider },
      ]}
    >
      <Pressable testID="brand-back" onPress={() => router.back()} hitSlop={10}>
        <Feather name="chevron-left" size={26} color={colors.onSurface} />
      </Pressable>
      <Text numberOfLines={1} style={[styles.headerTitle, { color: colors.onSurface }]}>
        {title || "Koleksiyon"}
      </Text>
      <View style={{ width: 26 }} />
    </View>
  );

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        {header}
        <ActivityIndicator style={{ marginTop: 60 }} color={colors.brand} />
      </View>
    );
  }

  if (!images.length) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        {header}
        <View style={styles.noContent}>
          <Text style={{ color: colors.brandSecondary }}>Bu koleksiyona ait görsel bulunamadı.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.surface }]}>
      {header}
      <FlatList
        data={images}
        keyExtractor={(_, i) => String(i)}
        key={columns}
        numColumns={columns}
        contentContainerStyle={{ padding: gridPad, paddingTop: 16 }}
        columnWrapperStyle={columns > 1 ? { gap } : undefined}
        renderItem={({ item, index }) => (
          <Pressable
            testID={`brand-thumb-${index}`}
            onPress={() => setViewerIndex(index)}
            style={({ pressed }) => [{ width: cardWidth, marginBottom: gap, opacity: pressed ? 0.85 : 1 }]}
          >
            {Platform.OS === "web" ? (
              <div
                style={{
                  width: cardWidth,
                  aspectRatio: "3/4",
                  overflow: "hidden",
                  backgroundColor: colors.surfaceTertiary,
                  borderRadius: 4,
                }}
              >
                <img
                  src={item}
                  alt=""
                  referrerPolicy="no-referrer"
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                />
              </div>
            ) : (
              <RNImage
                source={{ uri: item }}
                style={{ width: cardWidth, aspectRatio: 3 / 4, backgroundColor: colors.surfaceTertiary, borderRadius: 4 }}
                resizeMode="cover"
              />
            )}
          </Pressable>
        )}
      />

      <Modal
        visible={viewerIndex !== null}
        animationType="fade"
        transparent
        onRequestClose={() => setViewerIndex(null)}
      >
        <View style={styles.viewerOverlay}>
          <Pressable
            testID="brand-viewer-close"
            onPress={() => setViewerIndex(null)}
            style={[styles.viewerClose, { top: insets.top + 12 }]}
            hitSlop={12}
          >
            <Feather name="x" size={26} color="#fff" />
          </Pressable>
          {viewerIndex !== null && (
            <FlatList
              data={images}
              keyExtractor={(_, i) => String(i)}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              initialScrollIndex={viewerIndex}
              getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
              renderItem={({ item }) =>
                Platform.OS === "web" ? (
                  <div
                    style={{
                      width,
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <img
                      src={item}
                      alt=""
                      referrerPolicy="no-referrer"
                      style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                    />
                  </div>
                ) : (
                  <View style={{ width, height: "100%", alignItems: "center", justifyContent: "center" }}>
                    <RNImage source={{ uri: item }} style={{ width, height: "100%" }} resizeMode="contain" />
                  </View>
                )
              }
            />
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerTitle: { flex: 1, textAlign: "center", fontSize: 15, fontWeight: "800", letterSpacing: 0.2 },
  noContent: { flex: 1, alignItems: "center", justifyContent: "center" },
  viewerOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.95)", alignItems: "center", justifyContent: "center" },
  viewerClose: {
    position: "absolute",
    right: 16,
    zIndex: 10,
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.15)",
  },
});
