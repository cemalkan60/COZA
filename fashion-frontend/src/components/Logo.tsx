import React from "react";
import { Pressable, Text, View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";

import { useTheme } from "@/src/theme/ThemeContext";

export function Logo({
  size = 22,
  color,
  home = false,
  onPress,
}: {
  size?: number;
  color?: string;
  home?: boolean;
  onPress?: () => void;
}) {
  const { colors } = useTheme();
  const router = useRouter();
  const c = color ?? colors.onSurface;

  const handler = onPress ?? (home ? () => router.navigate("/fashion") : undefined);

  const word = (
    <Text
      style={[
        styles.word,
        { color: c, fontSize: size, letterSpacing: size * 0.44, paddingLeft: size * 0.44 },
      ]}
    >
      COZA
    </Text>
  );

  if (handler) {
    return (
      <Pressable testID="coza-logo" onPress={handler} hitSlop={8}>
        {word}
      </Pressable>
    );
  }
  return (
    <View testID="coza-logo" style={styles.row}>
      {word}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  word: { fontWeight: "500" },
});
