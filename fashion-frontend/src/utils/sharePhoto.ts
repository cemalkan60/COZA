import { Platform, Share } from "react-native";

import { fashionImageUri } from "@/src/utils/fashionImage";

export type SharePhotoInput = {
  image: string;
  brand_tr?: string;
  season?: string;
  season_label?: string;
  url?: string;
};

// F3/F4: share ONE photo, with an optional "COZA · brand · season"
// watermark bar drawn across the bottom. Same web/native split as
// shareBoard.ts (no view-shot dependency on native yet, so native falls
// back to sharing the photo's link).
export async function sharePhoto(photo: SharePhotoInput, watermark: boolean): Promise<void> {
  const caption = [photo.brand_tr, photo.season_label || photo.season].filter(Boolean).join(" · ");

  if (Platform.OS !== "web") {
    await Share.share({ message: [caption, photo.url || photo.image].filter(Boolean).join("\n") });
    return;
  }

  const src = fashionImageUri(photo.image);
  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const el = new Image();
    el.crossOrigin = "anonymous";
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = src;
  });
  if (!img) return;

  const canvas = document.createElement("canvas");
  const barH = watermark && caption ? Math.round(img.height * 0.09) : 0;
  canvas.width = img.width;
  canvas.height = img.height + barH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);

  if (barH) {
    const fontSize = Math.max(14, Math.round(barH * 0.4));
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${fontSize}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText(`COZA · ${caption}`, Math.round(img.width * 0.03), img.height + barH / 2);
  }

  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob) return;
  const filename = `coza-${(photo.brand_tr || "photo").replace(/\s+/g, "-").toLowerCase()}.jpg`;
  const file = new File([blob], filename, { type: "image/jpeg" });

  const nav = navigator as any;
  if (nav.canShare && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: caption || "COZA" });
      return;
    } catch {
      /* user cancelled or share failed — fall through to download */
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
