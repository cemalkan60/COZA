import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View, ScrollView } from "react-native";
import { DrawerContentScrollView } from "@react-navigation/drawer";
import { Feather } from "@expo/vector-icons";

import { api } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { Logo } from "@/src/components/Logo";

const NAV: { route: string; label: string; icon: any }[] = [
  { route: "index", label: "Katalog", icon: "grid" },
  { route: "new", label: "Yeni Gelenler", icon: "zap" },
  { route: "analytics", label: "Analiz", icon: "pie-chart" },
  { route: "favorites", label: "Favoriler", icon: "heart" },
  { route: "profile", label: "Profil", icon: "user" },
];

export function DrawerContent(props: any) {
  const { colors } = useTheme();
  const [categories, setCategories] = useState<string[]>([]);
  const [origins, setOrigins] = useState<string[]>([]);
  const current = props.state?.routeNames?.[props.state?.index] ?? "index";

  useEffect(() => {
    api
      .filters()
      .then((f) => {
        setCategories(f.categories || []);
        setOrigins((f.origins || []).filter((o: string) => o && o !== "Belirleniyor…"));
      })
      .catch(() => {});
  }, []);

  const go = (route: string, params?: any) => {
    props.navigation.navigate(route, params);
    props.navigation.closeDrawer();
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <DrawerContentScrollView {...props} contentContainerStyle={{ paddingTop: 8 }}>
        <View style={{ paddingHorizontal: 20, paddingVertical: 16 }}>
          <Logo size={26} />
        </View>

        {NAV.map((n) => {
          const active = current === n.route;
          return (
            <Pressable
              key={n.route}
              testID={`drawer-${n.route}`}
              onPress={() => go(n.route)}
              style={[styles.navItem, active && { backgroundColor: colors.surfaceSecondary }]}
            >
              <Feather name={n.icon} size={18} color={active ? colors.onSurface : colors.brandSecondary} />
              <Text
                style={{
                  color: active ? colors.onSurface : colors.onSurfaceSecondary,
                  fontWeight: active ? "800" : "600",
                  fontSize: 15,
                  marginLeft: 14,
                  letterSpacing: 0.2,
                }}
              >
                {n.label}
              </Text>
            </Pressable>
          );
        })}

        <Text style={[styles.section, { color: colors.brandSecondary }]}>KATEGORİLER</Text>
        <Pressable testID="drawer-cat-all" onPress={() => go("index", { category: "", ts: Date.now() })} style={styles.subItem}>
          <Text style={[styles.subText, { color: colors.onSurface, fontWeight: "700" }]}>Tümü</Text>
        </Pressable>
        {categories.map((c) => (
          <Pressable
            key={c}
            testID={`drawer-cat-${c}`}
            onPress={() => go("index", { category: c, ts: Date.now() })}
            style={styles.subItem}
          >
            <Text style={[styles.subText, { color: colors.onSurfaceSecondary }]}>{c}</Text>
            <Feather name="chevron-right" size={15} color={colors.brandSecondary} />
          </Pressable>
        ))}

        <Text style={[styles.section, { color: colors.brandSecondary }]}>ÜRETİM YERİ</Text>
        {origins.map((o) => (
          <Pressable
            key={o}
            testID={`drawer-origin-${o}`}
            onPress={() => go("index", { origin: o, ts: Date.now() })}
            style={styles.subItem}
          >
            <Text style={[styles.subText, { color: colors.onSurfaceSecondary }]}>{o}</Text>
            <Feather name="map-pin" size={13} color={colors.brandSecondary} />
          </Pressable>
        ))}
        <View style={{ height: 40 }} />
      </DrawerContentScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 13,
    paddingHorizontal: 20,
    marginHorizontal: 8,
    borderRadius: 6,
  },
  section: {
    fontSize: 10,
    letterSpacing: 1.4,
    fontWeight: "700",
    marginTop: 22,
    marginBottom: 8,
    paddingHorizontal: 20,
  },
  subItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 11,
    paddingHorizontal: 20,
  },
  subText: { fontSize: 14, letterSpacing: 0.2 },
});
