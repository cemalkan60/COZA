// frontend/app/settings.tsx
import React from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { useTheme } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";

export default function Settings() {
  const { colors, spacing, mode, toggle } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, signOut } = useAuth();

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
