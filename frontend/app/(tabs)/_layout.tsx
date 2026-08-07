import { Redirect } from "expo-router";
import { Drawer } from "expo-router/drawer";
import { View } from "react-native";

import { useAuth } from "@/src/context/AuthContext";
import { useTheme } from "@/src/theme/ThemeContext";
import { Logo } from "@/src/components/Logo";
import { DrawerContent } from "@/src/components/DrawerContent";
import { CompareBar } from "@/src/components/CompareBar";

export default function AppLayout() {
  const { token, loading } = useAuth();
  const { colors } = useTheme();

  if (loading) return null;
  if (!token) return <Redirect href="/(auth)/login" />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <Drawer
        drawerContent={(props) => <DrawerContent {...props} />}
        screenOptions={{
          drawerType: "front",
          drawerStyle: { backgroundColor: colors.surface, width: 300 },
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.onSurface,
          headerShadowVisible: false,
          headerTitleStyle: { fontWeight: "800", letterSpacing: 0.3, color: colors.onSurface },
          sceneStyle: { backgroundColor: colors.surface },
        }}
      >
        <Drawer.Screen
          name="index"
          options={{ headerTitle: () => <Logo size={20} />, title: "Katalog" }}
        />
        <Drawer.Screen name="new" options={{ title: "Yeni Gelenler" }} />
        <Drawer.Screen name="analytics" options={{ title: "Analiz" }} />
        <Drawer.Screen name="favorites" options={{ title: "Favoriler" }} />
        <Drawer.Screen name="profile" options={{ title: "Profil" }} />
      </Drawer>
      <CompareBar />
    </View>
  );
}
