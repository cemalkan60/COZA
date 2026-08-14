import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import { useAuth } from "@/src/context/AuthContext";
import { useTheme } from "@/src/theme/ThemeContext";

export default function Index() {
  const { token, loading } = useAuth();
  const { colors, ready } = useTheme();

  if (loading || !ready) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.surface,
        }}
      >
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }

  return <Redirect href={token ? "/hub" : "/(auth)/login"} />;
}
