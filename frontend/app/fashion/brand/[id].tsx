// frontend/app/fashion/brand/[id].tsx
import React, { useEffect, useState } from "react";
import {
  View,
  FlatList,
  Image as RNImage,
  Dimensions,
  ActivityIndicator,
  StyleSheet,
  Text,
  Platform,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useTheme } from "@/src/theme/ThemeContext";

const { width } = Dimensions.get("window");

// SSR-safe image probe
async function probeImage(url: string) {
  if (!url) return false;
  // If server-side render, don't try DOM APIs
  if (typeof window === "undefined") return false;

  if (Platform.OS === "web") {
    return await new Promise<boolean>((resolve) => {
      try {
        const img = new (window as any).Image();
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

function makeCandidates(original: string) {
  if (!original) return [original];
  const cands = new Set<string>();
  cands.add(original);
  const re = /\/w(\d+)_/;
  const m = original.match(re);
  if (m) {
    const sizes = ["768", "1024", "1200", "0"];
    sizes.forEach((s) => cands.add(original.replace(re, `/${"w" + s}_`)));
  } else {
    cands.add(original.replace("/w300_top", "/w768_top"));
    cands.add(original.replace("/w300_top", "/w1200_top"));
  }
  return Array.from(cands);
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
  const { colors } = useTheme();
  const id = (params.id as string) || "";
  const primaryImgParam = (params.img as string) || "";
  const title = (params.title as string) || "";

  const primaryImg = primaryImgParam ? decodeURIComponent(primaryImgParam) : "";
  const [images, setImages] = useState<string[]>(primaryImg ? [primaryImg] : []);
  const [loading, setLoading] = useState(true);

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

  if (loading) return <ActivityIndicator style={{ marginTop: 60 }} color={colors.brand} />;

  if (!images.length) {
    return (
      <View style={[styles.noContent, { backgroundColor: colors.surface }]}>
        <Text style={{ color: colors.brandSecondary }}>Bu koleksiyona ait görsel bulunamadı.</Text>
      </View>
    );
  }

  const renderItem = ({ item }: { item: string }) => {
    if (Platform.OS === "web") {
      return (
        // use native <img> on web for reliable sizing/quality
        <div style={{ width, height: width * 0.85, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <img
            src={item}
            alt=""
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", backgroundColor: colors.surface }}
          />
        </div>
      );
    }
    return <RNImage source={{ uri: item }} style={{ width, height: width * 0.85 }} resizeMode="contain" />;
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.surface }]}>
      {title ? <Text style={[styles.title, { color: colors.onSurface }]}>{decodeURIComponent(title)}</Text> : null}
      <FlatList
        data={images}
        keyExtractor={(_, i) => String(i)}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        renderItem={({ item }) => renderItem({ item })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "flex-start" },
  title: { fontSize: 18, fontWeight: "800", marginTop: 16, marginBottom: 8 },
  noContent: { flex: 1, alignItems: "center", justifyContent: "center" },
});
