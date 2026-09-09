// frontend/app/settings.tsx
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { goBack } from "@/src/utils/nav";
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
  const [geminiCheck, setGeminiCheck] = useState<any>(null);
  const [geminiChecking, setGeminiChecking] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadMeta = useCallback(async () => {
    try {
      const m = await api.fashionMeta();
      setMeta(m);
      return m;
    } catch {
      // ignore
      return null;
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const m = await loadMeta();
      if (!m?.scraping) stopPolling();
    }, 3000);
  }, [loadMeta, stopPolling]);

  useFocusEffect(
    useCallback(() => {
      loadMeta().then((m) => {
        if (m?.scraping) startPolling();
      });
      return stopPolling;
    }, [loadMeta, startPolling, stopPolling]),
  );

  useEffect(() => stopPolling, [stopPolling]);

  const triggerScrape = async () => {
    setScraping(true);
    setScrapeMsg("");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await api.fashionScrape();
      setScrapeMsg("Tarama başlatıldı, ilerleme aşağıda görünecek.");
      startPolling();
    } catch {
      setScrapeMsg("Başlatılamadı, tekrar deneyin.");
    } finally {
      setScraping(false);
    }
  };

  const triggerBackfill = async () => {
    setScraping(true);
    setScrapeMsg("");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await api.fashionBackfill();
      setScrapeMsg("Tüm geçmiş taraması başlatıldı — bu çok daha uzun sürer (yüzlerce koleksiyon), ilerleme aşağıda görünecek.");
      startPolling();
    } catch {
      setScrapeMsg("Başlatılamadı, tekrar deneyin.");
    } finally {
      setScraping(false);
    }
  };

  const triggerFixCovers = async () => {
    setScraping(true);
    setScrapeMsg("");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await api.fashionFixCovers();
      setScrapeMsg("Kapak fotoğrafları düzeltiliyor — bu da uzun sürebilir, ilerleme aşağıda görünecek.");
      startPolling();
    } catch {
      setScrapeMsg("Başlatılamadı, tekrar deneyin.");
    } finally {
      setScraping(false);
    }
  };

  const triggerMergeDuplicates = async () => {
    setScraping(true);
    setScrapeMsg("");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await api.fashionMergeDuplicates();
      setScrapeMsg("Aynı gösteri farklı kaynaklardan birleştiriliyor — ilerleme aşağıda görünecek.");
      startPolling();
    } catch {
      setScrapeMsg("Başlatılamadı, tekrar deneyin.");
    } finally {
      setScraping(false);
    }
  };

  const triggerFixThumbnails = async () => {
    setScraping(true);
    setScrapeMsg("");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await api.fashionFixThumbnails();
      setScrapeMsg("Küçük resimler oluşturuluyor — listeler bundan sonra çok daha hızlı yüklenecek.");
      startPolling();
    } catch {
      setScrapeMsg("Başlatılamadı, tekrar deneyin.");
    } finally {
      setScraping(false);
    }
  };

  const triggerDropDeadImages = async () => {
    setScraping(true);
    setScrapeMsg("");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await api.fashionDropDeadImages();
      setScrapeMsg("Ölü fotoğraf adresleri temizleniyor — 3 kovanın hiçbirinde olmayan fotoğraflar koleksiyonlardan çıkarılıyor. Depodan bir şey silinmez; gerçekten kayıp fotoğraflar ancak 'Tümünü Tara' ile geri gelir.");
      startPolling();
    } catch (e: any) {
      setScrapeMsg(e?.message || "Başlatılamadı, tekrar deneyin.");
    } finally {
      setScraping(false);
    }
  };

  const runGeminiCheck = async () => {
    setGeminiChecking(true);
    setGeminiCheck(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const res = await api.geminiCheck();
      setGeminiCheck(res);
    } catch (e: any) {
      setGeminiCheck({ error: e?.message || "Kontrol edilemedi." });
    } finally {
      setGeminiChecking(false);
    }
  };

  const triggerTagPhotos = async () => {
    setScraping(true);
    setScrapeMsg("");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await api.fashionTagFirstview();
      setScrapeMsg("Tüm koleksiyon fotoğrafları yapay zekayla etiketleniyor — ücretsiz kotaya uymak için kademeli ilerler, birkaç güne yayılabilir. Her gece kaldığı yerden devam eder.");
      startPolling();
    } catch (e: any) {
      setScrapeMsg(e?.message || "Başlatılamadı, tekrar deneyin.");
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
        <Pressable testID="settings-back" onPress={() => goBack(router, "/fashion")} hitSlop={10}>
          <Feather name="chevron-left" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={[styles.title, { color: colors.onSurface }]}>Ayarlar</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
      >
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
              {meta?.photos_taggable != null && (
                <View style={[styles.metaRow, { marginTop: 10 }]}>
                  <Text style={{ color: colors.brandSecondary, fontSize: 12 }}>Yapay zeka etiketli fotoğraf</Text>
                  <Text style={{ color: colors.onSurface, fontWeight: "700" }}>
                    {`${meta?.photos_tagged ?? 0} / ${meta?.photos_taggable ?? "?"}`}
                  </Text>
                </View>
              )}
              {!!meta?.scraping && (
                <View style={[styles.metaRow, { marginTop: 10 }]}>
                  <Text style={{ color: colors.brandSecondary, fontSize: 12 }}>
                    {meta?.phase === "generating_thumbnails"
                      ? "Küçük resimler oluşturuluyor"
                      : meta?.phase === "merging_duplicates"
                        ? "Yinelenenler birleştiriliyor"
                        : meta?.phase === "fixing_covers"
                          ? "Kapaklar düzeltiliyor"
                          : meta?.phase === "tagging_photos" || meta?.phase === "tagging_firstview"
                            ? "Fotoğraflar yapay zekayla etiketleniyor"
                            : meta?.phase === "repairing_urls"
                              ? "Fotoğraf adresleri onarılıyor"
                              : meta?.phase === "dropping_dead_images"
                                ? "Ölü fotoğraf adresleri temizleniyor"
                                : meta?.phase === "finalizing"
                                  ? "Kaydediliyor"
                                  : "Kaynaklar taranıyor"}
                  </Text>
                  <Text style={{ color: colors.onSurface, fontWeight: "700" }}>
                    {meta?.phase === "generating_thumbnails"
                      ? `${meta?.thumbs_done ?? 0} / ${meta?.thumbs_total ?? "?"}`
                      : meta?.phase === "merging_duplicates"
                        ? `${meta?.merge_done ?? 0} / ${meta?.merge_total ?? "?"}`
                        : meta?.phase === "fixing_covers"
                          ? `${meta?.covers_done ?? 0} / ${meta?.covers_total ?? "?"}`
                          : meta?.phase === "tagging_photos" || meta?.phase === "tagging_firstview"
                            ? `${meta?.tags_done ?? 0} / ${meta?.tags_total ?? "?"}`
                            : meta?.phase === "repairing_urls" || meta?.phase === "dropping_dead_images"
                              ? `${meta?.repair_done ?? 0} / ${meta?.repair_total ?? "?"}`
                              : meta?.phase === "finalizing"
                                ? `${meta?.groups_done ?? 0} / ${meta?.groups_total ?? "?"}`
                                : `${meta?.sources_done ?? 0} / ${meta?.sources_total ?? "?"} kaynak`}
                  </Text>
                </View>
              )}
            </View>

            <Pressable
              testID="open-admin-panel"
              onPress={() => router.push("/admin")}
              style={[styles.refreshBtn, { borderColor: colors.border, backgroundColor: colors.surfaceSecondary }]}
            >
              <Feather name="bar-chart-2" size={16} color={colors.onSurface} />
              <Text style={{ color: colors.onSurface, fontWeight: "700", marginLeft: 8 }}>Admin Panel</Text>
            </Pressable>

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
            <Pressable
              testID="fashion-backfill-data"
              onPress={triggerBackfill}
              disabled={scraping}
              style={[styles.refreshBtn, { borderColor: colors.border, opacity: scraping ? 0.6 : 1 }]}
            >
              <Feather name="database" size={16} color={colors.onSurface} />
              <Text style={{ color: colors.onSurface, fontWeight: "700", marginLeft: 8 }}>
                {scraping ? "Başlatılıyor…" : "2026 Ocak'tan İtibaren Tümünü Tara"}
              </Text>
            </Pressable>
            <Pressable
              testID="fashion-fix-covers"
              onPress={triggerFixCovers}
              disabled={scraping}
              style={[styles.refreshBtn, { borderColor: colors.border, opacity: scraping ? 0.6 : 1 }]}
            >
              <Feather name="image" size={16} color={colors.onSurface} />
              <Text style={{ color: colors.onSurface, fontWeight: "700", marginLeft: 8 }}>
                {scraping ? "Başlatılıyor…" : "Kapak Fotoğraflarını Düzelt"}
              </Text>
            </Pressable>
            <Pressable
              testID="fashion-merge-duplicates"
              onPress={triggerMergeDuplicates}
              disabled={scraping}
              style={[styles.refreshBtn, { borderColor: colors.border, opacity: scraping ? 0.6 : 1 }]}
            >
              <Feather name="git-merge" size={16} color={colors.onSurface} />
              <Text style={{ color: colors.onSurface, fontWeight: "700", marginLeft: 8 }}>
                {scraping ? "Başlatılıyor…" : "Yinelenen Koleksiyonları Birleştir"}
              </Text>
            </Pressable>
            <Pressable
              testID="fashion-fix-thumbnails"
              onPress={triggerFixThumbnails}
              disabled={scraping}
              style={[styles.refreshBtn, { borderColor: colors.border, opacity: scraping ? 0.6 : 1 }]}
            >
              <Feather name="zap" size={16} color={colors.onSurface} />
              <Text style={{ color: colors.onSurface, fontWeight: "700", marginLeft: 8 }}>
                {scraping ? "Başlatılıyor…" : "Küçük Resimleri Oluştur"}
              </Text>
            </Pressable>
            <Pressable
              testID="fashion-tag-firstview"
              onPress={triggerTagPhotos}
              disabled={scraping}
              style={[styles.refreshBtn, { borderColor: colors.border, opacity: scraping ? 0.6 : 1 }]}
            >
              <Feather name="tag" size={16} color={colors.onSurface} />
              <Text style={{ color: colors.onSurface, fontWeight: "700", marginLeft: 8 }}>
                {scraping ? "Başlatılıyor…" : "Fotoğraf Etiketlemeyi Başlat"}
              </Text>
            </Pressable>
            <Pressable
              testID="fashion-drop-dead-images"
              onPress={triggerDropDeadImages}
              disabled={scraping}
              style={[styles.refreshBtn, { borderColor: colors.border, opacity: scraping ? 0.6 : 1 }]}
            >
              <Feather name="trash-2" size={16} color={colors.error} />
              <Text style={{ color: colors.error, fontWeight: "700", marginLeft: 8 }}>
                {scraping ? "Başlatılıyor…" : "Ölü Fotoğrafları Temizle"}
              </Text>
            </Pressable>
            <Pressable
              testID="gemini-check"
              onPress={runGeminiCheck}
              disabled={geminiChecking}
              style={[styles.refreshBtn, { borderColor: colors.border, opacity: geminiChecking ? 0.6 : 1 }]}
            >
              <Feather name="key" size={16} color={colors.onSurface} />
              <Text style={{ color: colors.onSurface, fontWeight: "700", marginLeft: 8 }}>
                {geminiChecking ? "Kontrol ediliyor…" : "Gemini Anahtarlarını Test Et"}
              </Text>
            </Pressable>
            {!!geminiCheck && (
              <View style={[styles.metaCard, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}>
                {geminiCheck.error ? (
                  <Text style={{ color: colors.error, fontSize: 12 }}>{geminiCheck.error}</Text>
                ) : (
                  <>
                    <View style={styles.metaRow}>
                      <Text style={{ color: colors.brandSecondary, fontSize: 12 }}>Çalışan slot</Text>
                      <Text style={{ color: colors.onSurface, fontWeight: "700" }}>
                        {geminiCheck.slots_ok ?? 0} / {geminiCheck.slot_count} ({geminiCheck.key_count} anahtar × {geminiCheck.models?.length ?? 0} model)
                      </Text>
                    </View>
                    {(geminiCheck.keys ?? []).map((k: any) => (
                      <View key={k.index} style={[styles.metaRow, { marginTop: 8 }]}>
                        <Text style={{ color: colors.brandSecondary, fontSize: 12 }}>
                          Anahtar {k.index} (…{k.tail}) · {k.models_ok}/{k.models_total} model
                        </Text>
                        <Text
                          style={{
                            color: k.ok ? (k.quota_exhausted ? colors.brandSecondary : colors.onSurface) : colors.error,
                            fontWeight: "700",
                            fontSize: 12,
                            flexShrink: 1,
                            textAlign: "right",
                            marginLeft: 12,
                          }}
                        >
                          {k.ok ? (k.quota_exhausted ? "⚠︎ kota dolu" : "✓ çalışıyor") : "✗ " + (k.detail || "hata")}
                        </Text>
                      </View>
                    ))}
                    {(geminiCheck.models ?? []).map((m: string) => {
                      const ms = (geminiCheck.slots ?? []).filter((s: any) => s.model === m);
                      const okc = ms.filter((s: any) => s.ok).length;
                      const bad = ms.find((s: any) => !s.ok);
                      return (
                        <View key={m} style={[styles.metaRow, { marginTop: 6 }]}>
                          <Text style={{ color: colors.brandSecondary, fontSize: 11 }}>{m}</Text>
                          <Text
                            style={{
                              color: okc > 0 ? colors.onSurfaceSecondary : colors.error,
                              fontSize: 11, flexShrink: 1, textAlign: "right", marginLeft: 12,
                            }}
                          >
                            {okc > 0 ? `${okc}/${ms.length} anahtar` : `✗ ${bad?.detail || "hata"}`}
                          </Text>
                        </View>
                      );
                    })}
                    {!geminiCheck.enabled && (
                      <Text style={{ color: colors.error, fontSize: 12, marginTop: 8 }}>
                        Backend hiç anahtar görmüyor — Railway&apos;de GEMINI_API_KEYS ayarlı mı?
                      </Text>
                    )}
                  </>
                )}
              </View>
            )}
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
      </ScrollView>
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
