import React, { useCallback, useEffect, useMemo, useState } from "react";
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
import * as Haptics from "expo-haptics";

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

  // A2: multi-select (bulk move/delete) — long-press a photo to enter it.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [movePickerOpen, setMovePickerOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const photoKey = (p: SavedPhoto) => `${p.source_id}#${p.photo_index}`;
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };
  const toggleSelected = (p: SavedPhoto) => {
    const k = photoKey(p);
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      if (next.size === 0) setSelectMode(false);
      return next;
    });
  };
  const bulkDelete = async () => {
    const targets = photos.filter((p) => selected.has(photoKey(p)));
    if (!targets.length) return;
    setBulkBusy(true);
    try {
      await Promise.all(targets.map((p) => api.unsavePhoto(p.board_id, p.source_id, p.photo_index)));
      setPhotos((cur) => cur.filter((p) => !selected.has(photoKey(p))));
    } finally {
      setBulkBusy(false);
      exitSelectMode();
    }
  };
  const bulkMove = async (targetBoardId: string) => {
    const targets = photos.filter((p) => selected.has(photoKey(p)));
    if (!targets.length) return;
    setBulkBusy(true);
    try {
      await Promise.all(
        targets.map(async (p) => {
          await api.savePhoto(targetBoardId, {
            source_id: p.source_id,
            photo_index: p.photo_index,
            image: p.image,
            image_thumb: p.image_thumb,
            brand_tr: p.brand_tr,
            season: p.season,
            season_label: p.season_label,
            url: p.url,
          });
          await api.unsavePhoto(p.board_id, p.source_id, p.photo_index);
        }),
      );
      setPhotos((cur) => cur.filter((p) => !selected.has(photoKey(p))));
    } finally {
      setBulkBusy(false);
      setMovePickerOpen(false);
      exitSelectMode();
    }
  };

  // A9: Zen mode — fullscreen auto-advancing slideshow of this board.
  const [zenOn, setZenOn] = useState(false);
  const [zenIndex, setZenIndex] = useState(0);
  useEffect(() => {
    if (!zenOn || photos.length === 0) return;
    const id = setInterval(() => setZenIndex((i) => (i + 1) % photos.length), 4000);
    return () => clearInterval(id);
  }, [zenOn, photos.length]);

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
        {selectMode ? (
          <>
            <Pressable testID="boards-select-cancel" onPress={exitSelectMode} hitSlop={10} disabled={bulkBusy}>
              <Feather name="x" size={24} color={colors.onSurface} />
            </Pressable>
            <Text style={[styles.title, { color: colors.onSurface }]}>
              {t("boards.selectedCount", { count: selected.size })}
            </Text>
            {bulkBusy ? (
              <ActivityIndicator color={colors.brand} size="small" />
            ) : (
              <View style={{ flexDirection: "row", gap: 18 }}>
                <Pressable testID="boards-bulk-move" onPress={() => setMovePickerOpen(true)} hitSlop={10}>
                  <Feather name="folder-plus" size={22} color={colors.onSurface} />
                </Pressable>
                <Pressable testID="boards-bulk-delete" onPress={bulkDelete} hitSlop={10}>
                  <Feather name="trash-2" size={22} color={colors.error} />
                </Pressable>
              </View>
            )}
          </>
        ) : (
          <>
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
          </>
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
              {photos.map((p) => {
                const isSelected = selected.has(photoKey(p));
                return (
                  <Pressable
                    key={photoKey(p)}
                    testID={`board-photo-${photoKey(p)}`}
                    onPress={() => (selectMode ? toggleSelected(p) : setViewer(p))}
                    onLongPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      setSelectMode(true);
                      toggleSelected(p);
                    }}
                    style={{ width: cardW }}
                  >
                    <View
                      style={[
                        styles.photo,
                        { backgroundColor: colors.surfaceTertiary, borderColor: isSelected ? colors.brand : colors.border },
                        isSelected && { borderWidth: 2 },
                      ]}
                    >
                      <Image
                        source={{ uri: fashionImageUri(p.image_thumb || p.image) }}
                        style={{ width: "100%", height: "100%" }}
                        contentFit="cover"
                        transition={200}
                      />
                      {selectMode && (
                        <View style={[styles.selectDot, { backgroundColor: isSelected ? colors.brand : "rgba(0,0,0,0.35)", borderColor: "#fff" }]}>
                          {isSelected && <Feather name="check" size={13} color={colors.onBrand} />}
                        </View>
                      )}
                    </View>
                    <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 12, fontWeight: "700", marginTop: 4 }}>
                      {p.brand_tr || "—"}
                      {p.season ? (
                        <Text style={{ color: colors.brandSecondary, fontWeight: "600" }}> · {formatSeason(p.season, p.season_label)}</Text>
                      ) : null}
                    </Text>
                  </Pressable>
                );
              })}
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
                testID="boards-zen"
                style={styles.menuItem}
                onPress={() => {
                  setMenuOpen(false);
                  setZenIndex(0);
                  setZenOn(true);
                }}
              >
                <Feather name="sun" size={16} color={colors.onSurface} />
                <Text style={{ color: colors.onSurface, fontWeight: "600", marginLeft: 10 }}>{t("boards.zenMode")}</Text>
              </Pressable>
            )}
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
            <Pressable style={{ alignItems: "center" }} onPress={() => setViewer(null)}>
              <ZoomableImage
                uri={fashionImageUri(viewer.image)}
                width={width * 0.92}
                height={height * 0.72}
                contentFit="contain"
                onTap={() => setViewer(null)}
              />
            </Pressable>
          )}
        </View>
      </Modal>

      {/* A2: bulk-move target picker */}
      <Modal visible={movePickerOpen} transparent animationType="fade" onRequestClose={() => setMovePickerOpen(false)}>
        <Pressable style={styles.menuOverlay} onPress={() => setMovePickerOpen(false)}>
          <View style={[styles.menu, { backgroundColor: colors.surface, borderColor: colors.border, maxHeight: 420 }]}>
            <Text style={{ color: colors.brandSecondary, fontSize: 12, fontWeight: "700", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6 }}>
              {t("boards.pickBoard")}
            </Text>
            <ScrollView>
              {boards
                .filter((b) => b.id !== boardId)
                .map((b) => (
                  <Pressable key={b.id} style={styles.menuItem} onPress={() => bulkMove(b.id)} disabled={bulkBusy}>
                    <Feather name="folder" size={16} color={colors.onSurface} />
                    <Text style={{ color: colors.onSurface, fontWeight: "600", marginLeft: 10 }}>{b.name}</Text>
                  </Pressable>
                ))}
              {boards.filter((b) => b.id !== boardId).length === 0 && (
                <Text style={{ color: colors.brandSecondary, paddingHorizontal: 16, paddingVertical: 14, fontSize: 13 }}>
                  {t("boards.noOtherBoards")}
                </Text>
              )}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>

      {/* A9: Zen mode — fullscreen auto-advancing slideshow */}
      <Modal visible={zenOn} transparent animationType="fade" onRequestClose={() => setZenOn(false)}>
        <Pressable style={styles.viewerOverlay} onPress={() => setZenOn(false)}>
          {photos[zenIndex] && (
            <Image
              source={{ uri: fashionImageUri(photos[zenIndex].image) }}
              style={{ width, height: height * 0.86 }}
              contentFit="contain"
              transition={700}
            />
          )}
          {photos[zenIndex] && (photos[zenIndex].brand_tr || photos[zenIndex].season) && (
            <Text style={styles.zenCaption}>
              {[photos[zenIndex].brand_tr, photos[zenIndex].season ? formatSeason(photos[zenIndex].season, photos[zenIndex].season_label) : ""]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          )}
        </Pressable>
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
  selectDot: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 999,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  zenCaption: {
    position: "absolute",
    bottom: 40,
    alignSelf: "center",
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
    backgroundColor: "rgba(255,255,255,0.15)",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
  },
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
