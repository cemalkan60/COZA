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

// D6: "Çevrimdışı — son bakılan koleksiyonlar önbellekte". A small LRU of
// the last N *distinct* collections opened, separate from the single
// "resume" entry above (A6). This is deliberately metadata-only (brand/
// season/thumb URL, not the photos themselves) — RetryImage forces
// cachePolicy="none" on native to work around a real Android bot-block bug
// (see its own comment), so we can't also lean on expo-image's disk cache
// for true offline images there; showing the text/thumb entry still works
// once the device is back online enough to load just the tiny thumbnail,
// and on web the browser's own HTTP cache often still serves it.
const RECENT_KEY = "coza.recentCollections";
const RECENT_MAX = 15;

export async function pushRecentCollection(item: LastCollection): Promise<void> {
  if (!item.source_id) return;
  const cur = await getRecentCollections();
  const next = [item, ...cur.filter((c) => c.source_id !== item.source_id)].slice(0, RECENT_MAX);
  await storage.setItem(RECENT_KEY, JSON.stringify(next));
}

export async function getRecentCollections(): Promise<LastCollection[]> {
  const raw = await storage.getItem<string>(RECENT_KEY, "");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c) => c && c.source_id) : [];
  } catch {
    return [];
  }
}
