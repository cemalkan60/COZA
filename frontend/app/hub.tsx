// frontend/app/hub.tsx
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Haptics from "expo-haptics";
import Svg, { Line } from "react-native-svg";
import { useFonts } from "expo-font";
import { PlayfairDisplay_800ExtraBold_Italic } from "@expo-google-fonts/playfair-display";
import { PinyonScript_400Regular } from "@expo-google-fonts/pinyon-script";

const BG = "#0B0B0C";
const FG = "#F5F5F3";
const LINE = "rgba(255,255,255,0.4)";

export default function Hub() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [layout, setLayout] = useState({ w: 0, h: 0 });
  const [fontsLoaded] = useFonts({ PlayfairDisplay_800ExtraBold_Italic, PinyonScript_400Regular });

  const go = (href: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(href as any);
  };

  const brandSize = clamp(width * 0.045, 14, 22);
  const analysisSize = clamp(width * 0.15, 40, 84);
  const fashionSize = clamp(width * 0.19, 52, 108);

  if (!fontsLoaded) return <View style={styles.page} />;

  return (
    <View
      style={styles.page}
      onLayout={(e) => setLayout({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      <StatusBar style="light" />
      {layout.w > 0 && (
        <Svg width={layout.w} height={layout.h} style={StyleSheet.absoluteFill} pointerEvents="none">
          <Line
            x1={layout.w * 0.27}
            y1={layout.h}
            x2={layout.w * 0.76}
            y2={0}
            stroke={LINE}
            strokeWidth={1}
          />
        </Svg>
      )}

      <Pressable testID="hub-analysis" onPress={() => go("/(tabs)")} style={[styles.zone, styles.analysisZone]} hitSlop={20}>
        <Text style={[styles.brand, { fontSize: brandSize, letterSpacing: brandSize * 0.5 }]}>MadeIn</Text>
        <Text
          style={[
            styles.analysisWord,
            { fontSize: analysisSize, lineHeight: analysisSize * 1.05 },
          ]}
        >
          Analysis
        </Text>
      </Pressable>

      <Pressable testID="hub-fashion" onPress={() => go("/fashion")} style={[styles.zone, styles.fashionZone]} hitSlop={20}>
        <Text style={[styles.brand, { fontSize: brandSize, letterSpacing: brandSize * 0.5 }]}>COZA</Text>
        <Text
          style={[
            styles.fashionWord,
            { fontSize: fashionSize, lineHeight: fashionSize * 1.1 },
          ]}
        >
          Fashion
        </Text>
      </Pressable>
    </View>
  );
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(v, max));
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: BG },
  zone: { position: "absolute", maxWidth: "70%" },
  analysisZone: { left: "8%", top: "40%", alignItems: "flex-start" },
  fashionZone: { right: "8%", top: "67%", alignItems: "flex-end" },
  brand: { color: FG, fontWeight: "600" },
  analysisWord: {
    color: FG,
    fontFamily: "PlayfairDisplay_800ExtraBold_Italic",
    marginTop: 6,
  },
  fashionWord: {
    color: FG,
    fontFamily: "PinyonScript_400Regular",
    marginTop: 6,
    textAlign: "right",
  },
});
