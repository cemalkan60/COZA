import React from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { useTheme } from "@/src/theme/ThemeContext";
import { useFavorites } from "@/src/context/FavoritesContext";
import { useCompare } from "@/src/context/CompareContext";
import { formatPrice } from "@/src/utils/format";
import type { Product } from "@/src/api/client";

const GUTTER = 12;
const H_PADDING = 16;

export function ProductCard({ product }: { product: Product }) {
  const { colors, spacing, radius, fontSize } = useTheme();
  const { isFavorite, toggle } = useFavorites();
  const compare = useCompare();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const cardWidth = (width - H_PADDING * 2 - GUTTER) / 2;

  const fav = isFavorite(product.product_id);
  const inCompare = compare.has(product.product_id);
  const code = product.manufacturer_code || product.supplier_code;

  return (
    <Pressable
      testID={`product-card-${product.product_id}`}
      onPress={() => router.push(`/product/${product.product_id}`)}
      style={{ width: cardWidth }}
    >
      <View
        style={[
          styles.imageWrap,
          { backgroundColor: colors.surfaceSecondary, borderRadius: radius.md },
        ]}
      >
        <Image
          source={{ uri: product.images[0] }}
          style={styles.image}
          contentFit="cover"
          transition={220}
        />

        {product.is_new && !product.removed && (
          <View style={[styles.newTag, { backgroundColor: colors.brand }]}>
            <Text style={[styles.newText, { color: colors.onBrand }]}>YENİ</Text>
          </View>
        )}

        {product.removed && (
          <>
            <View style={styles.removedOverlay} pointerEvents="none" />
            <View style={[styles.removedTag, { backgroundColor: colors.error }]}>
              <Feather name="slash" size={10} color={colors.onBrand} />
              <Text style={[styles.removedText, { color: colors.onBrand }]}>KALKTI</Text>
            </View>
          </>
        )}

        <Pressable
          testID={`favorite-toggle-${product.product_id}`}
          onPress={() => toggle(product.product_id)}
          hitSlop={8}
          style={[styles.overlayBtn, { top: 8, right: 8, backgroundColor: colors.surface + "E6" }]}
        >
          <Feather name="heart" size={15} color={fav ? colors.brand : colors.onSurfaceTertiary} />
        </Pressable>

        <Pressable
          testID={`compare-toggle-${product.product_id}`}
          onPress={() => compare.toggle(product.product_id)}
          hitSlop={8}
          style={[
            styles.overlayBtn,
            { top: 44, right: 8, backgroundColor: inCompare ? colors.brand : colors.surface + "E6" },
          ]}
        >
          <Feather name="columns" size={14} color={inCompare ? colors.onBrand : colors.onSurfaceTertiary} />
        </Pressable>

        <View style={[styles.originTag, { backgroundColor: colors.surface + "E6" }]}>
          <Text style={[styles.originText, { color: colors.onSurfaceSecondary }]}>
            {product.origin.toLocaleUpperCase("tr-TR")}
          </Text>
        </View>
      </View>

      <Text
        numberOfLines={1}
        style={[styles.name, { color: colors.onSurface, fontSize: fontSize.sm, marginTop: spacing.sm }]}
      >
        {product.name}
      </Text>
      <Text style={[styles.price, { color: colors.onSurfaceSecondary, fontSize: fontSize.sm }]}>
        {formatPrice(product.price, product.currency)}
      </Text>
      <Pressable
        testID={`card-code-${product.product_id}`}
        onPress={() => router.push(`/factory/${code}`)}
        hitSlop={6}
      >
        <Text style={[styles.code, { color: colors.brandSecondary, fontSize: fontSize.xs }]}>
          #{code} ›
        </Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  imageWrap: {
    width: "100%",
    aspectRatio: 3 / 4,
    overflow: "hidden",
    position: "relative",
  },
  image: { width: "100%", height: "100%" },
  overlayBtn: {
    position: "absolute",
    width: 30,
    height: 30,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  newTag: {
    position: "absolute",
    top: 8,
    left: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 2,
  },
  newText: { fontSize: 9, fontWeight: "800", letterSpacing: 0.8 },
  removedOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  removedTag: {
    position: "absolute",
    top: 8,
    left: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 2,
  },
  removedText: { fontSize: 9, fontWeight: "800", letterSpacing: 0.8 },
  originTag: {
    position: "absolute",
    bottom: 8,
    left: 8,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 2,
  },
  originText: { fontSize: 9, fontWeight: "700", letterSpacing: 0.6 },
  name: { fontWeight: "500", letterSpacing: 0.2 },
  price: { fontWeight: "600", marginTop: 2 },
  code: { marginTop: 3, letterSpacing: 0.5, fontWeight: "700" },
});
