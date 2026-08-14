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

async function probeImage(url: string) {
  if (!url) return false;
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
        img.onload = onOK;
        img.onerror = onFail;
        const t = setTimeout(() => onFail(), 4000);
        img.src = url;
        img.onload = () => {
          clearTimeout(t);
          onOK();
        };
        img.onerror = () => {
          clearTimeout(t);
          onFail();
        };
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
            const res = await fetch(`${base}/api/f
