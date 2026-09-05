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
import { fashionImageUri } from "@/src/utils/fashionImage";
import { ZoomableImage, type ZoomableImageHandle } from "@/src/components/ZoomableImage";

export default function BrandGallery() {
  const params = useLocalSearchParams();
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width, height } = useWindowDimensions();

  const id = (params.id as string) || "";
  const titleParam = (params.title as string) || "";
  const title = titleParam ? decodeURIComponent(titleParam) : "";
  const seasonParam = (params.season as string) || "";
  const season = seasonParam ? decodeURIComponent(seasonParam) : "";
  const headerLabel = season ? `${title} (${season})` : title;

  const [images, setImages] = useState<string[]>([]);
  // Small resized copies of `images`, same order/length -- used only for
  // the grid tiles below (see renderItem), never for the fullscreen viewer,
  // which always shows the full-resolution photo. Falls back to `images`
  // itself (index-for-index) for any collection the thumbnail backfill
  // hasn't reached yet -- see the merge in fetchImages below.
  const [imagesThumb, setImagesThumb] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [viewerZoomed, setViewerZoomed] = useState(false);
  const viewerIndexRef = useRef<number | null>(null);
  viewerIndexRef.current = viewerIndex;
  const imagesLengthRef = useRef(0);
  imagesLengthRef.current = images.length;
  const viewerListRef = useRef<FlatList<string>>(null);
  const wasViewerOpenRef = useRef(false);
  // One ZoomableImage ref per currently-mounted viewer page (FlatList only
  // keeps a handful of pages mounted at once), keyed by index, so the +/-
  // zoom buttons below can always reach whichever page is actually visible
  // right now (see the "Kombin Arama"-style toolbar in the viewer overlay).
  const zoomRefs = useRef<Map<number, ZoomableImageHandle>>(new Map());
  const handleZoomIn = useCallback(() => {
    if (viewerIndexRef.current !== null) zoomRefs.current.get(viewerIndexRef.current)?.zoomIn();
  }, []);
  const handleZoomOut = useCallback(() => {
    if (viewerIndexRef.current !== null) zoomRefs.current.get(viewerIndexRef.current)?.zoomOut();
  }, []);

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

  // react-native-web's FlatList doesn't reliably honor `initialScrollIndex` on
  // mount, so on web the viewer always opened on the first photo no matter
  // which thumbnail was tapped (native FlatList handles it fine, hence the
  // bug being web-only). `contentOffset` on the FlatList below covers Chrome;
  // Safari still needs an imperative nudge, and needs it after layout has
  // actually flushed — a single setTimeout(0)/rAF fires too early there, so
  // double-rAF it (a standard "wait one extra paint" trick for WebKit).
  useEffect(() => {
    const isOpen = viewerIndex !== null;
    const wasOpen = wasViewerOpenRef.current;
    wasViewerOpenRef.current = isOpen;
    if (isOpen && !wasOpen) {
      const idx = viewerIndex as number;
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          viewerListRef.current?.scrollToIndex({ index: idx, animated: false });
        });
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
  }, [viewerIndex]);

  useEffect(() => {
    let cancelled = false;
    async function fetchImages() {
      try {
        // Falls back to our own production backend if this build's env var
        // wasn't set (see the matching comment in src/api/client.ts) — same
        // bug, different call site, since this screen fetches the gallery
        // directly instead of going through the shared api client.
        const base = process.env.EXPO_PUBLIC_BACKEND_URL || "https://coza-production.up.railway.app";
        const fetchedImgs: string[] = [];
        // Parallel to fetchedImgs (same index) -- the small resized copy of
        // each full-res photo, for the grid tiles below. Falls back to the
        // full-res URL itself wherever no thumbnail exists yet.
        const fetchedThumbs: string[] = [];
        if (base) {
          try {
            const res = await fetch(`${base}/api/fashion/collections/${encodeURIComponent(id)}`);
            if (res.ok) {
              const data = await res.json();
              if (Array.isArray(data.images)) {
                const thumbs = Array.isArray(data.images_thumb) ? data.images_thumb : [];
                data.images.forEach((u: string, i: number) => {
                  fetchedImgs.push(u);
                  fetchedThumbs.push(thumbs[i] || u);
                });
              }
              if (Array.isArray(data.items)) {
                data.items.forEach((it: any) => {
                  if (it.image) {
                    fetchedImgs.push(it.image);
                    fetchedThumbs.push(it.image_thumb || it.image);
                  }
                  if (Array.isArray(it.images)) {
                    const thumbs = Array.isArray(it.images_thumb) ? it.images_thumb : [];
                    it.images.forEach((u: string, i: number) => {
                      fetchedImgs.push(u);
                      fetchedThumbs.push(thumbs[i] || u);
                    });
                  }
                });
              }
            }
          } catch {
            // ignore fetch errors (best-effort)
          }
        }

        // De-dupe by full-res URL while keeping the thumb list paired to it
        // index-for-index -- a plain Set (the original approach) can't
        // carry a second parallel value along with it.
        const seen = new Set<string>();
        const mergedImgs: string[] = [];
        const mergedThumbs: string[] = [];
        fetchedImgs.forEach((u, i) => {
          if (!u || seen.has(u)) return;
          seen.add(u);
          mergedImgs.push(u);
          mergedThumbs.push(fetchedThumbs[i] || u);
        });
        if (!cancelled) {
          setImages(mergedImgs);
          setImagesThumb(mergedThumbs);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchImages();
    return () => {
      cancelled = true;
    };
  }, [id]);

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
        {headerLabel || "Koleksiyon"}
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
              source={{ uri: fashionImageUri(imagesThumb[index] || item) }}
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
                contentOffset={{ x: width * viewerIndex, y: 0 }}
                getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
                onScrollToIndexFailed={(info) => {
                  setTimeout(() => viewerListRef.current?.scrollToIndex({ index: info.index, animated: false }), 50);
                }}
                onMomentumScrollEnd={(e) => {
                  const idx = Math.round(e.nativeEvent.contentOffset.x / width);
                  setViewerIndex(idx);
                }}
                renderItem={({ item, index }) => (
                  <View style={{ width, height, alignItems: "center", justifyContent: "center" }}>
                    <ZoomableImage
                      ref={(handle) => {
                        if (handle) zoomRefs.current.set(index, handle);
                        else zoomRefs.current.delete(index);
                      }}
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

              <View style={[styles.viewerZoomControls, { bottom: insets.bottom + 24 }]}>
                <Pressable
                  testID="brand-viewer-zoom-out"
                  onPress={handleZoomOut}
                  style={styles.viewerZoomBtn}
                  hitSlop={10}
                >
                  <Feather name="zoom-out" size={20} color="#fff" />
                </Pressable>
                <Pressable
                  testID="brand-viewer-zoom-in"
                  onPress={handleZoomIn}
                  style={styles.viewerZoomBtn}
                  hitSlop={10}
                >
                  <Feather name="zoom-in" size={20} color="#fff" />
                </Pressable>
              </View>
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
  viewerZoomControls: {
    position: "absolute",
    right: 16,
    flexDirection: "row",
    gap: 10,
    zIndex: 10,
  },
  viewerZoomBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.15)",
  },
});
