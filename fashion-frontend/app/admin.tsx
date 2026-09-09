// frontend/app/admin.tsx — admin-only dashboard. Viewers are redirected out
// (and the backend /admin/* endpoints 403 them anyway).
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { api, type AdminDashboard, type JobRun } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";
import { formatDate } from "@/src/utils/format";
import { goBack } from "@/src/utils/nav";
import { BarChart, DonutChart, ProgressBar } from "@/src/components/Charts";

const JOB_LABELS: Record<string, string> = {
  scheduled_scrape: "Katalog taraması (Pzt+Prş 08:00)",
  scheduled_fashion_scrape: "Fashion taraması (Pzt+Çrş 07:00)",
  scheduled_fashion_tag_firstview: "Fotoğraf etiketleme (her gün 04:00)",
};

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = Date.now();
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);
  const h = Math.round(abs / 3.6e6);
  const rel =
    abs < 3.6e6
      ? `${Math.round(abs / 6e4)} dk`
      : h < 48
        ? `${h} sa`
        : `${Math.round(h / 24)} gün`;
  return `${formatDate(iso)} · ${diff >= 0 ? rel + " sonra" : rel + " önce"}`;
}

const WARN_COLOR = "#C98A2C";

const STATUS_META: Record<JobRun["status"], { icon: keyof typeof Feather.glyphMap; word: string }> = {
  ok: { icon: "check-circle", word: "başarılı" },
  partial: { icon: "alert-triangle", word: "yarım kaldı" },
  error: { icon: "x-circle", word: "başarısız" },
};

const PHASE_LABELS: Record<string, string> = {
  collecting: "Kaynaklar taranıyor",
  finalizing: "Fotoğraflar indiriliyor / kaydediliyor",
  fixing_covers: "Kapaklar düzeltiliyor",
  generating_thumbnails: "Küçük resimler oluşturuluyor",
  merging_duplicates: "Yinelenenler birleştiriliyor",
  cleaning_cruft: "Bozuk kayıtlar temizleniyor",
  repairing_urls: "Fotoğraf adresleri onarılıyor",
  tagging_photos: "Fotoğraflar yapay zekayla etiketleniyor",
  tagging_firstview: "Fotoğraflar yapay zekayla etiketleniyor",
};

// A single 0-100 for whatever fashion job is running. A full scrape is
// collecting (0->12%) then finalizing (12->100%); the one-off sweeps each
// report their own fraction.
function scrapeProgress(d: AdminDashboard): { pct: number | null; label: string; detail: string } {
  const phase = d.scrape.fashion_phase || "";
  const p = d.scrape.progress;
  const label = PHASE_LABELS[phase] || (phase ? phase : "Çalışıyor");
  const frac = (a: number, b: number) => (b > 0 ? Math.min(1, a / b) : 0);
  if (!p) return { pct: null, label, detail: "" };
  if (phase === "collecting")
    return { pct: Math.round(12 * frac(p.sources_done, p.sources_total)), label, detail: `${p.sources_done}/${p.sources_total} kaynak` };
  if (phase === "finalizing")
    return { pct: Math.round(12 + 88 * frac(p.groups_done, p.groups_total)), label, detail: `${p.groups_done}/${p.groups_total} koleksiyon` };
  if (phase === "fixing_covers")
    return { pct: Math.round(100 * frac(p.covers_done, p.covers_total)), label, detail: `${p.covers_done}/${p.covers_total}` };
  if (phase === "generating_thumbnails")
    return { pct: Math.round(100 * frac(p.thumbs_done, p.thumbs_total)), label, detail: `${p.thumbs_done}/${p.thumbs_total}` };
  if (phase === "merging_duplicates")
    return { pct: Math.round(100 * frac(p.merge_done, p.merge_total)), label, detail: `${p.merge_done}/${p.merge_total}` };
  if (phase === "repairing_urls")
    return { pct: Math.round(100 * frac(p.repair_done ?? 0, p.repair_total ?? 0)), label, detail: `${p.repair_done ?? 0}/${p.repair_total ?? 0}` };
  if (phase === "tagging_photos" || phase === "tagging_firstview")
    return { pct: Math.round(100 * frac(d.tagging.run_done, d.tagging.run_total)), label, detail: `${d.tagging.run_done}/${d.tagging.run_total}` };
  return { pct: null, label, detail: "" };
}

