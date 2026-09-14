import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { LogBox, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { StatusBar } from "expo-status-bar";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { ThemeProvider, useTheme } from "@/src/theme/ThemeContext";
import { AuthProvider, useAuth } from "@/src/context/AuthContext";
import { LanguageProvider } from "@/src/i18n";
import AssistantWidget from "@/src/components/AssistantWidget";

// Disable logbox errors etc so that users can see the app
// and agent works as expected.
LogBox.ignoreAllLogs(true);

// Keep the native splash visible from cold start until icon fonts register.
// Required because @expo/vector-icons' componentDidMount fallback fires
// Font.loadAsync against a broken vendor path if any <Icon> mounts before
// the family is registered — which throws on Android Expo Go.
SplashScreen.preventAutoHideAsync();

function ThemedShell() {
  const { colors, mode } = useTheme();
  const { token, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // Only "/" (index.tsx) itself checks auth and redirects — a direct/deep
  // link straight into a protected route (typed URL, bookmark, refresh)
  // skips that check entirely, hits the API unauthenticated, and gets stuck
  // on a generic load-error since 401s aren't distinguished from network
  // failures. Guard every route here instead, once, rather than in each
  // screen.
  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === "(auth)";
    // fashion/public/[token] is a deliberately no-login board share link —
    // never bounce it to the login screen.
    const isPublicShare = segments[0] === "fashion" && segments[1] === "public";
    if (!token && !inAuthGroup && !isPublicShare) {
      router.replace("/(auth)/login");
    }
  }, [token, loading, segments, router]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <StatusBar style={mode === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.surface },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="fashion" />
        <Stack.Screen name="fashion/search" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="fashion/boards" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="fashion/house" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="fashion/brands" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="fashion/lookbook" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="fashion/public/[token]" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="fashion/weeks" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="fashion/week" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="fashion/inbox" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="fashion/brand/[id]" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="settings" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="admin" options={{ animation: "slide_from_right" }} />
      </Stack>
      <AssistantWidget />
    </View>
  );
}

export default function RootLayout() {
  const [loaded, error] = useIconFonts();

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  // If the CDN is unreachable we fall through on error rather than wedging
  // the app — icons will tofu, but the app still boots.
  if (!loaded && !error) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <ThemeProvider>
            <LanguageProvider>
              <AuthProvider>
                <ThemedShell />
              </AuthProvider>
            </LanguageProvider>
          </ThemeProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
