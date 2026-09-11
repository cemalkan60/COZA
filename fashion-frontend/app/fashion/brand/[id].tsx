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
  ScrollView,
  useWindowDimensions,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useTheme } from "@/src/theme/ThemeContext";
import { useT } from "@/src/i18n";
import { api } from "@/src/api/client";
import { fashionImageUri } from "@/src/utils/fashionImage";
import { goBack } from "@/src/utils/nav";
import { ZoomableImage, type ZoomableImageHandle } from "@/src/components/ZoomableImage";
import { SaveToBoardSheet } from "@/src/components/SaveToBoardSheet";
import RetryImage from "@/src/components/RetryImage";
import { saveLastCollection } from "@/src/utils/lastCollection";

export default function BrandGallery() {
  const params = useLocalSearchParams();
  const { colors, spacing } = useTheme();
  const { t, formatSeason, lang } = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width, height } = useWindowDimensions();

  const id = (params.id as string) || "";
  const titleParam = (params.title as string) || "";
  const title = titleParam ? decodeURIComponent(titleParam) : "";
  const seasonParam = (params.season as string) || "";
  const seasonRaw = seasonParam ? decodeURIComponent(seasonParam) : "";
  const season = seasonRaw ? formatSeason(seasonRaw, seasonRaw) : "";
  // C4: "more from this show" strips (Lens/board viewers) link here with
  // ?open=<index> to jump straight to the tapped photo instead of always
  // landing on the cover.
  const openParam = (params.open as string) || "";
  const openIndex = openParam ? parseInt(openParam, 10) : NaN;
  const headerLabel = season ? `${title} (${season})` : title;

  const [images, setImages] = useState<string[]>([]);
  // Small resized copies of `images`, same order/length -- used only for
  // the grid tiles below (see renderItem), never for the fullscreen viewer,
  // which always shows the full-resolution photo. Falls back to `images`
  // itself (index-for-index) for any collection the thumbnail backfill
  // hasn't reached yet -- see the merge in fetchImages below.
  const [imagesThumb, setImagesThumb] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  // G4: tag coverage ("42/50 foto analiz edildi") — null until the detail
  // fetch resolves, or if the backend response predates this field.
  const [tagCoverage, setTagCoverage] = useState<{ tagged: number; taggable: number } | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [viewerZoomed, setViewerZoomed] = useState(false);
  const [savedKeys, setSavedKeys] = useState<Record<string, string[]>>({});
  const [saveSheetIndex, setSaveSheetIndex] = useState<number | null>(null);

  // G2: "Bu kapak/marka yanlış" — flag to an admin queue, no automatic action.
  const [reportOpen, setReportOpen] = useState(false);
  const [reportSending, setReportSending] = useState(false);
  const [reportSent, setReportSent] = useState(false);
  const sendReport = async (reason: string) => {
    if (reportSending) return;
    setReportSending(true);
    try {
      await api.fashionReportCollection(id, reason);
      setReportSent(true);
      setTimeout(() => {
        setReportOpen(false);
        setReportSent(false);
      }, 1200);
    } catch {
    } finally {
      setReportSending(false);
    }
  };
  const refreshSaved = useCallback(() => {
    api.savedKeys().then((r) => setSavedKeys(r.saved || {})).catch(() => {});
  }, []);
  useEffect(() => { refreshSaved(); }, [refreshSaved]);
  const [similar, setSimilar] = useState<
    { source_id: string; brand_tr: string; season: string; season_label: string; image: string | null }[]
  >([]);
  useEffect(() => {
    if (id) api.fashionSimilar(id).then((r) => setSimilar(r.items || [])).catch(() => {});
  }, [id]);
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

  // B1: "Bu görünümü anlat" — one-sentence AI description of whichever
  // photo is currently open in the viewer.
  const [description, setDescription] = useState<string | null>(null);
  const [describing, setDescribing] = useState(false);
  useEffect(() => {
    setDescription(null);
    setDescribing(false);
  }, [viewerIndex]);
  const handleDescribe = useCallback(() => {
    if (viewerIndex === null || describing) return;
    setDescribing(true);
    api
      .fashionDescribePhoto(id, viewerIndex, lang)
      .then((r) => setDescription(r.description))
      .catch(() => setDescription(t("detail.describeError")))
      .finally(() => setDescribing(false));
  }, [id, viewerIndex, lang, describing, t]);

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
              if (typeof data.tagged_count === "number" && typeof data.taggable_count === "number" && !cancelled) {
                setTagCoverage({ tagged: data.tagged_count, taggable: data.taggable_count });
              }
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
          // A6: "Kaldığın yerden devam" — remember this as the most
          // recently opened collection for the Fashion tab's resume card.
          if (id && mergedImgs.length) {
            saveLastCollection({
              source_id: id,
              title,
              season: seasonRaw,
              image: mergedThumbs[0] || mergedImgs[0],
            });
          }
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

  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current || !images.length || isNaN(openIndex)) return;
    autoOpenedRef.current = true;
    setViewerIndex(Math.max(0, Math.min(images.length - 1, openIndex)));
  }, [images, openIndex]);

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
      <Pressable testID="brand-back" onPress={() => goBack(router, "/fashion")} hitSlop={10}>
        <Feather name="chevron-left" size={26} color={colors.onSurface} />
      </Pressable>
      <Pressable
        style={{ flex: 1 }}
        disabled={!title}
        onPress={() => title && router.push(`/fashion/house?brand=${encodeURIComponent(title)}` as any)}
      >
        <Text numberOfLines={1} style={[styles.headerTitle, { color: colors.onSurface }]}>
          {headerLabel || t("detail.gallery")}
        </Text>
      </Pressable>
      <Pressable testID="brand-report" onPress={() => setReportOpen(true)} hitSlop={10}>
        <Feather name="flag" size={20} color={colors.onSurfaceSecondary} />
      </Pressable>
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
          <Text style={{ color: colors.brandSecondary }}>{t("lens.empty")}</Text>
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
        ListHeaderComponent={
          tagCoverage && tagCoverage.taggable > 0 ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 14, marginLeft: 2 }}>
              <Feather name="tag" size={12} color={colors.brandSecondary} />
              <Text style={{ color: colors.brandSecondary, fontSize: 12 }}>
                {t("detail.tagCoverage", { tagged: tagCoverage.tagged, taggable: tagCoverage.taggable })}
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item, index }) => (
          <Pressable
            testID={`brand-thumb-${index}`}
            onPress={() => setViewerIndex(index)}
            style={({ pressed }) => [{ width: cardWidth, marginBottom: gap, opacity: pressed ? 0.85 : 1 }]}
          >
            <RetryImage
              uri={fashionImageUri(imagesThumb[index] || item)}
              style={{ width: cardWidth, aspectRatio: 3 / 4, backgroundColor: colors.surfaceTertiary, borderRadius: 4 }}
              contentFit="cover"
              transition={220}
            />
            <Pressable
              testID={`brand-thumb-save-${index}`}
              onPress={() => setSaveSheetIndex(index)}
              hitSlop={8}
              style={styles.thumbSave}
            >
              <Feather
                name="bookmark"
                size={15}
                color="#fff"
                style={{ opacity: (savedKeys[`${id}#${index}`]?.length ?? 0) > 0 ? 1 : 0.7 }}
              />
            </Pressable>
          </Pressable>
        )}
        ListFooterComponent={
          similar.length > 0 ? (
            <View style={{ marginTop: 8, marginBottom: insets.bottom + 24 }}>
              <Text style={{ color: colors.onSurface, fontWeight: "800", fontSize: 15, marginBottom: 12, marginLeft: 4 }}>
                {t("detail.similar")}
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingRight: 8 }}>
                {similar.map((s) => (
                  <Pressable
                    key={s.source_id}
                    onPress={() =>
                      router.replace(
                        `/fashion/brand/${encodeURIComponent(s.source_id)}?title=${encodeURIComponent(s.brand_tr)}&season=${encodeURIComponent(s.season)}` as any,
                      )
                    }
                    style={{ width: 130 }}
                  >
                    <View style={{ width: 130, aspectRatio: 3 / 4, borderRadius: 4, overflow: "hidden", backgroundColor: colors.surfaceTertiary, borderWidth: 1, borderColor: colors.border }}>
                      {s.image ? (
                        <RetryImage uri={fashionImageUri(s.image)} style={{ width: "100%", height: "100%" }} contentFit="cover" transition={200} />
                      ) : null}
                    </View>
                    <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 12, fontWeight: "700", marginTop: 5 }}>
                      {s.brand_tr}
                    </Text>
                    <Text numberOfLines={1} style={{ color: colors.brandSecondary, fontSize: 11 }}>
                      {formatSeason(s.season, s.season_label)}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null
        }
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
            <Pressable
              testID="brand-viewer-save"
              onPress={() => setSaveSheetIndex(viewerIndex)}
              style={[styles.viewerClose, { top: insets.top + 12, left: 16, right: undefined }]}
              hitSlop={12}
            >
              <Feather
                name="bookmark"
                size={22}
                color={(savedKeys[`${id}#${viewerIndex}`]?.length ?? 0) > 0 ? "#fff" : "#fff"}
                style={{ opacity: (savedKeys[`${id}#${viewerIndex}`]?.length ?? 0) > 0 ? 1 : 0.55 }}
              />
            </Pressable>
          )}
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
                  // Tapping anywhere that isn't the zoomed photo — the dark
                  // margin, or the photo itself while not zoomed — closes the
                  // viewer (same as the X). Double-tap / pinch still zoom.
                  <Pressable
                    style={{ width, height, alignItems: "center", justifyContent: "center" }}
                    onPress={() => {
                      if (viewerZoomed) zoomRefs.current.get(viewerIndexRef.current ?? -1)?.resetZoom();
                      else setViewerIndex(null);
                    }}
                  >
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
                      onTap={() => setViewerIndex(null)}
                    />
                  </Pressable>
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

              {description ? (
                <Text style={[styles.viewerCounter, styles.viewerDescription, { bottom: insets.bottom + 60 }]}>
                  {description}
                </Text>
              ) : null}

              <Text style={styles.viewerCounter}>
                {t("detail.lookCounter", { n: viewerIndex + 1, total: images.length })}
              </Text>

              <Pressable
                testID="brand-viewer-describe"
                onPress={handleDescribe}
                disabled={describing}
                style={[styles.viewerZoomBtn, { position: "absolute", left: 16, bottom: insets.bottom + 24, opacity: describing ? 0.6 : 1 }]}
                hitSlop={10}
              >
                {describing ? <ActivityIndicator size="small" color="#fff" /> : <Feather name="message-circle" size={18} color="#fff" />}
              </Pressable>

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

      <SaveToBoardSheet
        visible={saveSheetIndex !== null}
        onClose={() => setSaveSheetIndex(null)}
        photo={
          saveSheetIndex !== null && images[saveSheetIndex]
            ? {
                source_id: id,
                photo_index: saveSheetIndex,
                image: images[saveSheetIndex],
                image_thumb: imagesThumb[saveSheetIndex] || images[saveSheetIndex],
                brand_tr: title,
                season: seasonRaw,
                season_label: season,
              }
            : null
        }
        savedBoardIds={saveSheetIndex !== null ? savedKeys[`${id}#${saveSheetIndex}`] || [] : []}
        onChange={refreshSaved}
      />

      {/* G2: "Bu kapak/marka yanlış" */}
      <Modal visible={reportOpen} transparent animationType="fade" onRequestClose={() => setReportOpen(false)}>
        <Pressable style={styles.reportOverlay} onPress={() => (reportSending ? null : setReportOpen(false))}>
          <View style={[styles.reportBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            {reportSent ? (
              <Text style={{ color: colors.onSurface, fontWeight: "700", textAlign: "center", paddingVertical: 8 }}>
                {t("detail.reportSent")}
              </Text>
            ) : (
              <>
                <Text style={{ color: colors.onSurface, fontWeight: "800", fontSize: 15, marginBottom: 12 }}>
                  {t("detail.reportTitle")}
                </Text>
                {(["wrong_cover", "wrong_brand", "other"] as const).map((reason) => (
                  <Pressable
                    key={reason}
                    testID={`report-${reason}`}
                    disabled={reportSending}
                    onPress={() => sendReport(reason)}
                    style={{ paddingVertical: 11 }}
                  >
                    <Text style={{ color: colors.onSurface, fontSize: 14 }}>{t(`detail.reportReason.${reason}`)}</Text>
                  </Pressable>
                ))}
                {reportSending && <ActivityIndicator color={colors.brand} style={{ marginTop: 8 }} />}
              </>
            )}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  reportOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", alignItems: "center", justifyContent: "center" },
  reportBox: { borderRadius: 12, borderWidth: 1, padding: 18, width: "80%", maxWidth: 340 },
  thumbSave: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 28,
    height: 28,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
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
  viewerDescription: {
    left: 24,
    right: 24,
    maxWidth: undefined,
    fontWeight: "600",
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
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
