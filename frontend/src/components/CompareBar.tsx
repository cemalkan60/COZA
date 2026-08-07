import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { useTheme } from "@/src/theme/ThemeContext";
import { useCompare } from "@/src/context/CompareContext";

export function CompareBar() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const compare = useCompare();

  if (compare.ids.length === 0) return null;

  return (
    <View
      testID="compare-bar"
      style={[
        styles.wrap,
        { bottom: insets.bottom + 16, backgroundColor: colors.surfaceInverse, borderColor: colors.borderStrong },
      ]}
    >
      <Pressable onPress={compare.clear} hitSlop={8} style={styles.clear}>
        <Feather name="x" size={16} color={colors.onSurfaceInverse} />
      </Pressable>
      <Text style={[styles.label, { color: colors.onSurfaceInverse }]}>
        Kıyasla · {compare.ids.length}/2
      </Text>
      <Pressable
        testID="compare-go"
        disabled={!compare.full}
        onPress={() => router.push("/compare")}
        style={[styles.go, { backgroundColor: compare.full ? colors.brand : colors.surfaceTertiary }]}
      >
        <Text style={{ color: compare.full ? colors.onBrand : colors.brandSecondary, fontWeight: "800" }}>
          Karşılaştır
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    height: 54,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 14,
  },
  clear: { padding: 4 },
  label: { flex: 1, fontWeight: "700", letterSpacing: 0.3 },
  go: { height: 38, paddingHorizontal: 18, borderRadius: 4, alignItems: "center", justifyContent: "center" },
});
