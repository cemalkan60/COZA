// frontend/app/hub.tsx
import React from "react";
import { Pressable, StyleSheet, Text, View, Dimensions, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { useTheme } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";
import { Logo } from "@/src/components/Logo";

export default function Hub() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { signOut } = useAuth();

  const go = (href: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(href as any);
  };

  const { width, height } = Dimensions.get("window");
  const isNarrow = width < 760;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Watermark logo (hafif) */}
      <View pointerEvents="none" style={styles.watermark}>
        <Logo size={120} color={colors.surfaceSecondary} />
      </View>

      <View
        style={{
          flex: 1,
          paddingHorizontal: spacing.xl,
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 24,
          justifyContent: "center",
        }}
      >
        {/* Sign out */}
        <Pressable
          testID="hub-signout"
          onPress={() => signOut()}
          hitSlop={10}
          style={styles.signout}
        >
          <Feather name="log-out" size={18} color={colors.brandSecondary} />
        </Pressable>

        <View style={{ alignItems: "center", marginTop: 8, marginBottom: 8 }}>
          <Logo size={36} />
        </View>
        <Text style={[styles.subtitle, { color: colors.brandSecondary }]}>
          Nereye gitmek istiyorsunuz?
        </Text>

        {/* Two-column layout */}
        <View
          style={[
            styles.twoColWrap,
            { maxWidth: 1100, alignSelf: "center", gap: 12 },
            isNarrow ? styles.stack : styles.row,
          ]}
        >
          {/* LEFT: COZA ANALYSIS */}
          <Pressable
            testID="hub-analysis"
            onPress={() => go("/(tabs)")}
            style={({ pressed }) => [
              styles.colCard,
              {
                backgroundColor: colors.surfaceSecondary,
                borderColor: pressed ? colors.brand : colors.border,
                opacity: pressed ? 0.95 : 1,
                shadowColor: "#000",
              },
            ]}
          >
            <View style={styles.leftInner}>
              <View style={[styles.textBlock, { alignSelf: "flex-start" }]}>
                <Text style={[styles.colTitle, { color: colors.onSurface }]}>
                  COZA ANALYSIS
                </Text>
                <Text style={[styles.colDesc, { color: colors.brandSecondary }]}>
                  Zara Woman ürün, üretici ve üretim yeri analizleri
                </Text>
              </View>
            </View>
          </Pressable>

          {/* Vertical divider for wide screens */}
          {!isNarrow && <View style={[styles.divider, { backgroundColor: "#ffffff22" }]} />}

          {/* RIGHT: COZA FASHION */}
          <Pressable
            testID="hub-fashion"
            onPress={() => go("/fashion")}
            style={({ pressed }) => [
              styles.colCard,
              {
                backgroundColor: colors.surfaceSecondary,
                borderColor: pressed ? colors.brandSecondary : colors.border,
                opacity: pressed ? 0.95 : 1,
              },
            ]}
          >
            <View style={styles.rightInner}>
              <View style={[styles.textBlock, { alignSelf: "flex-start" }]}>
                <Text style={[styles.colTitle, { color: colors.onSurface }]}>
                  COZA FASHION
                </Text>
                <Text style={[styles.colDesc, { color: colors.brandSecondary }]}>
                  Haftalık defileler, sezonlar ve marka koleksiyonları
                </Text>
              </View>
            </View>
          </Pressable>
        </View>

        <Text style={[styles.footnote, { color: colors.brandSecondary }]}>
          İki bölüm birbirinden bağımsızdır. İstediğiniz zaman buraya dönebilirsiniz.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  watermark: {
    position: "absolute",
    top: 80,
    left: 0,
    right: 0,
    alignItems: "center",
    opacity: 0.45,
  },
  signout: { position: "absolute", top: 8, right: 0, padding: 8, zIndex: 2 },
  subtitle: {
    textAlign: "center",
    fontSize: 13,
    letterSpacing: 0.3,
    marginBottom: 24,
  },

  twoColWrap: {
    width: "100%",
    minHeight: 420,
    display: "flex",
  },
  row: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  stack: {
    flexDirection: "column",
  },
  colCard: {
    flex: 1,
    minHeight: 420,
    borderWidth: 1,
    borderRadius: 10,
    padding: 28,
    justifyContent: "center",
    // shadow for iOS
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6, // android
  },
  leftInner: {
    flex: 1,
    justifyContent: "center",
  },
  rightInner: {
    flex: 1,
    justifyContent: "center",
  },
  textBlock: {
    maxWidth: 520,
  },
  colTitle: {
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.5,
    marginBottom: 8,
  },
  colDesc: {
    fontSize: 14,
    lineHeight: 20,
  },
  divider: {
    width: 2,
    borderRadius: 2,
    marginHorizontal: 6,
  },
  footnote: {
    marginTop: 20,
    textAlign: "center",
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 12,
  },
});
