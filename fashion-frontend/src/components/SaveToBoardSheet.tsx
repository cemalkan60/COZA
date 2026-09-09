import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { api, Board, SavePhotoInput } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useT } from "@/src/i18n";

// Pinterest-style "save this photo to a board" sheet. Boards are nested
// folders (parent_id); this lets you drill in, create a folder at the
// current level, and tap a folder to toggle the photo in/out of it.
export function SaveToBoardSheet({
  visible,
  onClose,
  photo,
  savedBoardIds,
  onChange,
}: {
  visible: boolean;
  onClose: () => void;
  photo: SavePhotoInput | null;
  savedBoardIds: string[];
  onChange: () => void;
}) {
  const { colors, spacing } = useTheme();
  const { t } = useT();
  const [boards, setBoards] = useState<Board[]>([]);
  const [loading, setLoading] = useState(true);
  const [path, setPath] = useState<Board[]>([]); // breadcrumb, [] = root
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const parentId = path.length ? path[path.length - 1].id : null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.boardsList();
      setBoards(res.boards || []);
    } catch {
      setBoards([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      setPath([]);
      setCreating(false);
      setNewName("");
      load();
    }
  }, [visible, load]);

  const levelBoards = useMemo(
    () => boards.filter((b) => (b.parent_id ?? null) === parentId),
    [boards, parentId],
  );
  const childCount = (id: string) => boards.filter((b) => b.parent_id === id).length;
  const saved = new Set(savedBoardIds);

  const toggleSave = async (b: Board) => {
    if (!photo || busyId) return;
    setBusyId(b.id);
    try {
      if (saved.has(b.id)) {
        await api.unsavePhoto(b.id, photo.source_id, photo.photo_index);
      } else {
        await api.savePhoto(b.id, photo);
      }
      onChange();
    } catch {
      // ignore
    } finally {
      setBusyId(null);
    }
  };

  const createBoard = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusyId("__new__");
    try {
      const b = await api.boardCreate(name, parentId);
      setBoards((cur) => [...cur, b]);
      setNewName("");
      setCreating(false);
      if (photo) {
        await api.savePhoto(b.id, photo);
        onChange();
      }
    } catch {
      // ignore
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: colors.surface, paddingHorizontal: spacing.xl }]}>
          <View style={styles.header}>
            {path.length > 0 ? (
              <Pressable onPress={() => setPath((p) => p.slice(0, -1))} hitSlop={10}>
                <Feather name="chevron-left" size={22} color={colors.onSurface} />
              </Pressable>
            ) : (
              <View style={{ width: 22 }} />
            )}
            <Text numberOfLines={1} style={[styles.title, { color: colors.onSurface }]}>
              {path.length ? path[path.length - 1].name : t("detail.saveToBoard")}
            </Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Feather name="x" size={22} color={colors.onSurface} />
            </Pressable>
          </View>

          {loading ? (
            <View style={{ paddingVertical: 40 }}>
              <ActivityIndicator color={colors.brand} />
            </View>
          ) : (
            <ScrollView style={{ maxHeight: 380 }} showsVerticalScrollIndicator={false}>
              {levelBoards.length === 0 && !creating && (
                <Text style={{ color: colors.brandSecondary, fontSize: 13, paddingVertical: 16 }}>
                  {t("boards.empty")}
                </Text>
              )}
              {levelBoards.map((b) => {
                const isSaved = saved.has(b.id);
                const kids = childCount(b.id);
                return (
                  <View key={b.id} style={[styles.row, { borderColor: colors.divider }]}>
                    <Pressable style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }} onPress={() => toggleSave(b)}>
                      <Feather
                        name={isSaved ? "check-circle" : "circle"}
                        size={20}
                        color={isSaved ? colors.brand : colors.brandSecondary}
                      />
                      <View style={{ flex: 1 }}>
                        <Text numberOfLines={1} style={{ color: colors.onSurface, fontWeight: "700", fontSize: 14 }}>
                          {b.name}
                        </Text>
                        <Text style={{ color: colors.brandSecondary, fontSize: 11, marginTop: 1 }}>
                          {t("boards.itemCount", { count: b.photo_count ?? 0 })}
                        </Text>
                      </View>
                      {busyId === b.id && <ActivityIndicator size="small" color={colors.brandSecondary} />}
                    </Pressable>
                    {kids > 0 && (
                      <Pressable onPress={() => setPath((p) => [...p, b])} hitSlop={10} style={{ paddingLeft: 10 }}>
                        <Feather name="chevron-right" size={20} color={colors.brandSecondary} />
                      </Pressable>
                    )}
                  </View>
                );
              })}

              {creating ? (
                <View style={[styles.row, { borderColor: colors.divider }]}>
                  <TextInput
                    autoFocus
                    value={newName}
                    onChangeText={setNewName}
                    placeholder={t("boards.folderName")}
                    placeholderTextColor={colors.brandSecondary}
                    style={{ flex: 1, color: colors.onSurface, fontSize: 14, paddingVertical: 6 }}
                    onSubmitEditing={createBoard}
                    returnKeyType="done"
                  />
                  <Pressable onPress={createBoard} hitSlop={10}>
                    {busyId === "__new__" ? (
                      <ActivityIndicator size="small" color={colors.brand} />
                    ) : (
                      <Feather name="check" size={20} color={colors.brand} />
                    )}
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  onPress={() => setCreating(true)}
                  style={[styles.row, { borderColor: colors.divider }]}
                >
                  <Feather name="plus" size={20} color={colors.brand} />
                  <Text style={{ color: colors.brand, fontWeight: "700", fontSize: 14, marginLeft: 10 }}>
                    {t("boards.newFolder")}
                  </Text>
                </Pressable>
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 16, paddingBottom: 28, maxHeight: "82%" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 },
  title: { fontSize: 16, fontWeight: "800", flex: 1, textAlign: "center" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
