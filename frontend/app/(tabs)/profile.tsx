import React, { useCallback, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { api } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";
import { useFavorites } from "@/src/context/FavoritesContext";
import { Logo } from "@/src/components/Logo";
import { formatDate } from "@/src/utils/format";

export default function Profile() {
  const { colors, spacing, fontSize, mode, toggle } = useTheme();
  const insets = useSafeAreaInsets();
  const { user, signOut } = useAuth();
  const { count } = useFavorites();
  const router = useRouter();

  const [meta, setMeta] = useState<any>(null);
  const [scraping, setScraping] = useState(false);

  const loadMeta = useCallback(async () => {
    try {
      setMeta(await api.meta());
    } catch {
      // ignore
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadMeta();
    }, [loadMeta]),
  );

  const refreshData = async () => {
    setScraping(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await api.scrape();
      await loadMeta();
    } catch {
      // ignore
    } finally {
      setScraping(false);
    }
  };

  const logout = async () => {
    await signOut();
    router.replace("/(auth)/login");
  };

  const initials = (user?.name || user?.email || "?").slice(0, 1).toUpperCase();

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.surface }}
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32 }}
    >
      <View style={{ paddingHorizontal: spacing.xl, alignItems: "center", marginBottom: 8 }}>
        <Logo size={24} />
      </View>

      {/* User card */}
      <View style={[styles.userCard, { marginHorizontal: spacing.xl, borderColor: colors.border }]}>
        <View style={[styles.avatar, { backgroundColor: colors.brand }]}>
          <Text style={{ color: colors.onBrand, fontSize: 22, fontWeight: "800" }}>{initials}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.userName, { color: colors.onSurface }]} numberOfLines={1}>
            {user?.name || "Kullanıcı"}
          </Text>
          <Text style={[styles.userEmail, { color: colors.brandSecondary }]} numberOfLines={1}>
            {user?.email}
          </Text>
        </View>
        <View style={styles.stat}>
          <Text style={[styles.statValue, { color: colors.onSurface }]}>{count}</Text>
          <Text style={[styles.statLabel, { color: colors.brandSecondary }]}>FAVORİ</Text>
        </View>
      </View>

      <SectionLabel colors={colors} spacing={spacing}>GÖRÜNÜM</SectionLabel>
      <Row colors={colors} spacing={spacing} icon={mode === "dark" ? "moon" : "sun"} label={mode === "dark" ? "Koyu Mod" : "Açık Mod"}>
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
      </Row>

      <SectionLabel colors={colors} spacing={spacing}>VERİ</SectionLabel>
      <View style={{ paddingHorizontal: spacing.xl }}>
        <View style={[styles.metaCard, { backgroundColor: colors.surfaceSecondary }]}>
          <View style={styles.metaRow}>
            <Text style={{ color: colors.brandSecondary, fontSize: 12 }}>Toplam ürün</Text>
            <Text style={{ color: colors.onSurface, fontWeight: "700" }}>
              {meta?.product_count ?? "—"}
            </Text>
          </View>
          <View style={[styles.metaRow, { marginTop: 10 }]}>
            <Text style={{ color: colors.brandSecondary, fontSize: 12 }}>Son güncelleme</Text>
            <Text style={{ color: colors.onSurface, fontWeight: "700" }}>
              {formatDate(meta?.last_scrape)}
            </Text>
          </View>
          <Text style={{ color: colors.brandSecondary, fontSize: 11, marginTop: 12, lineHeight: 16 }}>
            Katalog her gün 08:00'de zara.com/tr üzerinden otomatik güncellenir.
          </Text>
        </View>

        <Pressable
          testID="refresh-data"
          onPress={refreshData}
          disabled={scraping}
          style={[styles.refreshBtn, { borderColor: colors.border, opacity: scraping ? 0.6 : 1 }]}
        >
          <Feather name="refresh-cw" size={16} color={colors.onSurface} />
          <Text style={{ color: colors.onSurface, fontWeight: "700", marginLeft: 8 }}>
            {scraping ? "Güncelleniyor… (~1 dk)" : "Şimdi Güncelle"}
          </Text>
        </Pressable>
      </View>

      <SectionLabel colors={colors} spacing={spacing}>HESAP</SectionLabel>
      <Pressable
        testID="logout"
        onPress={logout}
        style={[styles.logout, { marginHorizontal: spacing.xl, borderColor: colors.border }]}
      >
        <Feather name="log-out" size={16} color={colors.error} />
        <Text style={{ color: colors.error, fontWeight: "700", marginLeft: 8 }}>Çıkış Yap</Text>
      </Pressable>

      <Text style={{ color: colors.brandSecondary, textAlign: "center", fontSize: 11, marginTop: 24 }}>
        COZA · Zara Woman Tedarik İzleyici
      </Text>
    </ScrollView>
  );
}

function SectionLabel({ children, colors, spacing }: any) {
  return (
    <Text
      style={{
        color: colors.brandSecondary,
        fontSize: 11,
        letterSpacing: 1.4,
        fontWeight: "700",
        marginTop: 30,
        marginBottom: 12,
        paddingHorizontal: spacing.xl,
      }}
    >
      {children}
    </Text>
  );
}

function Row({ children, colors, spacing, icon, label }: any) {
  return (
    <View
      style={[
        styles.row,
        { marginHorizontal: spacing.xl, borderColor: colors.border },
      ]}
    >
      <Feather name={icon} size={18} color={colors.onSurfaceSecondary} />
      <Text style={{ color: colors.onSurface, fontWeight: "600", flex: 1, marginLeft: 12 }}>
        {label}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  userCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderWidth: 1,
    borderRadius: 4,
    padding: 16,
    marginTop: 16,
  },
  avatar: { width: 52, height: 52, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  userName: { fontSize: 17, fontWeight: "800", letterSpacing: -0.2 },
  userEmail: { fontSize: 13, marginTop: 3 },
  stat: { alignItems: "center" },
  statValue: { fontSize: 20, fontWeight: "800" },
  statLabel: { fontSize: 9, letterSpacing: 1, fontWeight: "700", marginTop: 2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 4,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  metaCard: { padding: 16, borderRadius: 4 },
  metaRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  refreshBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 4,
    height: 50,
    marginTop: 12,
  },
  logout: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 4,
    height: 52,
  },
});
