import { storage } from "@/src/utils/storage";

// A6: "Kaldığın yerden devam" (resume last-opened collection). One shared
// key/shape so the writer (collection detail screen) and reader (Fashion
// tab's resume card) can't drift apart.
const KEY = "coza.lastCollection";

export type LastCollection = {
  source_id: string;
  title: string;
  season: string; // raw season code, formatted for display by the reader
  image: string; // thumbnail — cheap to show, doesn't need its own fetch
};

export async function saveLastCollection(item: LastCollection): Promise<void> {
  if (!item.source_id) return;
  await storage.setItem(KEY, JSON.stringify(item));
}

export async function getLastCollection(): Promise<LastCollection | null> {
  const raw = await storage.getItem<string>(KEY, "");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.source_id ? parsed : null;
  } catch {
    return null;
  }
}
