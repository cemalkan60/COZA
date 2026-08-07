import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";

import { useTheme } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";
import { Logo } from "@/src/components/Logo";

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
      setError("Lütfen kullanıcı adı ve şifrenizi girin.");
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
      {/* Faint watermark logo */}
      <View pointerEvents="none" style={styles.watermark}>
        <Logo size={96} color={colors.surfaceSecondary} />
      </View>

      <KeyboardAwareScrollView
        bottomOffset={24}
        contentContainerStyle={{
          flexGrow: 1,
          padding: spacing.xl,
          paddingTop: insets.top + 90,
          justifyContent: "center",
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: "center", marginBottom: 56 }}>
          <Logo size={44} />
        </View>

        <Text style={[styles.title, { color: colors.onSurface }]}>Giriş Yap</Text>

        <Field
          label="KULLANICI ADI"
          value={email}
          onChangeText={setEmail}
          placeholder="kullanıcı adı"
          autoCapitalize="none"
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
  watermark: {
    position: "absolute",
    top: 120,
    left: 0,
    right: 0,
    alignItems: "center",
    opacity: 0.6,
  },
  title: { fontSize: 26, fontWeight: "800", letterSpacing: -0.5, marginBottom: 4 },
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
});
