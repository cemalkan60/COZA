import { Redirect, Stack } from "expo-router";

import { useAuth } from "@/src/context/AuthContext";

export default function AuthLayout() {
  const { token, loading } = useAuth();
  if (loading) return null;
  if (token) return <Redirect href="/fashion" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
