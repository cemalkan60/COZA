// frontend/app/fashion/public/[token].tsx — F5: read-only, no login needed.
// Deliberately doesn't import AuthContext/api-authenticated calls — a
// visitor with just the link (never signed in) must be able to open this.
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api, SavedPhoto } from "@/src/api/client";
import { fashionImageUri } from "@/src/utils/fashionImage";
import RetryImage from "@/src/components/RetryImage";

export default function PublicBoard() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams();
  const token = (params.token as string) || "";

  const [name, setName] = useState("");
  const [photos, setPhotos] = useState<SavedPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [viewer, setViewer] = useState<SavedPhoto | null>(null);

  useEffect(() => {
    if (!token) return;
    api
      .publicBoard(token)
      .then((r) => {
        setName(r.name);
        setPhotos(r.photos || []);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [token]);

  const cols = width >= 900 ? 4 : width >= 600 ? 3 : 2;
  const cardW = (width - 24 * 2 - 10 * (cols - 1)) / cols;

  return (
    <View style={{ flex: 1, backgroundColor: "#0a0a0a" }}>
      <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
        <Text style={styles.brand}>COZA</Text>
        {!!name && <Text style={styles.boardName}>{name}</Text>}
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color="#fff" />
        </View>
      ) : error ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
          <Feather name="link-2" size={26} color="#666" />
          <Text style={{ color: "#999", marginTop: 12, textAlign: "center" }}>Bu bağlantı artık geçerli değil.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: insets.bottom + 40 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            {photos.map((p) => (
              <Pressable key={`${p.source_id}#${p.photo_index}`} onPress={() => setViewer(p)} style={{ width: cardW }}>
                <RetryImage
                  uri={fashionImageUri(p.image_thumb || p.image)}
                  style={{ width: cardW, aspectRatio: 3 / 4, borderRadius: 4, backgroundColor: "#1a1a1a" }}
                  contentFit="cover"
                />
                <Text numberOfLines={1} style={styles.caption}>
                  {p.brand_tr || "—"}
                </Text>
              </Pressable>
            ))}
          </View>
          {photos.length === 0 && <Text style={{ color: "#666", textAlign: "center", marginTop: 40 }}>Bu pano boş.</Text>}
        </ScrollView>
      )}

      <Modal visible={!!viewer} transparent animationType="fade" onRequestClose={() => setViewer(null)}>
        <Pressable style={styles.viewerOverlay} onPress={() => setViewer(null)}>
          {viewer && (
            <RetryImage
              uri={fashionImageUri(viewer.image)}
              style={{ width: width * 0.94, height: "80%" }}
              contentFit="contain"
            />
          )}
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 24, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: "#222" },
  brand: { color: "#fff", fontWeight: "800", fontSize: 13, letterSpacing: 3 },
  boardName: { color: "#eee", fontWeight: "700", fontSize: 20, marginTop: 4 },
  caption: { color: "#ccc", fontSize: 12, fontWeight: "700", marginTop: 4 },
  viewerOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.95)", alignItems: "center", justifyContent: "center" },
});
