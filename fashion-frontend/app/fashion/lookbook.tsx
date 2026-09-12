// frontend/app/fashion/lookbook.tsx — F1: "PDF lookbook" + layout options.
//
// No PDF-generation dependency is installed in this project (expo-print
// isn't in package.json, and adding a new native module here isn't safe
// without running `expo install` to update the lockfile — see the
// COZA-YOL-HARITASI.md notes). So on web this uses the browser's own
// print dialog ("Save as PDF" is built into every browser's print sheet)
// against a clean, print-friendly layout — genuinely produces a PDF,
// just via the OS/browser instead of an in-app library. Native has no
// equivalent print API, so it falls back to the existing share sheet
// (shareBoard.ts).
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api, SavedPhoto } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useT } from "@/src/i18n";
import { fashionImageUri } from "@/src/utils/fashionImage";
import { goBack } from "@/src/utils/nav";
import { shareBoard } from "@/src/utils/shareBoard";

type Layout = "single" | "double" | "contact";

export default function Lookbook() {
  const { colors, spacing } = useTheme();
  const { t, formatSeason } = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams();
  const boardId = (params.board as string) || "";

  const [boardName, setBoardName] = useState("");
  const [photos, setPhotos] = useState<SavedPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [layout, setLayout] = useState<Layout>("contact");

  useEffect(() => {
    if (!boardId) return;
    Promise.all([api.boardsList(), api.boardPhotos(boardId)])
      .then(([bl, ph]) => {
        setBoardName(bl.boards?.find((b) => b.id === boardId)?.name || "COZA");
        setPhotos(ph.items || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [boardId]);

  const cols = layout === "single" ? 1 : layout === "double" ? 2 : 4;

  return (
    <View style={{ flex: 1, backgroundColor: "#fff" }}>
      <View style={[styles.header, { paddingTop: insets.top + 8, paddingHorizontal: spacing.xl, borderBottomColor: colors.divider }]}>
        <Pressable testID="lookbook-back" onPress={() => goBack(router, `/fashion/boards?board=${encodeURIComponent(boardId)}`)} hitSlop={10}>
          <Feather name="chevron-left" size={26} color={colors.onSurface} />
        </Pressable>
        <Text numberOfLines={1} style={{ flex: 1, textAlign: "center", color: colors.onSurface, fontWeight: "800", fontSize: 15 }}>
          {t("lookbook.title")}
        </Text>
        <View style={{ width: 26 }} />
      </View>

      {Platform.OS === "web" ? (
        <>
          <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: spacing.xl, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
            {(["single", "double", "contact"] as Layout[]).map((l) => (
              <Pressable
                key={l}
                testID={`lookbook-layout-${l}`}
                onPress={() => setLayout(l)}
                style={[
                  styles.layoutBtn,
                  { borderColor: layout === l ? colors.brand : colors.border, backgroundColor: layout === l ? colors.brand : "transparent" },
                ]}
              >
                <Text style={{ color: layout === l ? colors.onBrand : colors.onSurface, fontWeight: "700", fontSize: 12 }}>
                  {t(`lookbook.layout.${l}`)}
                </Text>
              </Pressable>
            ))}
            <View style={{ flex: 1 }} />
            <Pressable
              testID="lookbook-print"
              onPress={() => (typeof window !== "undefined" ? window.print() : null)}
              style={[styles.layoutBtn, { borderColor: colors.brand, backgroundColor: colors.brand }]}
            >
              <Text style={{ color: colors.onBrand, fontWeight: "700", fontSize: 12 }}>{t("lookbook.print")}</Text>
            </Pressable>
          </View>

          {loading ? (
            <View style={{ padding: 40, alignItems: "center" }}>
              <ActivityIndicator color={colors.brand} />
            </View>
          ) : (
            <ScrollView contentContainerStyle={{ padding: 24 }}>
              <Text style={{ fontSize: 22, fontWeight: "800", color: "#0a0a0a", marginBottom: 4 }}>{boardName}</Text>
              <Text style={{ fontSize: 12, color: "#666", marginBottom: 20 }}>COZA · {photos.length}</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
                {photos.map((p, i) => (
                  <View key={`${p.source_id}#${p.photo_index}`} style={{ width: `${100 / cols - 2}%` }}>
                    <Image
                      source={{ uri: fashionImageUri(p.image_thumb || p.image) }}
                      style={{ width: "100%", aspectRatio: 3 / 4, backgroundColor: "#eee", borderRadius: 2 }}
                      contentFit="cover"
                      loading="eager"
                    />
                    <Text numberOfLines={1} style={{ fontSize: 11, color: "#333", marginTop: 4, fontWeight: "700" }}>
                      {layout === "contact" ? `${i + 1}. ` : ""}
                      {p.brand_tr || "—"}
                      {p.season ? ` · ${formatSeason(p.season, p.season_label)}` : ""}
                    </Text>
                  </View>
                ))}
              </View>
            </ScrollView>
          )}
        </>
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
          <Feather name="printer" size={28} color={colors.brandSecondary} />
          <Text style={{ color: colors.brandSecondary, textAlign: "center", marginTop: 14, lineHeight: 20 }}>
            {t("lookbook.webOnly")}
          </Text>
          <Pressable
            testID="lookbook-share-fallback"
            onPress={() => shareBoard(boardName, photos)}
            style={{ marginTop: 18, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 20 }}
          >
            <Text style={{ color: colors.onSurface, fontWeight: "700" }}>{t("boards.share")}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", paddingBottom: 12, borderBottomWidth: 1 },
  layoutBtn: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
});
