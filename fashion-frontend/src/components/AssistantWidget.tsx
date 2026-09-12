// Floating "help assistant" button (bottom-right, every screen once
// logged in) — like the chat widgets on most marketing sites. Backed by
// POST /assistant/chat: answers app-usage questions, and when the message
// describes a look, jumps straight to COZA Lens with those filters applied.
import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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

export default function AssistantWidget() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  // Only for logged-in users (never on the login screen), and native
  // navigate/search hand-offs need `user` anyway — same early-out shape as
  // every other screen in this app.
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

  return (
    <>
      <Pressable
        testID="assistant-fab"
        onPress={() => setOpen(true)}
        style={[styles.fab, { right: 20, bottom: insets.bottom + 20, backgroundColor: colors.brand }]}
      >
        <Feather name="message-circle" size={24} color={colors.onBrand} />
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.overlay} onPress={() => setOpen(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ width: "100%" }}>
            {/* A no-op onPress claims taps on the sheet itself so they don't
                bubble to the overlay's "tap outside to close" handler (see
                the report-modal bug this exact pattern fixed on web). */}
            <Pressable
              onPress={() => {}}
              style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + 12 }]}
            >
              <View style={[styles.header, { borderBottomColor: colors.divider }]}>
                <Text style={{ color: colors.onSurface, fontWeight: "800", fontSize: 15 }}>{t("assistant.title")}</Text>
                <Pressable testID="assistant-close" onPress={() => setOpen(false)} hitSlop={10}>
                  <Feather name="x" size={20} color={colors.onSurface} />
                </Pressable>
              </View>
              <ScrollView
                ref={scrollRef}
                style={styles.messages}
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
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 50,
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: "75%", overflow: "hidden" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  messages: { maxHeight: 360 },
  bubble: { maxWidth: "80%", borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  inputRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingTop: 10, borderTopWidth: 1 },
});
