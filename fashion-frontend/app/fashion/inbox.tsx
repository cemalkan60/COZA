// frontend/app/fashion/inbox.tsx — E5: "Bana gönderilenler". Comments that
// @mention you, plus comments on any board you own or collaborate on.
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api, BoardComment } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useT } from "@/src/i18n";
import { goBack } from "@/src/utils/nav";
import { formatDate } from "@/src/utils/format";

export default function Inbox() {
  const { colors, spacing } = useTheme();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [items, setItems] = useState<BoardComment[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      api
        .notifications()
        .then((r) => setItems(r.items || []))
        .catch(() => setItems([]))
        .finally(() => setLoading(false));
      api.markNotificationsSeen().catch(() => {});
    }, []),
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <View style={[styles.header, { paddingTop: insets.top + 8, paddingHorizontal: spacing.xl, borderBottomColor: colors.divider }]}>
        <Pressable testID="inbox-back" onPress={() => goBack(router, "/fashion")} hitSlop={10}>
          <Feather name="chevron-left" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={[styles.title, { color: colors.onSurface }]}>{t("inbox.title")}</Text>
        <View style={{ width: 26 }} />
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: insets.bottom + 32 }}>
          {items.length === 0 && (
            <Text style={{ color: colors.brandSecondary, textAlign: "center", marginTop: 40 }}>{t("inbox.empty")}</Text>
          )}
          {items.map((c) => (
            <Pressable
              key={c.id}
              testID={`inbox-item-${c.id}`}
              onPress={() => router.push(`/fashion/boards?board=${encodeURIComponent(c.board_id)}` as any)}
              style={[styles.row, { borderColor: colors.border, backgroundColor: c.mentioned_you ? colors.surfaceSecondary : "transparent" }]}
            >
              <Feather name={c.mentioned_you ? "at-sign" : "message-circle"} size={16} color={c.mentioned_you ? colors.brand : colors.brandSecondary} />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={{ color: colors.onSurface, fontSize: 13 }}>
                  <Text style={{ fontWeight: "800" }}>{c.user_name}</Text> — {c.board_name}
                </Text>
                <Text numberOfLines={2} style={{ color: colors.brandSecondary, fontSize: 12, marginTop: 2, lineHeight: 16 }}>
                  {c.text}
                </Text>
                <Text style={{ color: colors.brandSecondary, fontSize: 10, marginTop: 4 }}>{formatDate(c.created_at)}</Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingBottom: 12, borderBottomWidth: 1 },
  title: { fontSize: 18, fontWeight: "800" },
  row: { flexDirection: "row", alignItems: "flex-start", padding: 12, borderRadius: 8, borderWidth: 1, marginBottom: 10 },
});
