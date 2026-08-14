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
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <View
        style={{
          flex: 1,
          paddingHorizontal: spacing.xl,
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 24,
          justifyContent: "center",
        }}
      >
        {/* Sign out kept as-is */}
        <View style={{ position: "absolute", top: 8, right: 0, padding: 8, zIndex: 2 }}>
          {/* sign out handled elsewhere; leaving placeholder so layout doesn't shift */}
        </View>

        <View style={{ alignItems: "center", marginTop: 8, marginBottom: 8 }} />

        {/* Two-column layout simplified */}
        <View
          style={[
            styles.twoColWrap,
            { maxWidth: 1100, alignSelf: "center", gap: 12 },
            isNarrow ? styles.stack : styles.row,
          ]}
        >
          {/* LEFT: COZA ANALYSIS (only title) */}
          <Pressable
            testID="hub-analysis"
            onPress={() => go("/(tabs)")}
            style={({ pressed }) => [
              styles.simpleCard,
              {
                backgroundColor: colors.surfaceSecondary,
                opacity: pressed ? 0.95 : 1,
              },
            ]}
          >
            <Text style={[styles.onlyTitle, { color: colors.onSurface }]}>COZA ANALYSIS</Text>
          </Pressable>

          {/* RIGHT: COZA FASHION (only title) */}
          <Pressable
            testID="hub-fashion"
            onPress={() => go("/fashion")}
            style={({ pressed }) => [
              styles.simpleCard,
              {
                backgroundColor: colors.surfaceSecondary,
                opacity: pressed ? 0.95 : 1,
              },
            ]}
          >
            <Text style={[styles.onlyTitle, { color: colors.onSurface }]}>COZA FASHION</Text>
          </Pressable>
        </View>

        {/* Footnote removed per request (if you want it back, say) */}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  twoColWrap: {
    width: "100%",
    minHeight: 360,
    display: "flex",
  },
  row: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  stack: {
    flexDirection: "column",
  },
  simpleCard: {
    flex: 1,
    minHeight: 320,
    borderRadius: 8,
    padding: 20,
    justifyContent: "center",
    alignItems: "flex-start",
  },
  onlyTitle: {
    fontSize: 30,
    fontWeight: "900",
    letterSpacing: -0.5,
    paddingLeft: 8,
  },
});
