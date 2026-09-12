// Floating "help assistant" button (bottom-right, every screen once
// logged in) — like the chat widgets on most marketing sites: the launcher
// button itself toggles into a close button, and a chat panel grows out of
// that same corner (not a full-width bottom sheet). Backed by
// POST /assistant/chat: answers app-usage questions, and when the message
// describes a look, jumps straight to COZA Lens with those filters applied.
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { useTheme } from "@/src/theme/ThemeContext";
import { useT } from "@/src/i18n";

type Msg = { role: "user" | "assistant"; text: string };

// Matches the enum the backend prompt is constrained to (gemini_client.py's
// _ASSISTANT_NAV_TARGETS) — keep these two lists in sync.
const NAV_ROUTES: Record<string, string> = {
  boards: "/fashion/boards",
  search: "/fashion/search",
  brands: "/fashion/brands",
  weeks: "/fashion/weeks",
  settings: "/settings",
  inbox: "/fashion/inbox",
};

const FAB_SIZE = 56;
const GAP = 16;

export default function AssistantWidget() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width: winW, height: winH } = useWindowDimensions();

  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  // Grows out of the launcher button rather than sliding up as a separate
  // sheet — scale+opacity from the same corner reads as "the box grew",
  // which is what was asked for instead of the previous bottom sheet.
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (open) {
      setMounted(true);
      Animated.timing(anim, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    } else if (mounted) {
      Animated.timing(anim, { toValue: 0, duration: 140, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(
        ({ finished }) => finished && setMounted(false),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Only for logged-in users (never on the login screen), and native
  // navigate/search hand-offs need `user` anyway — same early-out shape as
  // every other screen in this app. (After the hooks above — hooks must
  // run unconditionally on every render.)
  if (!user) return null;

  const scrollDown = () => setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const history = messages.slice(-6);
    setMessages((cur) => [...cur, { role: "user", text }]);
    setDraft("");
    setSending(true);
    scrollDown();
    try {
      const res = await api.assistantChat(text, history);
      setMessages((cur) => [...cur, { role: "assistant", text: res.reply }]);
      if (res.intent === "navigate" && res.navigate_to && NAV_ROUTES[res.navigate_to]) {
        setOpen(false);
        router.push(NAV_ROUTES[res.navigate_to] as any);
      } else if (res.intent === "search" && res.search_filters && Object.keys(res.search_filters).length > 0) {
        setOpen(false);
        const qs = Object.entries(res.search_filters)
          .filter(([, v]) => !!v)
          .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
          .join("&");
        router.push(`/fashion/search${qs ? `?${qs}` : ""}` as any);
      }
    } catch {
      setMessages((cur) => [...cur, { role: "assistant", text: t("assistant.error") }]);
    } finally {
      setSending(false);
      scrollDown();
    }
  };

  const panelW = Math.min(360, winW - GAP * 2);
  const panelH = Math.min(520, winH - insets.top - insets.bottom - FAB_SIZE - GAP * 3);
  const fabBottom = insets.bottom + 20;
  const fabRight = 20;

  return (
    <>
      {mounted && (
        // Full-screen, invisible — just here to close on "tap outside".
        // The panel below stops its own taps from reaching this (same fix
        // as the report-modal bug: a no-op onPress on the panel itself).
        <Pressable
          testID="assistant-scrim"
          style={StyleSheet.absoluteFillObject}
          onPress={() => setOpen(false)}
        />
      )}

      {mounted && (
        <Animated.View
          pointerEvents={open ? "auto" : "none"}
          style={[
            styles.panel,
            {
              width: panelW,
              height: panelH,
              right: fabRight,
              bottom: fabBottom + FAB_SIZE + 12,
              backgroundColor: colors.surface,
              borderColor: colors.border,
              opacity: anim,
              transform: [
                { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [panelH * 0.06, 0] }) },
                { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) },
              ],
            },
          ]}
        >
          <Pressable onPress={() => {}} style={{ flex: 1 }}>
            <View style={[styles.header, { borderBottomColor: colors.divider }]}>
              <Text style={{ color: colors.onSurface, fontWeight: "800", fontSize: 15 }}>{t("assistant.title")}</Text>
              <Pressable testID="assistant-close" onPress={() => setOpen(false)} hitSlop={10}>
                <Feather name="x" size={20} color={colors.onSurface} />
              </Pressable>
            </View>
            <ScrollView
              ref={scrollRef}
              style={{ flex: 1 }}
              contentContainerStyle={{ padding: 14, gap: 10 }}
              onContentSizeChange={scrollDown}
            >
              {messages.length === 0 && (
                <Text style={{ color: colors.brandSecondary, fontSize: 13, textAlign: "center", marginTop: 20, lineHeight: 19 }}>
                  {t("assistant.empty")}
                </Text>
              )}
              {messages.map((m, i) => (
                <View
                  key={i}
                  style={[
                    styles.bubble,
                    m.role === "user"
                      ? { alignSelf: "flex-end", backgroundColor: colors.brand }
                      : { alignSelf: "flex-start", backgroundColor: colors.surfaceSecondary },
                  ]}
                >
                  <Text style={{ color: m.role === "user" ? colors.onBrand : colors.onSurface, fontSize: 14, lineHeight: 19 }}>
                    {m.text}
                  </Text>
                </View>
              ))}
              {sending && (
                <View style={[styles.bubble, { alignSelf: "flex-start", backgroundColor: colors.surfaceSecondary }]}>
                  <ActivityIndicator size="small" color={colors.brand} />
                </View>
              )}
            </ScrollView>
            <View style={[styles.inputRow, { borderTopColor: colors.divider }]}>
              <TextInput
                testID="assistant-input"
                value={draft}
                onChangeText={setDraft}
                onSubmitEditing={send}
                placeholder={t("assistant.placeholder")}
                placeholderTextColor={colors.brandSecondary}
                style={{ flex: 1, color: colors.onSurface, fontSize: 14, paddingVertical: 8 }}
                returnKeyType="send"
                editable={!sending}
              />
              {sending ? (
                <ActivityIndicator size="small" color={colors.brand} />
              ) : (
                <Pressable testID="assistant-send" onPress={send} disabled={!draft.trim()} hitSlop={8}>
                  <Feather name="send" size={20} color={draft.trim() ? colors.brand : colors.brandSecondary} />
                </Pressable>
              )}
            </View>
          </Pressable>
        </Animated.View>
      )}

      <Pressable
        testID="assistant-fab"
        onPress={() => setOpen((v) => !v)}
        style={[styles.fab, { right: fabRight, bottom: fabBottom, backgroundColor: colors.brand }]}
      >
        <Feather name={open ? "x" : "message-circle"} size={24} color={colors.onBrand} />
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 51,
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
  panel: {
    position: "absolute",
    zIndex: 50,
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
    elevation: 10,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  bubble: { maxWidth: "80%", borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  inputRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingTop: 10, paddingBottom: Platform.OS === "web" ? 12 : 10, borderTopWidth: 1 },
});
