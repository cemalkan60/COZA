import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
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

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Faint watermark logo */}
      <View pointerEvents="none" style={styles.watermark}>
        <Logo size={110} color={colors.surfaceSecondary} />
      </View>

      <View
        style={{
          flex: 1,
          paddingHorizontal: spacing.xl,
          paddingTop: insets.top + 40,
          paddingBottom: insets.bottom + 24,
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
          <Logo size={40} />
        </View>
        <Text style={[styles.subtitle, { color: colors.brandSecondary }]}>
          Nereye gitmek istiyorsunuz?
        </Text>

        <View style={styles.cards}>
          <HubCard
            testID="hub-analysis"
            icon="bar-chart-2"
            title="COZA Analiz"
            desc="Zara Woman ürün, üretici ve üretim yeri analizleri"
            colors={colors}
            onPress={() => go("/(tabs)")}
          />
          <HubCard
            testID="hub-fashion"
            icon="feather"
            title="COZA Moda"
            desc="Haftalık defileler, sezonlar ve marka koleksiyonları"
            colors={colors}
            accent
            onPress={() => go("/fashion")}
          />
        </View>

        <Text style={[styles.footnote, { color: colors.brandSecondary }]}>
          İki bölüm birbirinden bağımsızdır. İstediğiniz zaman buraya dönebilirsiniz.
        </Text>
      </View>
    </View>
  );
}

function HubCard({
  icon,
  title,
  desc,
  colors,
  onPress,
  accent,
  testID,
}: {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  desc: string;
  colors: any;
  onPress: () => void;
  accent?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          borderColor: accent ? colors.brand : colors.border,
          backgroundColor: colors.surfaceSecondary,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <View
        style={[
          styles.iconWrap,
          { backgroundColor: accent ? colors.brand : colors.surfaceTertiary },
        ]}
      >
        <Feather
          name={icon}
          size={26}
          color={accent ? colors.onBrand : colors.onSurface}
        />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.cardTitle, { color: colors.onSurface }]}>{title}</Text>
        <Text style={[styles.cardDesc, { color: colors.brandSecondary }]}>{desc}</Text>
      </View>
      <Feather name="chevron-right" size={22} color={colors.brandSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  watermark: {
    position: "absolute",
    top: 90,
    left: 0,
    right: 0,
    alignItems: "center",
    opacity: 0.5,
  },
  signout: { position: "absolute", top: 8, right: 0, padding: 8, zIndex: 2 },
  subtitle: {
    textAlign: "center",
    fontSize: 13,
    letterSpacing: 0.3,
    marginBottom: 40,
  },
  cards: { gap: 16 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    borderWidth: 1,
    borderRadius: 8,
    padding: 20,
  },
  iconWrap: {
    width: 54,
    height: 54,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: { fontSize: 18, fontWeight: "800", letterSpacing: -0.3 },
  cardDesc: { fontSize: 12, lineHeight: 17, marginTop: 4 },
  footnote: {
    marginTop: "auto",
    textAlign: "center",
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 12,
  },
});
