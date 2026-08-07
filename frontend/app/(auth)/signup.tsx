import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Link, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";

import { useTheme } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";
import { Logo } from "@/src/components/Logo";
import { Field } from "./login";

export default function Signup() {
  const { colors, spacing } = useTheme();
  const { signUp } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!email.trim() || password.length < 6) {
      setError("Geçerli bir e-posta ve en az 6 karakter şifre girin.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await signUp(email, password, name);
      router.replace("/(tabs)");
    } catch (e: any) {
      setError(e?.message || "Kayıt başarısız.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <View pointerEvents="none" style={styles.watermark}>
        <Logo size={96} color={colors.surfaceSecondary} />
      </View>

      <KeyboardAwareScrollView
        bottomOffset={24}
        contentContainerStyle={{
          flexGrow: 1,
          padding: spacing.xl,
          paddingTop: insets.top + 80,
          justifyContent: "center",
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: "center", marginBottom: 44 }}>
          <Logo size={40} />
        </View>

        <Text style={[styles.title, { color: colors.onSurface }]}>Hesap Oluştur</Text>

        <Field
          label="AD"
          value={name}
          onChangeText={setName}
          placeholder="Adınız"
          autoCapitalize="words"
          testID="signup-name"
        />
        <Field
          label="E-POSTA"
          value={email}
          onChangeText={setEmail}
          placeholder="ornek@eposta.com"
          keyboardType="email-address"
          testID="signup-email"
        />
        <Field
          label="ŞİFRE"
          value={password}
          onChangeText={setPassword}
          placeholder="En az 6 karakter"
          secureTextEntry
          testID="signup-password"
        />

        {!!error && (
          <Text testID="signup-error" style={[styles.error, { color: colors.error }]}>
            {error}
          </Text>
        )}

        <Pressable
          testID="signup-submit"
          onPress={submit}
          disabled={loading}
          style={[styles.button, { backgroundColor: colors.brand, opacity: loading ? 0.7 : 1 }]}
        >
          {loading ? (
            <ActivityIndicator color={colors.onBrand} />
          ) : (
            <Text style={[styles.buttonText, { color: colors.onBrand }]}>Hesap Oluştur</Text>
          )}
        </Pressable>

        <View style={styles.footer}>
          <Text style={{ color: colors.brandSecondary }}>Zaten üye misiniz? </Text>
          <Link href="/(auth)/login" replace asChild>
            <Pressable testID="go-login">
              <Text style={{ color: colors.onSurface, fontWeight: "700" }}>Giriş Yap</Text>
            </Pressable>
          </Link>
        </View>
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  watermark: {
    position: "absolute",
    top: 110,
    left: 0,
    right: 0,
    alignItems: "center",
    opacity: 0.6,
  },
  title: { fontSize: 26, fontWeight: "800", letterSpacing: -0.5, marginBottom: 4 },
  error: { marginTop: 16, fontSize: 13 },
  button: { marginTop: 32, height: 54, borderRadius: 4, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 15, fontWeight: "800", letterSpacing: 0.5 },
  footer: { flexDirection: "row", justifyContent: "center", marginTop: 28 },
});
