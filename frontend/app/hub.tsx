// frontend/app/hub.tsx
import React from "react";
import { Pressable, StyleSheet, Text, View, Dimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";

import { useTheme } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";

export default function Hub() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { signOut } = useAuth();

  const go = (href: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(href as any);
  };

  const { width } = Dimensions.get("window");
  const isNarrow = width < 760;

  return (
    <View style={[styles.page, { backgroundColor: colors.surface }]}>
      <View style={[styles.inner, { paddingTop: insets.top + 24, paddingHorizontal: spacing.xl }]}>
        <View style={[styles.row, isNarrow && styles.column]}>
          <Pressable
            testID="hub-analysis"
            onPress={() => go("/(tabs)")}
            style={({ pressed }) => [{ paddingVertical: 40, paddingHorizontal: 20 }]}
          >
            <Text style={[styles.bigText, { color: colors.onSurface }]}>COZA ANALYSIS</Text>
          </Pressable>

          <Pressable
            testID="hub-fashion"
            onPress={() => go("/fashion")}
            style={({ pressed }) => [{ paddingVertical: 40, paddingHorizontal: 20 }]}
          >
            <Text style={[styles.bigText, { color: colors.onSurface }]}>COZA FASHION</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  inner: { flex: 1, justifyContent: "center", alignItems: "center" },
  row: { width: "100%", maxWidth: 1100, flexDirection: "row", justifyContent: "space-between" },
  column: { flexDirection: "column", alignItems: "flex-start" },
  bigText: {
    fontSize: 40,
    fontWeight: "900",
    letterSpacing: -1,
  },
});
