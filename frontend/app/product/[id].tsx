import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { api, Product } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useFavorites } from "@/src/context/FavoritesContext";
import { formatPrice } from "@/src/utils/format";

export default function ProductDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, spacing, fontSize } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { isFavorite, toggle } = useFavorites();

  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    api
      .product(String(id))
      .then(setProduct)
      .catch(() => setProduct(null))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }

  if (!product) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <Text style={{ color: colors.onSurface }}>Ürün bulunamadı.</Text>
        <Pressable onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: colors.brand, fontWeight: "700" }}>Geri Dön</Text>
        </Pressable>
      </View>
    );
  }

  const fav = isFavorite(product.product_id);
  const imgH = width * 1.28;

  const openZara = () => {
    if (product.seo_keyword && product.seo_product_id) {
      Linking.openURL(
        `https://www.zara.com/tr/tr/${product.seo_keyword}-p${product.seo_product_id}.html`,
      );
    }
  };

  const details: { label: string; value: string; icon: any }[] = [
    { label: "Üretim Yeri", value: product.origin, icon: "map-pin" },
    { label: "Tedarikçi Kodu", value: product.supplier_code, icon: "hash" },
    { label: "Referans", value: product.display_reference || product.reference, icon: "tag" },
    { label: "Renk", value: product.color || "—", icon: "droplet" },
    { label: "Kategori", value: product.category, icon: "grid" },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
        {/* Gallery */}
        <View>
          <FlatList
            data={product.images.length ? product.images : [""]}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            keyExtractor={(_, i) => String(i)}
            onMomentumScrollEnd={(e) =>
              setIndex(Math.round(e.nativeEvent.contentOffset.x / width))
            }
            renderItem={({ item }) => (
              <Image
                source={{ uri: item }}
                style={{ width, height: imgH, backgroundColor: colors.surfaceSecondary }}
                contentFit="cover"
                transition={200}
              />
            )}
          />
          {product.images.length > 1 && (
            <View style={styles.dots}>
              {product.images.map((_, i) => (
                <View
                  key={i}
                  style={{
                    width: i === index ? 18 : 6,
                    height: 6,
                    borderRadius: 999,
                    backgroundColor: i === index ? colors.brand : colors.surface + "AA",
                  }}
                />
              ))}
            </View>
          )}
        </View>

        {/* Info */}
        <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.xl }}>
          <Text style={[styles.family, { color: colors.brandSecondary }]}>
            {(product.family || product.category).toLocaleUpperCase("tr-TR")}
          </Text>
          <Text style={[styles.name, { color: colors.onSurface }]}>{product.name}</Text>
          <Text style={[styles.price, { color: colors.onSurface }]}>
            {formatPrice(product.price, product.currency)}
          </Text>

          <View style={[styles.detailBox, { borderColor: colors.border }]}>
            {details.map((d, i) => (
              <View
                key={d.label}
                style={[
                  styles.detailRow,
                  i < details.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.divider },
                ]}
              >
                <View style={styles.detailLeft}>
                  <Feather name={d.icon} size={15} color={colors.brandSecondary} />
                  <Text style={[styles.detailLabel, { color: colors.brandSecondary }]}>{d.label}</Text>
                </View>
                <Text style={[styles.detailValue, { color: colors.onSurface }]} numberOfLines={1}>
                  {d.value}
                </Text>
              </View>
            ))}
          </View>

          <Text style={[styles.originNote, { color: colors.brandSecondary }]}>
            Üretim yeri, ürün referans kodundan Inditex tedarik dağılımına göre modellenmiştir.
          </Text>
        </View>
      </ScrollView>

      {/* Top overlay controls */}
      <View style={[styles.topBar, { paddingTop: insets.top + 6, paddingHorizontal: spacing.lg }]}>
        <Pressable
          testID="pdp-back"
          onPress={() => router.back()}
          style={[styles.circle, { backgroundColor: colors.surface + "E6" }]}
        >
          <Feather name="chevron-left" size={22} color={colors.onSurface} />
        </Pressable>
      </View>

      {/* Sticky bottom actions */}
      <View
        style={[
          styles.bottomBar,
          { backgroundColor: colors.surface, borderTopColor: colors.divider, paddingBottom: insets.bottom + 12 },
        ]}
      >
        <Pressable
          testID="pdp-favorite"
          onPress={() => toggle(product.product_id)}
          style={[
            styles.favBtn,
            { backgroundColor: fav ? colors.surfaceSecondary : colors.brand, borderColor: colors.border, borderWidth: fav ? 1 : 0 },
          ]}
        >
          <Feather name="heart" size={17} color={fav ? colors.brand : colors.onBrand} />
          <Text
            style={{
              color: fav ? colors.onSurface : colors.onBrand,
              fontWeight: "800",
              marginLeft: 8,
              letterSpacing: 0.3,
            }}
          >
            {fav ? "Favorilerde" : "Favorilere Ekle"}
          </Text>
        </Pressable>
        <Pressable
          testID="pdp-open-zara"
          onPress={openZara}
          style={[styles.zaraBtn, { borderColor: colors.border }]}
        >
          <Feather name="external-link" size={18} color={colors.onSurface} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  dots: {
    position: "absolute",
    bottom: 14,
    alignSelf: "center",
    flexDirection: "row",
    gap: 5,
  },
  family: { fontSize: 11, letterSpacing: 1.4, fontWeight: "700" },
  name: { fontSize: 20, fontWeight: "700", letterSpacing: -0.2, marginTop: 8, lineHeight: 27 },
  price: { fontSize: 22, fontWeight: "800", letterSpacing: -0.4, marginTop: 12 },
  detailBox: { borderWidth: 1, borderRadius: 4, marginTop: 24 },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 15,
    paddingHorizontal: 16,
  },
  detailLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  detailLabel: { fontSize: 13, fontWeight: "500" },
  detailValue: { fontSize: 14, fontWeight: "700", maxWidth: "55%" },
  originNote: { fontSize: 11, lineHeight: 16, marginTop: 16 },
  topBar: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row" },
  circle: { width: 40, height: 40, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 24,
    paddingTop: 14,
    borderTopWidth: 1,
  },
  favBtn: {
    flex: 1,
    height: 54,
    borderRadius: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  zaraBtn: {
    width: 54,
    height: 54,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
