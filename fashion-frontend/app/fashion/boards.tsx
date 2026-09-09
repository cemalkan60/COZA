import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { api, Board, SavedPhoto } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useT } from "@/src/i18n";
import { fashionImageUri } from "@/src/utils/fashionImage";
import { goBack } from "@/src/utils/nav";
import { shareBoard } from "@/src/utils/shareBoard";
import { ZoomableImage } from "@/src/components/ZoomableImage";

export default function Boards() {
  const { colors, spacing } = useTheme();
  const { t, formatSeason } = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams();
  const { width, height } = useWindowDimensions();

  const boardId = (params.board as string) || "";

  const [boards, setBoards] = useState<Board[]>([]);
  const [photos, setPhotos] = useState<SavedPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState("");
  const [viewer, setViewer] = useState<SavedPhoto | null>(null);

  const current = useMemo(() => boards.find((b) => b.id === boardId) || null, [boards, boardId]);
  const subFolders = useMemo(
    () => boards.filter((b) => (b.parent_id ?? null) === (boardId || null)),
    [boards, boardId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [bl, ph] = await Promise.all([
        api.boardsList(),
        boardId ? api.boardPhotos(boardId) : Promise.resolve({ items: [] as SavedPhoto[] }),
      ]);
      setBoards(bl.boards || []);
      setPhotos(ph.items || []);
    } catch {
      setBoards([]);
      setPhotos([]);
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const createFolder = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      await api.boardCreate(name, boardId || null);
      setNewName("");
      setCreating(false);
      load();
    } catch {}
  };

  const doRename = async () => {
    if (!current || !renameVal.trim()) return;
    try {
      await api.boardUpdate(current.id, { name: renameVal.trim() });
      setRenaming(false);
      load();
    } catch {}
  };

  const doDelete = async () => {
    if (!current) return;
    try {
      await api.boardDelete(current.id);
      router.replace(current.parent_id ? `/fashion/boards?board=${encodeURIComponent(current.parent_id)}` : "/fashion/boards");
    } catch {}
  };

  const removePhoto = async (p: SavedPhoto) => {
    try {
      await api.unsavePhoto(p.board_id, p.source_id, p.photo_index);
      setPhotos((cur) => cur.filter((x) => !(x.source_id === p.source_id && x.photo_index === p.photo_index)));
      setViewer(null);
    } catch {}
  };

  const cols = width >= 1200 ? 5 : width >= 900 ? 4 : width >= 600 ? 3 : 2;
  const gap = 10;
  const pad = spacing.xl - 4;
  const cardW = (width - pad * 2 - gap * (cols - 1)) / cols;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <View style={[styles.header, { paddingTop: insets.top + 8, paddingHorizontal: spacing.xl, borderBottomColor: colors.divider }]}>
        <Pressable
          testID="boards-back"
          onPress={() =>
            current?.parent_id
              ? router.replace(`/fashion/boards?board=${encodeURIComponent(current.parent_id)}`)
              : boardId
                ? router.replace("/fashion/boards")
                : goBack(router, "/fashion")
          }
          hitSlop={10}
        >
          <Feather name="chevron-left" size={26} color={colors.onSurface} />
        </Pressable>
        <Text numberOfLines={1} style={[styles.title, { color: colors.onSurface }]}>
          {current ? current.name : t("boards.title")}
        </Text>
        {current ? (
          <Pressable onPress={() => setMenuOpen(true)} hitSlop={10}>
            <Feather name="more-horizontal" size={22} color={colors.onSurface} />
          </Pressable>
        ) : (
          <View style={{ width: 22 }} />
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40, paddingHorizontal: pad, paddingTop: 14 }}>
          {/* Sub-folders */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap }}>
            {subFolders.map((b) => (
              <Pressable
                key={b.id}
                testID={`board-folder-${b.id}`}
                onPress={() => router.push(`/fashion/boards?board=${encodeURIComponent(b.id)}`)}
                style={{ width: cardW }}
              >
                <View style={[styles.folderCover, { backgroundColor: colors.surfaceTertiary, borderColor: colors.border }]}>
                  {b.cover ? (
                    <Image source={{ uri: fashionImageUri(b.cover) }} style={{ width: "100%", height: "100%" }} contentFit="cover" />
                  ) : (
                    <Feather name="folder" size={26} color={colors.brandSecondary} />
                  )}
                </View>
                <Text numberOfLines={1} style={{ color: colors.onSurface, fontWeight: "700", fontSize: 13, marginTop: 6 }}>
                  {b.name}
                </Text>
                <Text style={{ color: colors.brandSecondary, fontSize: 11 }}>
                  {t("boards.itemCount", { count: b.photo_count ?? 0 })}
                </Text>
              </Pressable>
            ))}

            {creating ? (
              <View style={{ width: cardW }}>
                <View style={[styles.folderCover, { borderColor: colors.brand, borderStyle: "dashed", alignItems: "center", justifyContent: "center" }]}>
                  <Feather name="folder-plus" size={22} color={colors.brand} />
                </View>
                <TextInput
                  autoFocus
                  value={newName}
                  onChangeText={setNewName}
                  onSubmitEditing={createFolder}
                  onBlur={() => (newName.trim() ? createFolder() : setCreating(false))}
                  placeholder={t("boards.folderName")}
                  placeholderTextColor={colors.brandSecondary}
                  style={{ color: colors.onSurface, fontSize: 13, marginTop: 6, fontWeight: "700" }}
                  returnKeyType="done"
                />
              </View>
            ) : (
              <Pressable testID="boards-new-folder" onPress={() => setCreating(true)} style={{ width: cardW }}>
                <View style={[styles.folderCover, { borderColor: colors.border, borderStyle: "dashed", alignItems: "center", justifyContent: "center" }]}>
                  <Feather name="folder-plus" size={22} color={colors.brandSecondary} />
                </View>
                <Text style={{ color: colors.brandSecondary, fontWeight: "700", fontSize: 13, marginTop: 6 }}>
                  {t("boards.newFolder")}
                </Text>
              </Pressable>
            )}
          </View>

          {/* Photos saved directly in this board */}
          {photos.length > 0 && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap, marginTop: 22 }}>
              {photos.map((p) => (
                <Pressable
                  key={`${p.source_id}#${p.photo_index}`}
                  onPress={() => setViewer(p)}
                  onLongPress={() => removePhoto(p)}
                  style={{ width: cardW }}
                >
                  <View style={[styles.photo, { backgroundColor: colors.surfaceTertiary, borderColor: colors.border }]}>
                    <Image
                      source={{ uri: fashionImageUri(p.image_thumb || p.image) }}
                      style={{ width: "100%", height: "100%" }}
                      contentFit="cover"
                      transition={200}
                    />
                  </View>
                  <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 12, fontWeight: "700", marginTop: 4 }}>
                    {p.brand_tr || "—"}
                    {p.season ? (
                      <Text style={{ color: colors.brandSecondary, fontWeight: "600" }}> · {formatSeason(p.season, p.season_label)}</Text>
                    ) : null}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}

          {boardId && subFolders.length === 0 && photos.length === 0 && !creating && (
            <Text style={{ color: colors.brandSecondary, textAlign: "center", marginTop: 50 }}>{t("boards.emptyBoard")}</Text>
          )}
          {!boardId && subFolders.length === 0 && !creating && (
            <Text style={{ color: colors.brandSecondary, textAlign: "center", marginTop: 50 }}>{t("boards.empty")}</Text>
          )}
        </ScrollView>
      )}

      {/* board actions menu */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuOverlay} onPress={() => setMenuOpen(false)}>
          <View style={[styles.menu, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            {photos.length > 0 && (
              <Pressable
                style={styles.menuItem}
                onPress={() => {
                  setMenuOpen(false);
                  shareBoard(current?.name || "COZA", photos);
                }}
              >
                <Feather name="share-2" size={16} color={colors.onSurface} />
                <Text style={{ color: colors.onSurface, fontWeight: "600", marginLeft: 10 }}>{t("boards.share")}</Text>
              </Pressable>
            )}
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenuOpen(false);
                setRenameVal(current?.name || "");
                setRenaming(true);
              }}
            >
              <Feather name="edit-2" size={16} color={colors.onSurface} />
              <Text style={{ color: colors.onSurface, fontWeight: "600", marginLeft: 10 }}>{t("boards.rename")}</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={() => { setMenuOpen(false); doDelete(); }}>
              <Feather name="trash-2" size={16} color={colors.error} />
              <Text style={{ color: colors.error, fontWeight: "600", marginLeft: 10 }}>{t("boards.delete")}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      <Modal visible={renaming} transparent animationType="fade" onRequestClose={() => setRenaming(false)}>
        <View style={styles.menuOverlay}>
          <View style={[styles.renameBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <TextInput
              autoFocus
              value={renameVal}
              onChangeText={setRenameVal}
              onSubmitEditing={doRename}
              placeholder={t("boards.boardName")}
              placeholderTextColor={colors.brandSecondary}
              style={{ color: colors.onSurface, fontSize: 15, borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: 8 }}
            />
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 18, marginTop: 16 }}>
              <Pressable onPress={() => setRenaming(false)}>
                <Text style={{ color: colors.brandSecondary, fontWeight: "700" }}>{t("common.cancel")}</Text>
              </Pressable>
              <Pressable onPress={doRename}>
                <Text style={{ color: colors.brand, fontWeight: "700" }}>{t("common.save")}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* fullscreen photo viewer */}
      <Modal visible={!!viewer} transparent animationType="fade" onRequestClose={() => setViewer(null)}>
        <View style={styles.viewerOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setViewer(null)} />
          <Pressable style={[styles.viewerBtn, { top: insets.top + 12, right: 16 }]} onPress={() => setViewer(null)} hitSlop={12}>
            <Feather name="x" size={24} color="#fff" />
          </Pressable>
          {viewer && (
            <Pressable style={[styles.viewerBtn, { top: insets.top + 12, left: 16 }]} onPress={() => removePhoto(viewer)} hitSlop={12}>
              <Feather name="trash-2" size={22} color="#fff" />
            </Pressable>
          )}
          {viewer && (
            <View pointerEvents="box-none" style={{ alignItems: "center" }}>
              <ZoomableImage uri={fashionImageUri(viewer.image)} width={width * 0.92} height={height * 0.72} contentFit="contain" />
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 12, borderBottomWidth: 1 },
  title: { fontSize: 18, fontWeight: "800", flex: 1 },
  folderCover: { width: "100%", aspectRatio: 1, borderRadius: 8, overflow: "hidden", borderWidth: 1, alignItems: "center", justifyContent: "center" },
  photo: { width: "100%", aspectRatio: 3 / 4, borderRadius: 4, overflow: "hidden", borderWidth: 1 },
  menuOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", alignItems: "center", justifyContent: "center" },
  menu: { borderRadius: 12, borderWidth: 1, paddingVertical: 6, minWidth: 200 },
  menuItem: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 16 },
  renameBox: { borderRadius: 12, borderWidth: 1, padding: 18, width: "80%", maxWidth: 360 },
  viewerOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.95)", alignItems: "center", justifyContent: "center" },
  viewerBtn: {
    position: "absolute",
    zIndex: 10,
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.15)",
  },
});
