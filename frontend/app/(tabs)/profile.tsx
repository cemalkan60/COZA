import React, { useCallback, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { api } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";
import { useFavorites } from "@/src/context/FavoritesContext";
import { formatDate } from "@/src/utils/format";

export default function Profile() {
  const { colors, spacing, mode, toggle } = useTheme();
  const insets = useSafeAreaInsets();
  const { user, signOut } = useAuth();
  const { count } = useFavorites();
  const router = useRouter();

  const isAdmin = user?.role === "admin";

  const [meta, setMeta] = useState<any>(null);
  const [settings, setSettings] = useState<any>(null);
  const [scraping, setScraping] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [note, setNote] = useState("");
  const [saveMsg, setSaveMsg] = useState("");

  const loadMeta = useCallback(async () => {
    try {
      setMeta(await api.meta());
      if (isAdmin) {
        const s = await api.adminSettings();
        setSettings(s);
        setNote(s.storage_note || "");
      }
    } catch {
      // ignore
    }
  }, [isAdmin]);

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

  const saveKey = async () => {
    if (newKey.trim().length < 8) {
      setSaveMsg("Geçerli bir proxy anahtarı girin.");
      return;
    }
    try {
      await api.updateAdminSettings(newKey.trim(), note.trim());
      setNewKey("");
      setSaveMsg("Kaydedildi.");
      await loadMeta();
    } catch {
      setSaveMsg("Kaydedilemedi.");
    }
  };

  const logout = async () => {
    await signOut();
    router.replace("/(auth)/login");
  };

  const initials = (user?.name || user?.email || "?").slice(0, 1).toUpperCase();

  return (
    <KeyboardAwareScrollView
      bottomOffset={20}
      style={{ flex: 1, backgroundColor: colors.surface }}
      contentContainerStyle={{ paddingTop: 10, paddingBottom: insets.bottom + 40 }}
    >
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
          <View
            style={[
              styles.roleBadge,
              { backgroundColor: isAdmin ? colors.brand : colors.surfaceTertiary },
            ]}
          >
            <Feather
              name={isAdmin ? "shield" : "eye"}
              size={11}
              color={isAdmin ? colors.onBrand : colors.onSurfaceSecondary}
            />
            <Text
              style={{
                color: isAdmin ? colors.onBrand : colors.onSurfaceSecondary,
                fontSize: 10,
                fontWeight: "800",
                letterSpacing: 0.5,
                marginLeft: 5,
              }}
            >
              {isAdmin ? "YÖNETİCİ" : "GÖZLEMCİ"}
            </Text>
          </View>
        </View>
        <View style={styles.stat}>
          <Text style={[styles.statValue, { color: colors.onSurface }]}>{count}</Text>
          <Text style={[styles.statLabel, { color: colors.brandSecondary }]}>FAVORİ</Text>
        </View>
      </View>

      <SectionLabel colors={colors} spacing={spacing}>GÖRÜNÜM</SectionLabel>
      <View style={[styles.row, { marginHorizontal: spacing.xl, borderColor: colors.border }]}>
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

      <SectionLabel colors={colors} spacing={spacing}>VERİ</SectionLabel>
      <View style={{ paddingHorizontal: spacing.xl }}>
        <View style={[styles.metaCard, { backgroundColor: colors.surfaceSecondary }]}>
          <View style={styles.metaRow}>
            <Text style={{ color: colors.brandSecondary, fontSize: 12 }}>Toplam ürün</Text>
            <Text style={{ color: colors.onSurface, fontWeight: "700" }}>{meta?.product_count ?? "—"}</Text>
          </View>
          <View style={[styles.metaRow, { marginTop: 10 }]}>
            <Text style={{ color: colors.brandSecondary, fontSize: 12 }}>Son güncelleme</Text>
            <Text style={{ color: colors.onSurface, fontWeight: "700" }}>{formatDate(meta?.last_scrape)}</Text>
          </View>
          {isAdmin && typeof meta?.categories_failed === "number" && (
            <View style={[styles.metaRow, { marginTop: 10 }]}>
              <Text style={{ color: colors.brandSecondary, fontSize: 12 }}>Son tarama sonucu</Text>
              <Text
                style={{
                  color: meta.categories_failed > 0 ? "#d94f4f" : colors.onSurface,
                  fontWeight: "700",
                }}
              >
                {meta.categories_ok ?? 0} başarılı / {meta.categories_failed} başarısız
              </Text>
            </View>
          )}
          {isAdmin && meta?.categories_failed > 0 && (
            <Text style={{ color: "#d94f4f", fontSize: 11, marginTop: 6, lineHeight: 16 }}>
              Son taramada {meta.categories_failed} kategori başarısız oldu — ürünler bu yüzden
              güncellenmemiş olabilir. ScraperAPI anahtarınızı/kredinizi kontrol edin.
            </Text>
          )}
          <Text style={{ color: colors.brandSecondary, fontSize: 11, marginTop: 12, lineHeight: 16 }}>
            Katalog her Pazartesi ve Perşembe 08:00'de (TR saati) otomatik güncellenir.
          </Text>
        </View>

        {isAdmin && (
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
        )}
      </View>

      {isAdmin && (
        <>
          <SectionLabel colors={colors} spacing={spacing}>YÖNETİM · PROXY & DEPOLAMA</SectionLabel>
          <View style={{ paddingHorizontal: spacing.xl }}>
            <View style={[styles.metaCard, { backgroundColor: colors.surfaceSecondary }]}>
              <View style={styles.metaRow}>
                <Text style={{ color: colors.brandSecondary, fontSize: 12 }}>Aktif proxy anahtarı</Text>
                <Text style={{ color: colors.onSurface, fontWeight: "700" }}>
                  {settings?.proxy_api_key_masked ?? "—"}
                </Text>
              </View>
              <View style={[styles.metaRow, { marginTop: 10 }]}>
                <Text style={{ color: colors.brandSecondary, fontSize: 12 }}>Depolama (DB)</Text>
                <Text style={{ color: colors.onSurface, fontWeight: "700" }}>{settings?.db_name ?? "—"}</Text>
              </View>
            </View>

            <Text style={[styles.inputLabel, { color: colors.brandSecondary }]}>YENİ PROXY API ANAHTARI</Text>
            <TextInput
              testID="admin-proxy-input"
              value={newKey}
              onChangeText={(t) => {
                setNewKey(t);
                setSaveMsg("");
              }}
              placeholder="Yeni ScraperAPI anahtarı"
              placeholderTextColor={colors.brandSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { color: colors.onSurface, borderColor: colors.border, backgroundColor: colors.surfaceSecondary }]}
            />
            <Text style={[styles.inputLabel, { color: colors.brandSecondary, marginTop: 14 }]}>
              DEPOLAMA NOTU (opsiyonel)
            </Text>
            <TextInput
              testID="admin-note-input"
              value={note}
              onChangeText={setNote}
              placeholder="örn. yedek küme / bölge"
              placeholderTextColor={colors.brandSecondary}
              style={[styles.input, { color: colors.onSurface, borderColor: colors.border, backgroundColor: colors.surfaceSecondary }]}
            />
            {!!saveMsg && (
              <Text testID="admin-save-msg" style={{ color: colors.brandSecondary, marginTop: 10, fontSize: 12 }}>
                {saveMsg}
              </Text>
            )}
            <Pressable
              testID="admin-save"
              onPress={saveKey}
              style={[styles.refreshBtn, { borderColor: colors.brand, marginTop: 12 }]}
            >
              <Feather name="save" size={16} color={colors.onSurface} />
              <Text style={{ color: colors.onSurface, fontWeight: "700", marginLeft: 8 }}>Kaydet</Text>
            </Pressable>
          </View>
        </>
      )}

      <SectionLabel colors={colors} spacing={spacing}>HESAP</SectionLabel>
      <Pressable
        testID="logout"
        onPress={logout}
        style={[styles.logout, { marginHorizontal: spacing.xl, borderColor: colors.border }]}
      >
        <Feather name="log-out" size={16} color={colors.error} />
        <Text style={{ color: colors.error, fontWeight: "700", marginLeft: 8 }}>Çıkış Yap</Text>
      </Pressable>

      <Text style={{ color: colors.brandSecondary, textAlign: "center", fontSize: 12, marginTop: 24, letterSpacing: 2 }}>
        MadeIn
      </Text>
    </KeyboardAwareScrollView>
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
  roleBadge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
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
  inputLabel: { fontSize: 10, letterSpacing: 1.2, fontWeight: "700", marginTop: 16, marginBottom: 8 },
  input: { height: 48, borderWidth: 1, borderRadius: 4, paddingHorizontal: 14, fontSize: 15 },
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
