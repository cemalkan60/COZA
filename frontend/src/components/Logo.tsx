import React from "react";
import { Text, View, StyleSheet } from "react-native";

import { useTheme } from "@/src/theme/ThemeContext";

export function Logo({
  size = 22,
  color,
  showDot = true,
}: {
  size?: number;
  color?: string;
  showDot?: boolean;
}) {
  const { colors } = useTheme();
  const c = color ?? colors.onSurface;
  return (
    <View style={styles.row} testID="coza-logo">
      <Text
        style={[
          styles.word,
          { color: c, fontSize: size, letterSpacing: size * 0.34 },
        ]}
      >
        COZA
      </Text>
      {showDot && (
        <View
          style={{
            width: size * 0.16,
            height: size * 0.16,
            borderRadius: size,
            backgroundColor: colors.brand,
            marginLeft: size * 0.18,
            marginBottom: size * 0.1,
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-end" },
  word: { fontWeight: "800" },
});
