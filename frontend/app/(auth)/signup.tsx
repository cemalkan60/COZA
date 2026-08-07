import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Link, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";

import { useTheme } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";
import { Logo } from "@/src/components/Logo";
import { Field } from "./login";

const HERO = "https://images.pexels.com/photos/11182234/pexels-photo-11182234.jpeg";

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
      <View style={styles.hero}>
        <Image source={{ uri: HERO }} style={StyleSheet.absoluteFill} contentFit="cover" />
        <LinearGradient
          colors={["transparent", colors.surface + "AA", colors.surface]}
          style={StyleSheet.absoluteFill}
        />
        <View style={[styles.heroContent, { paddingTop: insets.top + 36 }]}>
          <Logo size={30} />
          <Text style={[styles.tagline, { color: colors.onSurfaceSecondary }]}>
            KOLEKSİYONU TAKİP ETMEYE BAŞLAYIN
          </Text>
        </View>
      </View>

      <KeyboardAwareScrollView
        bottomOffset={24}
        contentContainerStyle={{ padding: spacing.xl, paddingBottom: insets.bottom + 40 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.title, { color: colors.onSurface }]}>Hesap oluştur</Text>

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
  hero: { height: 260 },
  heroContent: { flex: 1, paddingHorizontal: 24 },
  tagline: { marginTop: 10, fontSize: 11, letterSpacing: 1.6, fontWeight: "600" },
  title: { fontSize: 26, fontWeight: "800", letterSpacing: -0.5, marginTop: 4 },
  error: { marginTop: 16, fontSize: 13 },
  button: { marginTop: 32, height: 54, borderRadius: 4, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 15, fontWeight: "800", letterSpacing: 0.5 },
  footer: { flexDirection: "row", justifyContent: "center", marginTop: 28 },
});
