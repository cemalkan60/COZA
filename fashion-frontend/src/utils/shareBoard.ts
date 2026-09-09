import { Platform, Share } from "react-native";

import { SavedPhoto } from "@/src/api/client";
import { fashionImageUri } from "@/src/utils/fashionImage";

// Turn a board into something the user can send to someone.
//
// Web: draw the photos into a grid on an offscreen <canvas> and hand the
// PNG to the Web Share API (or download it if sharing files isn't
// supported). R2 has CORS, so crossOrigin="anonymous" lets the canvas stay
// un-tainted. Native: no view-shot dependency yet, so share the board as a
// text list of photo links via the built-in Share sheet.
export async function shareBoard(boardName: string, photos: SavedPhoto[]): Promise<void> {
  const usable = photos.filter((p) => p.image || p.image_thumb);
  if (usable.length === 0) return;

  if (Platform.OS !== "web") {
    const lines = usable.slice(0, 40).map((p) => p.url || p.image).filter(Boolean);
    await Share.share({ message: `${boardName} · COZA\n${lines.join("\n")}` });
    return;
  }

  const cols = usable.length <= 4 ? 2 : usable.length <= 9 ? 3 : 4;
  const rows = Math.ceil(Math.min(usable.length, cols * 12) / cols);
  const cell = 360;
  const pad = 16;
  const headerH = 96;
  const canvas = document.createElement("canvas");
  canvas.width = cols * cell + pad * (cols + 1);
  canvas.height = headerH + rows * cell + pad * (rows + 1);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 34px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText(boardName, pad + 4, 46);
  ctx.fillStyle = "#8a8a8a";
  ctx.font = "500 20px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillText(`COZA · ${usable.length}`, pad + 4, 76);

  const loadImg = (src: string) =>
    new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });

  const slice = usable.slice(0, rows * cols);
  await Promise.all(
    slice.map(async (p, i) => {
      const img = await loadImg(fashionImageUri(p.image_thumb || p.image));
      const cx = pad + (i % cols) * (cell + pad);
      const cy = headerH + pad + Math.floor(i / cols) * (cell + pad);
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(cx, cy, cell, cell);
      if (!img) return;
      const r = Math.max(cell / img.width, cell / img.height);
      const w = img.width * r;
      const h = img.height * r;
      ctx.drawImage(img, cx + (cell - w) / 2, cy + (cell - h) / 2, w, h);
    }),
  );

  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png", 0.92));
  if (!blob) return;
  const file = new File([blob], `coza-${boardName.replace(/\s+/g, "-").toLowerCase()}.png`, { type: "image/png" });

  const nav = navigator as any;
  if (nav.canShare && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: boardName });
      return;
    } catch {
      /* user cancelled or share failed — fall through to download */
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
