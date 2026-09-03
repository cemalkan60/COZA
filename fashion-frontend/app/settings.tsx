// frontend/app/settings.tsx
import React, { useCallback, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { api } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";
import { formatDate } from "@/src/utils/format";

export default function Settings() {
  const { colors, spacing, mode, toggle } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, signOut } = useAuth();
  const isAdmin = user?.role === "admin";

  const [meta, setMeta] = useState<any>(null);
  const [scraping, setScraping] = useState(false);
  const [scrapeMsg, setScrapeMsg] = useState("");

  const loadMeta = useCallback(async () => {
    try {
      setMeta(await api.fashionMeta());
    } catch {
      // ignore
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadMeta();
    }, [loadMeta]),
  );

  const triggerScrape = async () => {
    setScraping(true);
    setScrapeMsg("");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await api.fashionScrape();
      setScrapeMsg("Tarama başlatıldı — birkaç dakika sürebilir, bittiğinde bu sayfayı yenileyin.");
    } catch {
      setScrapeMsg("Başlatılamadı, tekrar deneyin.");
    } finally {
      setScraping(false);
    }
  };

  const logout = async () => {
    await signOut();
    router.replace("/(auth)/login");
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface, paddingTop: insets.top + 12 }}>
      <View
        style={[
          styles.header,
          { paddingHorizontal: spacing.xl, borderBottomColor: colors.divider },
        ]}
      >
        <Pressable testID="settings-back" onPress={() => router.back()} hitSlop={10}>
          <Feather name="chevron-left" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={[styles.title, { color: colors.onSurface }]}>Ayarlar</Text>
        <View style={{ width: 26 }} />
      </View>

      <Text style={{ color: colors.brandSecondary, fontSize: 12, marginTop: 20, marginHorizontal: spacing.xl }}>
        {user?.name || user?.email}
      </Text>

      <View style={{ paddingHorizontal: spacing.xl, marginTop: 20 }}>
        <View style={[styles.row, { borderColor: colors.border }]}>
          <Feather name={mode === "dark" ? "moon" : "sun"} size={18} color={colors.onSurfaceSecondary} />
          <Text style={{ color: colors.onSurface, fontWeight: "600", flex: 1, marginLeft: 12 }}>
            {mode === "dark" ? "Koyu Mod" : "Açık Mod"}
          </Text>
          <Switch
            testID="theme-toggle"
            value={mode === "dark"}
            onValueChange={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              toggle();
            }}
            trackColor={{ true: colors.brand, false: colors.surfaceTertiary }}
            thumbColor={colors.surface}
          />
        </View>

        {isAdmin && (
          <>
            <View style={[styles.metaCard, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}>
              <View style={styles.metaRow}>
                <Text style={{ color: colors.brandSecondary, fontSize: 12 }}>Toplam koleksiyon</Text>
                <Text style={{ color: colors.onSurface, fontWeight: "700" }}>{meta?.item_count ?? "—"}</Text>
              </View>
              <View style={[styles.metaRow, { marginTop: 10 }]}>
                <Text style={{ color: colors.brandSecondary, fontSize: 12 }}>Son güncelleme</Text>
                <Text style={{ color: colors.onSurface, fontWeight: "700" }}>{formatDate(meta?.last_scrape)}</Text>
              </View>
            </View>

            <Pressable
              testID="fashion-refresh-data"
              onPress={triggerScrape}
              disabled={scraping}
              style={[styles.refreshBtn, { borderColor: colors.border, opacity: scraping ? 0.6 : 1 }]}
            >
              <Feather name="refresh-cw" size={16} color={colors.onSurface} />
              <Text style={{ color: colors.onSurface, fontWeight: "700", marginLeft: 8 }}>
                {scraping ? "Başlatılıyor…" : "Şimdi Güncelle"}
              </Text>
            </Pressable>
            {!!scrapeMsg && (
              <Text style={{ color: colors.brandSecondary, fontSize: 11, marginTop: 8, textAlign: "center" }}>
                {scrapeMsg}
              </Text>
            )}
          </>
        )}

        <Pressable
          testID="logout"
          onPress={logout}
          style={[styles.logout, { borderColor: colors.border }]}
        >
          <Feather name="log-out" size={16} color={colors.error} />
          <Text style={{ color: colors.error, fontWeight: "700", marginLeft: 8 }}>Çıkış Yap</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  title: { fontSize: 16, fontWeight: "800" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    height: 52,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
  },
  metaCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    marginTop: 14,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  refreshBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 48,
    borderWidth: 1,
    borderRadius: 8,
    marginTop: 10,
  },
  logout: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 48,
    borderWidth: 1,
    borderRadius: 8,
    marginTop: 14,
  },
});
