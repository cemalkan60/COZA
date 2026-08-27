// frontend/app/fashion/brand/[id].tsx
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  FlatList,
  ActivityIndicator,
  StyleSheet,
  Text,
  Platform,
  Pressable,
  Modal,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useTheme } from "@/src/theme/ThemeContext";
import { resolveBestImage, fashionImageUri } from "@/src/utils/fashionImage";
import { ZoomableImage } from "@/src/components/ZoomableImage";

export default function BrandGallery() {
  const params = useLocalSearchParams();
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width, height } = useWindowDimensions();

  const id = (params.id as string) || "";
  const primaryImgParam = (params.img as string) || "";
  const titleParam = (params.title as string) || "";
  const title = titleParam ? decodeURIComponent(titleParam) : "";

  const primaryImg = primaryImgParam ? decodeURIComponent(primaryImgParam) : "";
  const [images, setImages] = useState<string[]>(primaryImg ? [primaryImg] : []);
  const [loading, setLoading] = useState(true);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [viewerZoomed, setViewerZoomed] = useState(false);
  const viewerIndexRef = useRef<number | null>(null);
  viewerIndexRef.current = viewerIndex;
  const imagesLengthRef = useRef(0);
  imagesLengthRef.current = images.length;
  const viewerListRef = useRef<FlatList<string>>(null);

  const goPrev = useCallback(() => {
    setViewerIndex((i) => {
      if (i === null) return i;
      const next = Math.max(0, i - 1);
      viewerListRef.current?.scrollToIndex({ index: next, animated: true });
      return next;
    });
  }, []);
  const goNext = useCallback(() => {
    setViewerIndex((i) => {
      if (i === null) return i;
      const next = Math.min(imagesLengthRef.current - 1, i + 1);
      viewerListRef.current?.scrollToIndex({ index: next, animated: true });
      return next;
    });
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    function onKeyDown(e: KeyboardEvent) {
      if (viewerIndexRef.current === null) return;
      if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "ArrowRight") goNext();
      else if (e.key === "Escape") setViewerIndex(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goPrev, goNext]);

  useEffect(() => {
    setViewerZoomed(false);
  }, [viewerIndex]);

  useEffect(() => {
    let cancelled = false;
    async function fetchAndResolve() {
      try {
        let resolvedPrimary = primaryImg;
        if (primaryImg) {
          try {
            resolvedPrimary = await resolveBestImage(primaryImg);
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
            <Image
              source={{ uri: fashionImageUri(item) }}
              style={{ width: cardWidth, aspectRatio: 3 / 4, backgroundColor: colors.surfaceTertiary, borderRadius: 4 }}
              contentFit="cover"
              transition={220}
            />
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
            <>
              <FlatList
                ref={viewerListRef}
                style={{ width, height }}
                data={images}
                keyExtractor={(_, i) => String(i)}
                horizontal
                pagingEnabled
                scrollEnabled={!viewerZoomed}
                showsHorizontalScrollIndicator={false}
                initialScrollIndex={viewerIndex}
                getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
                onScrollToIndexFailed={(info) => {
                  setTimeout(() => viewerListRef.current?.scrollToIndex({ index: info.index, animated: false }), 50);
                }}
                onMomentumScrollEnd={(e) => {
                  const idx = Math.round(e.nativeEvent.contentOffset.x / width);
                  setViewerIndex(idx);
                }}
                renderItem={({ item }) => (
                  <View style={{ width, height, alignItems: "center", justifyContent: "center" }}>
                    <ZoomableImage
                      uri={fashionImageUri(item)}
                      width={width * 0.92}
                      height={height * 0.8}
                      contentFit="contain"
                      onZoomChange={setViewerZoomed}
                    />
                  </View>
                )}
              />

              {viewerIndex > 0 && (
                <Pressable
                  testID="brand-viewer-prev"
                  onPress={goPrev}
                  style={[styles.viewerNav, { left: 16 }]}
                  hitSlop={12}
                >
                  <Feather name="chevron-left" size={30} color="#fff" />
                </Pressable>
              )}
              {viewerIndex < images.length - 1 && (
                <Pressable
                  testID="brand-viewer-next"
                  onPress={goNext}
                  style={[styles.viewerNav, { right: 16 }]}
                  hitSlop={12}
                >
                  <Feather name="chevron-right" size={30} color="#fff" />
                </Pressable>
              )}

              <Text style={styles.viewerCounter}>
                {viewerIndex + 1} / {images.length}
              </Text>
            </>
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
  viewerNav: {
    position: "absolute",
    top: "50%",
    marginTop: -24,
    zIndex: 10,
    width: 48,
    height: 48,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  viewerCounter: {
    position: "absolute",
    bottom: 24,
    alignSelf: "center",
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
    backgroundColor: "rgba(255,255,255,0.15)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
});
