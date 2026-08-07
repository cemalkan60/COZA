import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Link, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { useTheme } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";
import { Logo } from "@/src/components/Logo";

const HERO = "https://images.pexels.com/photos/14875811/pexels-photo-14875811.jpeg";

export default function Login() {
  const { colors, spacing } = useTheme();
  const { signIn } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!email.trim() || !password) {
      setError("Lütfen e-posta ve şifrenizi girin.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await signIn(email, password);
      router.replace("/(tabs)");
    } catch (e: any) {
      setError(e?.message || "Giriş başarısız.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <View style={styles.hero}>
        <Image source={{ uri: HERO }} style={StyleSheet.absoluteFill} contentFit="cover" />
        <LinearGradient
          colors={["transparent", colors.surface + "AA", colors.surface]}
          style={StyleSheet.absoluteFill}
        />
        <View style={[styles.heroContent, { paddingTop: insets.top + 40 }]}>
          <Logo size={34} />
          <Text style={[styles.tagline, { color: colors.onSurfaceSecondary }]}>
            ZARA WOMAN — ÜRETİM & TEDARİK İZLEME
          </Text>
        </View>
      </View>

      <KeyboardAwareScrollView
        bottomOffset={24}
        contentContainerStyle={{ padding: spacing.xl, paddingBottom: insets.bottom + 40 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.title, { color: colors.onSurface }]}>Tekrar hoş geldiniz</Text>

        <Field
          label="E-POSTA"
          value={email}
          onChangeText={setEmail}
          placeholder="ornek@eposta.com"
          keyboardType="email-address"
          testID="login-email"
        />
        <Field
          label="ŞİFRE"
          value={password}
          onChangeText={setPassword}
          placeholder="••••••••"
          secureTextEntry
          testID="login-password"
        />

        {!!error && (
          <Text testID="login-error" style={[styles.error, { color: colors.error }]}>
            {error}
          </Text>
        )}

        <Pressable
          testID="login-submit"
          onPress={submit}
          disabled={loading}
          style={[styles.button, { backgroundColor: colors.brand, opacity: loading ? 0.7 : 1 }]}
        >
          {loading ? (
            <ActivityIndicator color={colors.onBrand} />
          ) : (
            <Text style={[styles.buttonText, { color: colors.onBrand }]}>Giriş Yap</Text>
          )}
        </Pressable>

        <View style={styles.footer}>
          <Text style={{ color: colors.brandSecondary }}>Hesabınız yok mu? </Text>
          <Link href="/(auth)/signup" replace asChild>
            <Pressable testID="go-signup">
              <Text style={{ color: colors.onSurface, fontWeight: "700" }}>Kayıt Ol</Text>
            </Pressable>
          </Link>
        </View>
      </KeyboardAwareScrollView>
    </View>
  );
}

export function Field({
  label,
  testID,
  ...props
}: React.ComponentProps<typeof TextInput> & { label: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ marginTop: 22 }}>
      <Text style={[styles.fieldLabel, { color: colors.brandSecondary }]}>{label}</Text>
      <TextInput
        testID={testID}
        placeholderTextColor={colors.brandSecondary}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { color: colors.onSurface, borderBottomColor: colors.border }]}
        {...props}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { height: 300 },
  heroContent: { flex: 1, paddingHorizontal: 24, justifyContent: "flex-start" },
  tagline: { marginTop: 10, fontSize: 11, letterSpacing: 1.6, fontWeight: "600" },
  title: { fontSize: 26, fontWeight: "800", letterSpacing: -0.5, marginTop: 4 },
  fieldLabel: { fontSize: 10, letterSpacing: 1.4, fontWeight: "700", marginBottom: 8 },
  input: { borderBottomWidth: 1, paddingVertical: 10, fontSize: 16 },
  error: { marginTop: 16, fontSize: 13 },
  button: {
    marginTop: 32,
    height: 54,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontSize: 15, fontWeight: "800", letterSpacing: 0.5 },
  footer: { flexDirection: "row", justifyContent: "center", marginTop: 28 },
});
