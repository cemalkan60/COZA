// frontend/app/hub.tsx
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { useTheme } from "@/src/theme/ThemeContext";

export default function Hub() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const go = (href: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(href as any);
  };

  return (
    <View style={[styles.page, { backgroundColor: colors.surface }]}>
      <View style={styles.row}>
        <Pressable
          testID="hub-analysis"
          onPress={() => go("/(tabs)")}
          style={({ pressed }) => [
            styles.half,
            { paddingTop: insets.top, paddingBottom: insets.bottom, opacity: pressed ? 0.75 : 1 },
          ]}
        >
          <Feather name="pie-chart" size={40} color={colors.onSurface} style={styles.icon} />
          <Text style={[styles.bigText, { color: colors.onSurface }]}>COZA{"\n"}ANALYSIS</Text>
          <Text style={[styles.caption, { color: colors.brandSecondary }]}>Analiz</Text>
        </Pressable>

        <View style={[styles.divider, { borderColor: colors.border }]} />

        <Pressable
          testID="hub-fashion"
          onPress={() => go("/fashion")}
          style={({ pressed }) => [
            styles.half,
            { paddingTop: insets.top, paddingBottom: insets.bottom, opacity: pressed ? 0.75 : 1 },
          ]}
        >
          <Feather name="camera" size={40} color={colors.onSurface} style={styles.icon} />
          <Text style={[styles.bigText, { color: colors.onSurface }]}>COZA{"\n"}FASHION</Text>
          <Text style={[styles.caption, { color: colors.brandSecondary }]}>Moda</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  row: { flex: 1, flexDirection: "row" },
  half: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  divider: { width: 0, borderLeftWidth: 1, borderStyle: "dashed" },
  icon: { marginBottom: 18 },
  bigText: {
    fontSize: 26,
    fontWeight: "900",
    letterSpacing: -0.5,
    textAlign: "center",
    lineHeight: 32,
  },
  caption: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginTop: 10,
  },
});
