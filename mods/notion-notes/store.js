// Files under ~/.config/herdr-app/notion-notes/ (never inside the mod folder: a save there
// reloads the mod) and the mod's settings.
import { spaces, home, appHome, readTextFile, writeTextFile, setShared } from "herdr";
import { DEFAULT_NTN, mappedPage } from "./notion.js";
import * as fs from "fs/promises";

export const NAME = "notion-notes";
/** Quick tab switching reuses the local copy and cached tables instead of starting `ntn` each time. */
export const REFRESH_EVERY = 15000;
/** Shared key the picker bumps after it changes map.json. */
export const MAP_REV = "notion-notes.map";
const DEFAULTS = { parents: [], datasource: "", ntn: DEFAULT_NTN };

export const dir = () => `${appHome()}/notion-notes`;
export const mapPath = () => `${dir()}/map.json`;
export const cachePath = (id) => `${dir()}/${id}.md`;
export const metaPath = (id) => `${dir()}/${id}.json`;
export const uploadPath = (id) => `${dir()}/${id}.upload.md`;

export { validId } from "./notion.js";

/** The active space's map.json key: its folder, prefixed by its machine when remote. */
export const spaceKey = () => {
  const s = spaces().find((x) => x.active);
  return s ? `${s.machine ? `${s.machine}:` : ""}${s.folder || "~"}` : null;
};

/**
 * The page mapped to the active space: its own key, else, for a local space, the nearest
 * mapped parent folder (as bin/notion-note-append resolves a folder).
 */
export const spacePage = (map) => {
  const s = spaces().find((x) => x.active);
  if (!s) return null;
  return map[spaceKey()] ?? (s.machine ? null : mappedPage(map, s.folder || home(), home()));
};

export async function readJson(path) {
  const text = await readTextFile(path);
  return text ? JSON.parse(text) : null;
}

// writeTextFile replaces atomically; passing what is on disk now makes it a plain overwrite.
/** Maps the active space to `id` and tells every copy to read the map again. */
export async function mapSpace(id) {
  const map = (await readJson(mapPath())) ?? {};
  map[spaceKey()] = id;
  await put(mapPath(), JSON.stringify(map, null, 2));
  setShared(MAP_REV, Date.now());
}

// Callers serialize writes per copy, and readTextFile's 1 MiB cap is why notes have a size limit.
export async function put(path, text) {
  await writeTextFile(path, text, await readTextFile(path));
}

/** The mod's settings; also creates the data folder once, before anything is written. */
export async function loadSettings() {
  await fs.mkdir(dir(), { recursive: true });
  const raw = await readTextFile(`${appHome()}/mods/${NAME}/mod.json`);
  return { ...DEFAULTS, ...(JSON.parse(raw ?? "{}").settings ?? {}) };
}
