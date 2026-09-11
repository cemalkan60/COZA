import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
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

import { api, Board, BoardComment, SavedPhoto } from "@/src/api/client";
import { useTheme } from "@/src/theme/ThemeContext";
import { useT } from "@/src/i18n";
import { fashionImageUri } from "@/src/utils/fashionImage";
import { goBack } from "@/src/utils/nav";
import { shareBoard } from "@/src/utils/shareBoard";
import { sharePhoto } from "@/src/utils/sharePhoto";
import { useWatermarkPref } from "@/src/hooks/useWatermarkPref";
import { ZoomableImage } from "@/src/components/ZoomableImage";
import { useAuth } from "@/src/context/AuthContext";

export default function Boards() {
  const { colors, spacing } = useTheme();
  const { t, formatSeason, lang } = useT();
  const { user } = useAuth();
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
  const { watermark } = useWatermarkPref();

  // A1: personal note on a saved photo (the user's own, not the AI's tags).
  const [noteEditing, setNoteEditing] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const openViewer = (p: SavedPhoto) => {
    setViewer(p);
    setNoteDraft(p.note || "");
    setNoteEditing(false);
  };
  const saveNote = async () => {
    if (!viewer) return;
    setNoteSaving(true);
    try {
      await api.updateSavedPhotoNote(viewer.board_id, viewer.source_id, viewer.photo_index, { note: noteDraft.trim() });
      const withNote = { ...viewer, note: noteDraft.trim() };
      setViewer(withNote);
      setPhotos((cur) => cur.map((p) => (photoKey(p) === photoKey(viewer) ? withNote : p)));
      setNoteEditing(false);
    } catch {
      // ignore — user can retry
    } finally {
      setNoteSaving(false);
    }
  };

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
  // A3: archived boards are hidden by default (not deleted — just tucked
  // away), with a toggle to bring them back into view.
  const [showArchived, setShowArchived] = useState(false);
  const subFoldersAll = useMemo(
    () => boards.filter((b) => (b.parent_id ?? null) === (boardId || null)),
    [boards, boardId],
  );
  const subFolders = useMemo(
    () => subFoldersAll.filter((b) => showArchived || !b.archived),
    [subFoldersAll, showArchived],
  );
  const archivedCount = useMemo(() => subFoldersAll.filter((b) => b.archived).length, [subFoldersAll]);

  // A8: "akıllı pano" — refresh once per visit to a smart board, not on
  // every focus tick (a board's own smart_filter never changes on its own).
  const [smartAddedMsg, setSmartAddedMsg] = useState("");
  const smartRefreshedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!current?.smart_filter || smartRefreshedRef.current === current.id) return;
    smartRefreshedRef.current = current.id;
    api
      .boardSmartRefresh(current.id)
      .then((r) => {
        if (r.added > 0) {
          setSmartAddedMsg(t("boards.smartAdded", { count: r.added }));
          api.boardPhotos(current.id).then((ph) => setPhotos(ph.items || []));
          setTimeout(() => setSmartAddedMsg(""), 4000);
        }
      })
      .catch(() => {});
  }, [current]);

  // E1: team invite picker. Owner-only — a shared board hides this
  // (current?.is_owner === false), matching the backend (_board_or_404
  // still gates invite/uninvite to the owner).
  const [inviteOpen, setInviteOpen] = useState(false);
  const [team, setTeam] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api.fashionTeam().then((r) => setTeam(r.items || [])).catch(() => {});
  }, []);
  const toggleInvite = async (userId: string) => {
    if (!current) return;
    const invited = (current.shared_with || []).includes(userId);
    try {
      if (invited) await api.boardUninvite(current.id, userId);
      else await api.boardInvite(current.id, userId);
      setBoards((cur) =>
        cur.map((b) =>
          b.id === current.id
            ? { ...b, shared_with: invited ? (b.shared_with || []).filter((id) => id !== userId) : [...(b.shared_with || []), userId] }
            : b,
        ),
      );
    } catch {}
  };

  // E2/E3: board-level comments (+ @mentions, parsed server-side).
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [comments, setComments] = useState<BoardComment[]>([]);
  const [commentDraft, setCommentDraft] = useState("");
  const [postingComment, setPostingComment] = useState(false);
  const openComments = async () => {
    if (!current) return;
    setCommentsOpen(true);
    try {
      const res = await api.boardComments(current.id);
      setComments(res.items || []);
    } catch {
      setComments([]);
    }
  };
  const postComment = async () => {
    const text = commentDraft.trim();
    if (!current || !text || postingComment) return;
    setPostingComment(true);
    try {
      const c = await api.addComment(current.id, text);
      setComments((cur) => [...cur, c]);
      setCommentDraft("");
    } catch {
    } finally {
      setPostingComment(false);
    }
  };

  // E4: reactions on the photo currently open in the viewer.
  const [reactions, setReactions] = useState<{ source_id: string; photo_index: number; user_id: string; emoji: string }[]>([]);
  useEffect(() => {
    if (!current) return;
    api.boardReactions(current.id).then((r) => setReactions(r.items || [])).catch(() => {});
  }, [current?.id]);
  const reactionsFor = (p: SavedPhoto) => reactions.filter((r) => r.source_id === p.source_id && r.photo_index === p.photo_index);
  const myReaction = (p: SavedPhoto) => reactionsFor(p).find((r) => r.user_id === user?.id)?.emoji || null;
  const react = async (p: SavedPhoto, emoji: string) => {
    if (!current) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await api.toggleReaction(current.id, p.source_id, p.photo_index, emoji);
      const fresh = await api.boardReactions(current.id);
      setReactions(fresh.items || []);
    } catch {}
  };

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

  // A3: copy / archive.
  const [duplicating, setDuplicating] = useState(false);
  const doDuplicate = async () => {
    if (!current || duplicating) return;
    setDuplicating(true);
    try {
      const res = await api.boardDuplicate(current.id);
      router.push(`/fashion/boards?board=${encodeURIComponent(res.id)}`);
    } catch {
    } finally {
      setDuplicating(false);
    }
  };
  const doArchiveToggle = async () => {
    if (!current) return;
    try {
      await api.boardArchive(current.id, !current.archived);
      router.replace(current.parent_id ? `/fashion/boards?board=${encodeURIComponent(current.parent_id)}` : "/fashion/boards");
    } catch {}
  };

  // A7: "Board'u özetle" — cached on the board (see `current.summary`).
  const [summarizing, setSummarizing] = useState(false);
  const doSummarize = async () => {
    if (!current || summarizing) return;
    setSummarizing(true);
    try {
      const res = await api.boardSummarize(current.id, lang, !!current.summary);
      setBoards((cur) => cur.map((b) => (b.id === current.id ? { ...b, summary: res.summary, summary_lang: lang } : b)));
    } catch {
    } finally {
      setSummarizing(false);
    }
  };

  // F5: public, view-only link. Native has no Web Share API, so it opens
  // the OS share sheet instead of copying to clipboard (no clipboard
  // package installed) — sending the link straight to a chat app is the
  // more useful action there anyway.
  const [sharingLink, setSharingLink] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const publicBoardUrl = (token: string) => {
    const origin = Platform.OS === "web" && typeof window !== "undefined" ? window.location.origin : "https://coza-j6zg.vercel.app";
    return `${origin}/fashion/public/${token}`;
  };
  const doShareLink = async () => {
    if (!current || sharingLink) return;
    setSharingLink(true);
    try {
      const token = current.share_token && current.public ? current.share_token : (await api.boardShare(current.id)).token;
      setBoards((cur) => cur.map((b) => (b.id === current.id ? { ...b, public: true, share_token: token } : b)));
      const url = publicBoardUrl(token);
      if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 2000);
      } else {
        await Share.share({ message: url });
      }
    } catch {
    } finally {
      setSharingLink(false);
    }
  };
  const doUnshareLink = async () => {
    if (!current) return;
    try {
      await api.boardUnshare(current.id);
      setBoards((cur) => cur.map((b) => (b.id === current.id ? { ...b, public: false } : b)));
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
            <View style={{ flex: 1, alignItems: "center" }}>
              <Text numberOfLines={1} style={[styles.title, { color: colors.onSurface, flex: undefined }]}>
                {current ? current.name : t("boards.title")}
              </Text>
              {!!current?.shared && (
                <Text style={{ color: colors.brandSecondary, fontSize: 10, fontWeight: "700" }}>{t("boards.sharedWithYou")}</Text>
              )}
            </View>
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
          {!!current?.summary && (
            <View style={{ flexDirection: "row", gap: 8, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 12, marginBottom: 16 }}>
              <Feather name="cpu" size={14} color={colors.brand} style={{ marginTop: 1 }} />
              <Text style={{ flex: 1, color: colors.onSurface, fontSize: 13, lineHeight: 19 }}>{current.summary}</Text>
            </View>
          )}

          {!!current?.smart_filter && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12 }}>
              <Feather name="zap" size={12} color={colors.brand} />
              <Text style={{ color: colors.brandSecondary, fontSize: 11, fontWeight: "700" }}>
                {smartAddedMsg || t("boards.smartBoardLabel")}
              </Text>
            </View>
          )}

          {/* Sub-folders */}
          {archivedCount > 0 && (
            <Pressable testID="boards-toggle-archived" onPress={() => setShowArchived((v) => !v)} style={{ marginBottom: 10 }}>
              <Text style={{ color: colors.brandSecondary, fontSize: 12, fontWeight: "700" }}>
                {showArchived ? `▾ ${t("boards.archived")} (${archivedCount})` : `▸ ${t("boards.archived")} (${archivedCount})`}
              </Text>
            </Pressable>
          )}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap }}>
            {subFolders.map((b) => (
              <Pressable
                key={b.id}
                testID={`board-folder-${b.id}`}
                onPress={() => router.push(`/fashion/boards?board=${encodeURIComponent(b.id)}`)}
                style={{ width: cardW, opacity: b.archived ? 0.5 : 1 }}
              >
                <View style={[styles.folderCover, { backgroundColor: colors.surfaceTertiary, borderColor: colors.border }]}>
                  {b.cover ? (
                    <Image source={{ uri: fashionImageUri(b.cover) }} style={{ width: "100%", height: "100%" }} contentFit="cover" />
                  ) : (
                    <Feather name="folder" size={26} color={colors.brandSecondary} />
                  )}
                  {b.shared && (
                    <View style={styles.sharedDot}>
                      <Feather name="users" size={11} color="#fff" />
                    </View>
                  )}
                </View>
                <Text numberOfLines={1} style={{ color: colors.onSurface, fontWeight: "700", fontSize: 13, marginTop: 6 }}>
                  {b.name}
                </Text>
                <Text style={{ color: colors.brandSecondary, fontSize: 11 }}>
                  {b.archived ? t("boards.archived") : t("boards.itemCount", { count: b.photo_count ?? 0 })}
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
                    onPress={() => (selectMode ? toggleSelected(p) : openViewer(p))}
                    onLongPress={
                      current?.is_owner === false
                        ? undefined // A2 multi-select edits the photo list — view-only for a shared board
                        : () => {
                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                            setSelectMode(true);
                            toggleSelected(p);
                          }
                    }
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
            {photos.length > 0 && (
              <Pressable
                testID="boards-lookbook"
                style={styles.menuItem}
                onPress={() => {
                  setMenuOpen(false);
                  router.push(`/fashion/lookbook?board=${encodeURIComponent(boardId)}` as any);
                }}
              >
                <Feather name="book-open" size={16} color={colors.onSurface} />
                <Text style={{ color: colors.onSurface, fontWeight: "600", marginLeft: 10 }}>{t("boards.lookbook")}</Text>
              </Pressable>
            )}
            <Pressable
              testID="boards-comments"
              style={styles.menuItem}
              onPress={() => {
                setMenuOpen(false);
                openComments();
              }}
            >
              <Feather name="message-circle" size={16} color={colors.onSurface} />
              <Text style={{ color: colors.onSurface, fontWeight: "600", marginLeft: 10 }}>{t("boards.comments")}</Text>
            </Pressable>
            {current?.is_owner !== false && (
              <Pressable
                testID="boards-invite"
                style={styles.menuItem}
                onPress={() => {
                  setMenuOpen(false);
                  setInviteOpen(true);
                }}
              >
                <Feather name="user-plus" size={16} color={colors.onSurface} />
                <Text style={{ color: colors.onSurface, fontWeight: "600", marginLeft: 10 }}>{t("boards.invite")}</Text>
              </Pressable>
            )}
            {current?.is_owner !== false && photos.length > 0 && (
              <Pressable testID="boards-share-link" style={styles.menuItem} onPress={() => { setMenuOpen(false); doShareLink(); }} disabled={sharingLink}>
                <Feather name="link" size={16} color={colors.onSurface} />
                <Text style={{ color: colors.onSurface, fontWeight: "600", marginLeft: 10 }}>
                  {linkCopied ? t("boards.linkCopied") : t("boards.shareLink")}
                </Text>
              </Pressable>
            )}
            {current?.is_owner !== false && current?.public && (
              <Pressable testID="boards-unshare-link" style={styles.menuItem} onPress={() => { setMenuOpen(false); doUnshareLink(); }}>
                <Feather name="link-2" size={16} color={colors.error} />
                <Text style={{ color: colors.error, fontWeight: "600", marginLeft: 10 }}>{t("boards.stopSharingLink")}</Text>
              </Pressable>
            )}
            {current?.is_owner !== false && photos.length > 0 && (
              <Pressable
                testID="boards-summarize"
                style={styles.menuItem}
                onPress={() => {
                  setMenuOpen(false);
                  doSummarize();
                }}
                disabled={summarizing}
              >
                <Feather name="cpu" size={16} color={colors.onSurface} />
                <Text style={{ color: colors.onSurface, fontWeight: "600", marginLeft: 10 }}>
                  {summarizing ? t("boards.summarizing") : t("boards.summarize")}
                </Text>
              </Pressable>
            )}
            {current?.is_owner !== false && (
              <Pressable
                testID="boards-duplicate"
                style={styles.menuItem}
                onPress={() => {
                  setMenuOpen(false);
                  doDuplicate();
                }}
                disabled={duplicating}
              >
                <Feather name="copy" size={16} color={colors.onSurface} />
                <Text style={{ color: colors.onSurface, fontWeight: "600", marginLeft: 10 }}>{t("boards.duplicate")}</Text>
              </Pressable>
            )}
            {current?.is_owner !== false && (
              <Pressable
                testID="boards-archive"
                style={styles.menuItem}
                onPress={() => {
                  setMenuOpen(false);
                  doArchiveToggle();
                }}
              >
                <Feather name="archive" size={16} color={colors.onSurface} />
                <Text style={{ color: colors.onSurface, fontWeight: "600", marginLeft: 10 }}>
                  {current?.archived ? t("boards.unarchive") : t("boards.archive")}
                </Text>
              </Pressable>
            )}
            {current?.is_owner !== false && (
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
            )}
            {current?.is_owner !== false && (
              <Pressable style={styles.menuItem} onPress={() => { setMenuOpen(false); doDelete(); }}>
                <Feather name="trash-2" size={16} color={colors.error} />
                <Text style={{ color: colors.error, fontWeight: "600", marginLeft: 10 }}>{t("boards.delete")}</Text>
              </Pressable>
            )}
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
          {viewer && current?.is_owner !== false && (
            <Pressable style={[styles.viewerBtn, { top: insets.top + 12, left: 16 }]} onPress={() => removePhoto(viewer)} hitSlop={12}>
              <Feather name="trash-2" size={22} color="#fff" />
            </Pressable>
          )}
          {viewer && (
            <Pressable
              testID="board-viewer-share"
              style={[styles.viewerBtn, { top: insets.top + 12, left: 112 }]}
              onPress={() => sharePhoto(viewer, watermark)}
              hitSlop={12}
            >
              <Feather name="share" size={19} color="#fff" />
            </Pressable>
          )}
          {viewer && current?.is_owner !== false && (
            <Pressable
              testID="board-viewer-note"
              style={[styles.viewerBtn, { top: insets.top + 12, left: 64 }]}
              onPress={() => setNoteEditing((v) => !v)}
              hitSlop={12}
            >
              <Feather name="edit-3" size={20} color={viewer.note ? colors.brand : "#fff"} />
            </Pressable>
          )}
          {viewer && (
            <Pressable style={{ alignItems: "center" }} onPress={() => (noteEditing ? null : setViewer(null))}>
              <ZoomableImage
                uri={fashionImageUri(viewer.image)}
                width={width * 0.92}
                height={height * 0.62}
                contentFit="contain"
                onTap={() => setViewer(null)}
              />
              {!noteEditing && !!viewer.note && (
                <Pressable onPress={() => setNoteEditing(true)} style={{ maxWidth: width * 0.85, marginTop: 12 }}>
                  <Text style={{ color: "#fff", fontSize: 13, textAlign: "center", lineHeight: 18 }}>{viewer.note}</Text>
                </Pressable>
              )}
            </Pressable>
          )}
          {viewer && !noteEditing && (
            <View style={[styles.reactionRow, { bottom: insets.bottom + 16 }]}>
              {(["❤️", "🔥"] as const).map((emoji) => {
                const count = reactionsFor(viewer).filter((r) => r.emoji === emoji).length;
                const active = myReaction(viewer) === emoji;
                return (
                  <Pressable
                    key={emoji}
                    testID={`board-react-${emoji}`}
                    onPress={() => react(viewer, emoji)}
                    style={[styles.reactionBtn, { backgroundColor: active ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.1)" }]}
                  >
                    <Text style={{ fontSize: 16 }}>{emoji}</Text>
                    {count > 0 && <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700", marginLeft: 4 }}>{count}</Text>}
                  </Pressable>
                );
              })}
            </View>
          )}
          {viewer && noteEditing && (
            <View style={[styles.noteEditor, { bottom: insets.bottom + 16, backgroundColor: colors.surface, borderColor: colors.border }]}>
              <TextInput
                autoFocus
                multiline
                value={noteDraft}
                onChangeText={setNoteDraft}
                placeholder={t("boards.notePlaceholder")}
                placeholderTextColor={colors.brandSecondary}
                style={{ color: colors.onSurface, fontSize: 14, minHeight: 60, maxHeight: 120 }}
              />
              <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 18, marginTop: 10 }}>
                {noteSaving ? (
                  <ActivityIndicator color={colors.brand} size="small" />
                ) : (
                  <>
                    <Pressable onPress={() => setNoteEditing(false)}>
                      <Text style={{ color: colors.brandSecondary, fontWeight: "700" }}>{t("common.cancel")}</Text>
                    </Pressable>
                    <Pressable onPress={saveNote}>
                      <Text style={{ color: colors.brand, fontWeight: "700" }}>{t("common.save")}</Text>
                    </Pressable>
                  </>
                )}
              </View>
            </View>
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

      {/* E1: team invite picker */}
      <Modal visible={inviteOpen} transparent animationType="fade" onRequestClose={() => setInviteOpen(false)}>
        <Pressable style={styles.menuOverlay} onPress={() => setInviteOpen(false)}>
          <View style={[styles.menu, { backgroundColor: colors.surface, borderColor: colors.border, maxHeight: 420 }]}>
            <Text style={{ color: colors.brandSecondary, fontSize: 12, fontWeight: "700", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6 }}>
              {t("boards.inviteTitle")}
            </Text>
            <ScrollView>
              {team.map((member) => {
                const invited = (current?.shared_with || []).includes(member.id);
                return (
                  <Pressable key={member.id} style={styles.menuItem} onPress={() => toggleInvite(member.id)}>
                    <Feather name={invited ? "check-square" : "square"} size={16} color={invited ? colors.brand : colors.onSurface} />
                    <Text style={{ color: colors.onSurface, fontWeight: "600", marginLeft: 10 }}>{member.name}</Text>
                  </Pressable>
                );
              })}
              {team.length === 0 && (
                <Text style={{ color: colors.brandSecondary, paddingHorizontal: 16, paddingVertical: 14, fontSize: 13 }}>
                  {t("boards.noTeammates")}
                </Text>
              )}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>

      {/* E2/E3: board comments */}
      <Modal visible={commentsOpen} transparent animationType="fade" onRequestClose={() => setCommentsOpen(false)}>
        <View style={styles.menuOverlay}>
          <View style={[styles.commentsBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <Text style={{ color: colors.onSurface, fontWeight: "800", fontSize: 15 }}>{t("boards.comments")}</Text>
              <Pressable onPress={() => setCommentsOpen(false)} hitSlop={10}>
                <Feather name="x" size={20} color={colors.onSurface} />
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 320 }}>
              {comments.length === 0 && (
                <Text style={{ color: colors.brandSecondary, fontSize: 13, textAlign: "center", marginVertical: 20 }}>
                  {t("boards.noComments")}
                </Text>
              )}
              {comments.map((c) => (
                <View key={c.id} style={{ marginBottom: 12 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ color: colors.onSurface, fontWeight: "700", fontSize: 13 }}>{c.user_name}</Text>
                    {c.user_id === user?.id && (
                      <Pressable
                        onPress={async () => {
                          if (!current) return;
                          try {
                            await api.deleteComment(current.id, c.id);
                            setComments((cur) => cur.filter((x) => x.id !== c.id));
                          } catch {}
                        }}
                        hitSlop={8}
                      >
                        <Feather name="trash-2" size={13} color={colors.brandSecondary} />
                      </Pressable>
                    )}
                  </View>
                  <Text style={{ color: colors.onSurface, fontSize: 13, marginTop: 2, lineHeight: 18 }}>{c.text}</Text>
                </View>
              ))}
            </ScrollView>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 }}>
              <TextInput
                value={commentDraft}
                onChangeText={setCommentDraft}
                onSubmitEditing={postComment}
                placeholder={t("boards.commentPlaceholder")}
                placeholderTextColor={colors.brandSecondary}
                style={{ flex: 1, color: colors.onSurface, fontSize: 13 }}
              />
              {postingComment ? (
                <ActivityIndicator color={colors.brand} size="small" />
              ) : (
                <Pressable onPress={postComment} disabled={!commentDraft.trim()} hitSlop={8}>
                  <Feather name="send" size={18} color={commentDraft.trim() ? colors.brand : colors.brandSecondary} />
                </Pressable>
              )}
            </View>
          </View>
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
  commentsBox: { borderRadius: 12, borderWidth: 1, padding: 18, width: "88%", maxWidth: 420 },
  reactionRow: { position: "absolute", left: 0, right: 0, flexDirection: "row", justifyContent: "center", gap: 10 },
  reactionBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999 },
  sharedDot: {
    position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: 999,
    alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.5)",
  },
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
  noteEditor: {
    position: "absolute",
    left: 20,
    right: 20,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
  },
});