export default function AdminPanel() {
  const { colors, spacing, fontSize } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();

  const [data, setData] = useState<AdminDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      setErr("");
      const d = await api.adminDashboard();
      setData(d);
    } catch (e: any) {
      setErr(e?.message || "Yüklenemedi.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // While a scrape or the tag sweep is running, poll every 5s so the
  // progress bar moves without pull-to-refresh.
  const busyNow = !!data && (data.scrape.fashion_running || data.tagging.running);
  useEffect(() => {
    if (!busyNow) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [busyNow, load]);

  const runAction = async (key: string, fn: () => Promise<any>, note: string) => {
    setBusy(key);
    setMsg("");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await fn();
      setMsg(note);
      setTimeout(load, 1500);
    } catch (e: any) {
      setMsg(e?.message || "Başlatılamadı.");
    } finally {
      setBusy(null);
    }
  };

  // Non-admins never see this screen.
  if (user && user.role !== "admin") return <Redirect href="/settings" />;

  const Section = ({ title, children }: React.PropsWithChildren<{ title: string }>) => (
    <View style={{ marginTop: spacing.xl }}>
      <Text style={[styles.sectionTitle, { color: colors.brandSecondary }]}>{title.toLocaleUpperCase("tr-TR")}</Text>
      <View style={[styles.card, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}>{children}</View>
    </View>
  );

  const Row = ({ k, v, danger }: { k: string; v: string | number; danger?: boolean }) => (
    <View style={styles.row}>
      <Text style={{ color: colors.brandSecondary, fontSize: fontSize.sm, flex: 1 }}>{k}</Text>
      <Text style={{ color: danger && Number(v) > 0 ? colors.error : colors.onSurface, fontWeight: "700", fontSize: fontSize.sm }}>
        {v}
      </Text>
    </View>
  );

  const d = data;
  const tagged = d?.photos.tagged ?? 0;
  const taggable = d?.photos.taggable ?? 0;
  const remaining = Math.max(0, taggable - tagged);
  const perDay = (d?.gemini.key_count ?? 0) * 500 * (d?.gemini.batch ?? 8);
  const etaTxt =
    remaining === 0
      ? "tamam"
      : perDay <= 0
        ? "—"
        : remaining / perDay < 1
          ? `~${Math.max(1, Math.round((remaining / perDay) * 24))} saat`
          : `~${(remaining / perDay).toFixed(1)} gün`;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface, paddingTop: insets.top + 12 }}>
      <View style={[styles.header, { paddingHorizontal: spacing.xl, borderBottomColor: colors.divider }]}>
        <Pressable testID="admin-back" onPress={() => goBack(router, "/settings")} hitSlop={10}>
          <Feather name="chevron-left" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={[styles.title, { color: colors.onSurface }]}>Admin Panel</Text>
        <Pressable testID="admin-refresh" onPress={() => { setRefreshing(true); load(); }} hitSlop={10}>
          <Feather name="refresh-cw" size={20} color={colors.onSurface} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingBottom: insets.bottom + 48 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.onSurface} />}
      >
        {loading && !d ? (
          <Text style={{ color: colors.brandSecondary, marginTop: spacing.xl }}>Yükleniyor…</Text>
        ) : err ? (
          <Text style={{ color: colors.error, marginTop: spacing.xl }}>{err}</Text>
        ) : d ? (
          <>
            {/* Özet */}
            <View style={[styles.statRow, { marginTop: spacing.lg }]}>
              <Stat label="Koleksiyon" value={d.collections.total} colors={colors} fontSize={fontSize} />
              <Stat label="Fotoğraf" value={d.photos.photos} colors={colors} fontSize={fontSize} />
              <Stat
                label="Etiketli"
                value={`${taggable ? Math.round((tagged / taggable) * 100) : 0}%`}
                colors={colors}
                fontSize={fontSize}
              />
            </View>

            {/* Canlı ilerleme — sadece bir iş çalışırken */}
            {(d.scrape.fashion_running || d.tagging.running) && (() => {
              const prog = scrapeProgress(d);
              return (
                <View style={[styles.card, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border, marginTop: spacing.lg }]}>
                  <View style={styles.row}>
                    <Text style={{ color: colors.onSurface, fontWeight: "700", fontSize: fontSize.sm }}>{prog.label}</Text>
                    <Text style={{ color: colors.onSurface, fontWeight: "800", fontSize: fontSize.sm }}>
                      {prog.pct != null ? `%${prog.pct}` : "…"}
                    </Text>
                  </View>
                  <View style={{ marginTop: 6 }}>
                    <ProgressBar value={prog.pct ?? 0} max={100} />
                  </View>
                  {!!prog.detail && (
                    <Text style={{ color: colors.brandSecondary, fontSize: fontSize.xs, marginTop: 6 }}>{prog.detail}</Text>
                  )}
                  <Text style={{ color: colors.brandSecondary, fontSize: fontSize.xs, marginTop: 4 }}>
                    otomatik yenilenir · 5 sn
                  </Text>
                </View>
              );
            })()}

            {/* Etiketleme */}
            <Section title="Yapay Zeka Etiketleme">
              <ProgressBar value={tagged} max={taggable} label={`${tagged.toLocaleString("tr-TR")} / ${taggable.toLocaleString("tr-TR")} fotoğraf`} />
              <View style={[styles.row, { marginTop: 12 }]}>
                <Text style={{ color: colors.brandSecondary, fontSize: fontSize.sm }}>Kalan · kaba tahmin</Text>
                <Text style={{ color: colors.onSurface, fontSize: fontSize.sm, fontWeight: "700" }}>
                  {remaining.toLocaleString("tr-TR")} · {etaTxt}
                </Text>
              </View>
              <View style={[styles.row]}>
                <Text style={{ color: colors.brandSecondary, fontSize: fontSize.sm }}>Şu an çalışıyor mu?</Text>
                <Text style={{ color: d.tagging.running ? colors.success : colors.brandSecondary, fontSize: fontSize.sm, fontWeight: "700" }}>
                  {d.tagging.running ? `evet · ${d.tagging.run_done}/${d.tagging.run_total}` : "hayır"}
                </Text>
              </View>
              {d.photos.by_source.map((s) => (
                <View key={s.label} style={{ marginTop: 12 }}>
                  <ProgressBar
                    value={s.tagged}
                    max={s.taggable}
                    label={s.label}
                    right={`${s.tagged.toLocaleString("tr-TR")} / ${s.taggable.toLocaleString("tr-TR")}`}
                  />
                </View>
              ))}
              <Pressable
                testID="admin-run-tag"
                disabled={!!busy}
                onPress={() => runAction("tag", api.fashionTagFirstview, "Etiketleme başlatıldı.")}
                style={[styles.btn, { borderColor: colors.border, opacity: busy ? 0.5 : 1 }]}
              >
                <Feather name="tag" size={15} color={colors.onSurface} />
                <Text style={[styles.btnTxt, { color: colors.onSurface }]}>{busy === "tag" ? "Başlatılıyor…" : "Etiketlemeyi Başlat"}</Text>
              </Pressable>
            </Section>

            {/* Grafikler */}
            <Section title="Kaynak Dağılımı">
              <DonutChart data={d.collections.by_source} centerLabel="koleksiyon" centerValue={String(d.collections.total)} />
            </Section>
            {d.collections.by_category.length > 0 && (
              <Section title="Kategori">
                <DonutChart data={d.collections.by_category} centerLabel="kategori" />
              </Section>
            )}
            {d.collections.by_season.length > 0 && (
              <Section title="Sezon (ilk 10)">
                <BarChart data={d.collections.by_season.slice(0, 10)} />
              </Section>
            )}
            {d.collections.by_city.length > 0 && (
              <Section title="Şehir (ilk 10)">
                <BarChart data={d.collections.by_city.slice(0, 10)} />
              </Section>
            )}

            {/* Veri sağlığı */}
            <Section title="Veri Sağlığı">
              <Row k={`Pencere · son ${d.window?.recent_months ?? 6} ay`} v={`temizlik: ${fmtWhen(d.window?.last_prune)}`} />
              <Row k="6 aydan eski (silinecek)" v={d.health.older_than_window ?? 0} danger />
              <Row k="Tarihsiz (sezon okunamadı)" v={d.health.undated ?? 0} danger />
              <Row k="Etiketsiz koleksiyon" v={d.health.untagged ?? 0} danger />
              <Row k="Küçük resmi eksik" v={d.health.missing_thumbs ?? 0} danger />
              <Row k="Tek fotoğraflı" v={d.health.single_photo ?? 0} danger />
              <Row k="fashion-press · zayıf kapak" v={d.health.fp_thin_cover ?? 0} danger />
              <View style={styles.btnRow}>
                <Pressable
                  disabled={!!busy}
                  onPress={() => runAction("prune", api.fashionPruneOld, "Eski koleksiyonların temizliği başladı (fotoğraflar dahil).")}
                  style={[styles.btnSm, { borderColor: colors.border, opacity: busy ? 0.5 : 1 }]}
                >
                  <Text style={[styles.btnTxtSm, { color: colors.error }]}>Eskileri sil</Text>
                </Pressable>
                <Pressable
                  disabled={!!busy}
                  onPress={() => runAction("thumbs", api.fashionFixThumbnails, "Küçük resim oluşturma başladı.")}
                  style={[styles.btnSm, { borderColor: colors.border, opacity: busy ? 0.5 : 1 }]}
                >
                  <Text style={[styles.btnTxtSm, { color: colors.onSurface }]}>Küçük resimler</Text>
                </Pressable>
                <Pressable
                  disabled={!!busy}
                  onPress={() => runAction("covers", api.fashionFixCovers, "Kapak düzeltme başladı.")}
                  style={[styles.btnSm, { borderColor: colors.border, opacity: busy ? 0.5 : 1 }]}
                >
                  <Text style={[styles.btnTxtSm, { color: colors.onSurface }]}>Kapaklar</Text>
                </Pressable>
                <Pressable
                  disabled={!!busy}
                  onPress={() => runAction("merge", api.fashionMergeDuplicates, "Birleştirme başladı.")}
                  style={[styles.btnSm, { borderColor: colors.border, opacity: busy ? 0.5 : 1 }]}
                >
                  <Text style={[styles.btnTxtSm, { color: colors.onSurface }]}>Yinelenenler</Text>
                </Pressable>
                <Pressable
                  disabled={!!busy}
                  onPress={() => runAction("cruft", api.fashionCleanCruft, "Bozuk kayıtların temizliği başladı (tarihsiz + kaynağı fashion-press olmayan tek fotoğraflılar).")}
                  style={[styles.btnSm, { borderColor: colors.border, opacity: busy ? 0.5 : 1 }]}
                >
                  <Text style={[styles.btnTxtSm, { color: colors.error }]}>Bozukları sil</Text>
                </Pressable>
                <Pressable
                  disabled={!!busy}
                  onPress={() => runAction("repair", api.fashionRepairUrls, "Fotoğraf adresleri onarılıyor — 404 veren fotoğrafların gerçekte bulunduğu kova adresine güncelleniyor.")}
                  style={[styles.btnSm, { borderColor: colors.border, opacity: busy ? 0.5 : 1 }]}
                >
                  <Text style={[styles.btnTxtSm, { color: colors.onSurface }]}>Foto adreslerini onar</Text>
                </Pressable>
              </View>
            </Section>

            {/* Tarama */}
            <Section title="Tarama">
              <Row k="Fashion · son tarama" v={fmtWhen(d.scrape.fashion_last)} />
              <Row k="Katalog · son tarama" v={fmtWhen(d.scrape.catalog_last)} />
              <Row k="Şu an tarıyor mu?" v={d.scrape.fashion_running ? `evet (${d.scrape.fashion_phase ?? "?"})` : "hayır"} />
              {d.scrape.scheduled_jobs.map((j) => (
                <Row key={j.id} k={JOB_LABELS[j.id] ?? j.id} v={fmtWhen(j.next_run)} />
              ))}
              <View style={styles.btnRow}>
                <Pressable
                  disabled={!!busy}
                  onPress={() => runAction("scrape", api.fashionScrape, "Tarama başladı.")}
                  style={[styles.btnSm, { borderColor: colors.border, opacity: busy ? 0.5 : 1 }]}
                >
                  <Text style={[styles.btnTxtSm, { color: colors.onSurface }]}>Şimdi tara</Text>
                </Pressable>
                <Pressable
                  disabled={!!busy}
                  onPress={() => runAction("backfill", api.fashionBackfill, "Geçmiş tarama başladı.")}
                  style={[styles.btnSm, { borderColor: colors.border, opacity: busy ? 0.5 : 1 }]}
                >
                  <Text style={[styles.btnTxtSm, { color: colors.onSurface }]}>2026'dan beri</Text>
                </Pressable>
              </View>
            </Section>

            {/* Gemini */}
            <Section title="Gemini">
              <Row k="Durum" v={d.gemini.enabled ? "aktif" : "kapalı"} />
              <Row k="Anahtar sayısı" v={d.gemini.key_count} />
              <Row k="Model(ler)" v={d.gemini.models.join(", ") || "—"} />
              <Row k="Parti (foto/istek)" v={d.gemini.batch} />
            </Section>

            {/* Kullanıcılar */}
            <Section title={`Kullanıcılar (${d.users.length})`}>
              {d.users.map((u, i) => (
                <View key={u.email ?? i} style={styles.row}>
                  <Text style={{ color: colors.onSurface, fontSize: fontSize.sm, flex: 1 }}>
                    {u.name || u.email}
                  </Text>
                  <Text style={{ color: u.role === "admin" ? colors.onSurface : colors.brandSecondary, fontSize: fontSize.xs, fontWeight: "700" }}>
                    {u.role === "admin" ? "YÖNETİCİ" : "GÖZLEMCİ"}
                  </Text>
                </View>
              ))}
            </Section>

            {/* Sistem */}
            <Section title="Sistem">
              <Row k="Veritabanı" v={d.system.db_name} />
              {!!d.system.sources && (
                <>
                  <Row k="Aktif kaynaklar" v={d.system.sources.active.join(", ")} />
                  {d.system.sources.disabled.map((s) => (
                    <Row key={s.name} k={`Kapalı · ${s.name}`} v={s.reason} danger />
                  ))}
                </>
              )}
              <Row
                k="R2 kova (fotoğraf deposu)"
                v={d.system.r2 ? (d.system.r2.enabled ? `${d.system.r2.buckets} aktif` : "kapalı") : "?"}
                danger={!!d.system.r2 && d.system.r2.enabled && d.system.r2.buckets < 3}
              />
              {!!d.system.r2 && (
                <Row k="R2 · foto max boyut" v={d.system.r2.fullres_max_px ? `${d.system.r2.fullres_max_px}px` : "—"} />
              )}
              {(d.system.r2?.cors ?? []).map((c) => (
                <Row
                  key={c.index}
                  k={`R2 CORS · kova ${c.index} (${c.host})`}
                  v={c.ok ? "✓ ayarlı" : "✗ " + (c.detail || "yok")}
                  danger={!c.ok}
                />
              ))}
              {Object.entries(d.system.counts).map(([k, v]) => (
                <Row key={k} k={k} v={v} />
              ))}
              <Row k="Güncellendi" v={fmtWhen(d.generated_at)} />
            </Section>

            {/* Son İşlemler — her tarama/etiketleme/temizlik sonrası burada:
                ne çalıştı, ne zaman, yüzde kaçta durdu, başarılı mı, değilse
                neden. Bir işlem çalışırken görünmez (yukarıdaki canlı kart
                onu gösterir); burası SADECE biteni/duranı listeler. */}
            {d.job_runs?.length > 0 && (
              <Section title="Son İşlemler">
                {d.job_runs.map((r, i) => {
                  const meta = STATUS_META[r.status] ?? STATUS_META.error;
                  const color = r.status === "ok" ? colors.success : r.status === "partial" ? WARN_COLOR : colors.error;
                  return (
                    <View
                      key={`${r.job}-${r.finished_at}-${i}`}
                      style={[styles.jobRow, i > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }]}
                    >
                      <View style={styles.row}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
                          <Feather name={meta.icon} size={13} color={color} />
                          <Text style={{ color: colors.onSurface, fontWeight: "700", fontSize: fontSize.sm }}>{r.label}</Text>
                        </View>
                        <Text style={{ color, fontWeight: "700", fontSize: fontSize.xs }}>
                          {meta.word}{r.pct != null ? ` · %${r.pct}` : ""}
                        </Text>
                      </View>
                      <Text style={{ color: colors.brandSecondary, fontSize: fontSize.xs, marginTop: 2 }}>
                        {fmtWhen(r.finished_at)}{!!r.detail && ` · ${r.detail}`}
                      </Text>
                      {!!r.reason && (
                        <Text style={{ color, fontSize: fontSize.xs, marginTop: 4 }}>{r.reason}</Text>
                      )}
                    </View>
                  );
                })}
              </Section>
            )}

            {!!msg && (
              <Text style={{ color: colors.brandSecondary, fontSize: fontSize.xs, textAlign: "center", marginTop: spacing.lg }}>
                {msg}
              </Text>
            )}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Stat({
  label,
  value,
  colors,
  fontSize,
}: {
  label: string;
  value: string | number;
  colors: any;
  fontSize: any;
}) {
  return (
    <View style={[styles.stat, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}>
      <Text style={{ color: colors.onSurface, fontSize: fontSize["2xl"], fontWeight: "800", letterSpacing: -0.5 }}>{value}</Text>
      <Text style={{ color: colors.brandSecondary, fontSize: fontSize.xs, letterSpacing: 0.5, marginTop: 2 }}>
        {label.toLocaleUpperCase("tr-TR")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 17, fontWeight: "700" },
  sectionTitle: { fontSize: 11, letterSpacing: 1.5, marginBottom: 8, fontWeight: "700" },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 16 },
  statRow: { flexDirection: "row", gap: 10 },
  stat: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 14, alignItems: "flex-start" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 7 },
  jobRow: { paddingVertical: 9 },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingVertical: 12,
    marginTop: 14,
  },
  btnTxt: { fontWeight: "700", fontSize: 13 },
  btnRow: { flexDirection: "row", gap: 8, marginTop: 14, flexWrap: "wrap" },
  btnSm: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 12 },
  btnTxtSm: { fontWeight: "700", fontSize: 12 },
});
