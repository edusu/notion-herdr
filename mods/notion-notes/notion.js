// Notion CLI calls and the upload decision, free of Herdr imports so the self-check can run
// them under plain node with a fake `ntn`.

// `ntn pages edit` strips a leading frontmatter block; an empty one keeps a note that
// starts with `---` from losing its first lines.
const PREFIX = "---\n---\n";

const firstLine = (s) => String(s ?? "").trim().split("\n")[0];

/** The `ntn` the mod and bin/notion-note-append run when mod.json names none. */
export const DEFAULT_NTN = "ntn";

// Page ids end up in file names and API paths, so only Notion's own id shape is accepted.
export const validId = (id) =>
  typeof id === "string" && /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(id);

/** A page id in Notion's own lower-case, dashed form, or null. */
export const canonicalId = (id) => {
  const hex = validId(id) ? id.replace(/-/g, "").toLowerCase() : null;
  return hex && `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const plain = (rich) => (rich ?? []).map((t) => t.plain_text).join("") || "Untitled";

/** The plain title of a page object from any `ntn` JSON output. */
export function titleOf(page) {
  return plain(Object.values(page?.properties ?? {}).find((p) => p.type === "title")?.title);
}

/**
 * Picker rows from a search or data-source query: title, last edit, the parent's name when the
 * parent is in the same response (Notion returns only its id) or is the workspace, and the
 * parent's ids so a later lookup of data-source names can fill the name in.
 */
export function pages(list) {
  const results = list.results ?? [];
  const names = new Map(results.map((p) => [p.id, titleOf(p)]));
  return results.map((p) => {
    const par = p.parent ?? {};
    const parentIds = [par[par.type], par.database_id].filter((id) => typeof id === "string");
    const parent = par.type === "workspace" ? "Workspace" : parentIds.map((id) => names.get(id)).find(Boolean) ?? null;
    return { id: p.id, title: titleOf(p), edited: p.last_edited_time ?? null, parent, parentIds };
  });
}

/** Data-source and database id → name, from a search filtered to data sources. */
export function sourceNames(list) {
  const names = new Map();
  for (const s of list.results ?? []) {
    const name = plain(s.title);
    names.set(s.id, name);
    if (s.parent?.database_id) names.set(s.parent.database_id, name);
  }
  return names;
}

/**
 * The address that opens page `id`: the desktop app's notion:// form when `app`, else the
 * page's own https URL if it is on a Notion domain (it comes from a response), else one
 * built from the id.
 */
export function pageUrl(id, url, app) {
  if (!validId(id)) return null;
  const bare = id.replace(/-/g, "");
  if (app) return `notion://www.notion.so/${bare}`;
  const own = /^https:\/\/([a-z0-9-]+\.)*notion\.(so|site|com)\/[^\s]*$/i.test(url ?? "");
  return own ? url : `https://www.notion.so/${bare}`;
}

/** The note's `- [ ]` / `- [x]` lines outside fenced code: `{ line, done, label, depth }`. */
export function todos(text) {
  const out = [];
  let fence = false;
  text.split("\n").forEach((l, line) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && /^(\s*)[-*+] \[([ xX])\] (.*)$/.exec(l);
    if (m) out.push({ line, done: m[2] !== " ", label: m[3], depth: m[1].replace(/\t/g, "  ").length >> 1 });
  });
  return out;
}

/** Flips the to-do at `line`, or returns null if that line is no longer the to-do `label`. */
export function toggleTodo(text, line, label) {
  const t = todos(text).find((x) => x.line === line);
  if (!t || t.label !== label) return null;
  const lines = text.split("\n");
  lines[line] = lines[line].replace(/\[[ xX]\]/, t.done ? "[ ]" : "[x]");
  return lines.join("\n");
}

/**
 * The page mapped to `folder` or its nearest parent in map.json (`home` maps as "~", as the
 * mod writes a space without a folder). Remote spaces' keys never match a local folder.
 */
export function mappedPage(map, folder, home) {
  for (let dir = folder.replace(/\/+$/, "") || "/"; ; dir = dir.slice(0, dir.lastIndexOf("/")) || "/") {
    const id = map[dir] ?? (dir === home ? map["~"] : undefined);
    if (id) return id;
    if (dir === "/") return null;
  }
}

/** A short age for a picker row: "5m", "3h", "2d", then the date. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const m = Math.max(0, Math.floor((now - t) / 60000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : m < 10080 ? `${Math.floor(m / 1440)}d` : iso.slice(0, 10);
}

/**
 * An `ntn` client over an `exec(cmd, args, opts) -> {code, stdout, stderr}` function.
 * Every failure becomes an Error with one readable line.
 */
export function client(exec, ntn) {
  const run = async (cmd, args) => {
    let r;
    try {
      r = await exec(cmd, args, { timeout: 60000 });
    } catch (e) {
      throw new Error(`Cannot run ${ntn}: ${firstLine(e?.message ?? e)}`);
    }
    if (r.code !== 0) throw new Error(firstLine(r.stderr) || `${ntn} exited with ${r.code}`);
    return r.stdout;
  };
  const json = async (args) => {
    const out = await run(ntn, args);
    try { return JSON.parse(out); } catch { throw new Error(`Unexpected output from ${ntn}: ${firstLine(out)}`); }
  };
  return {
    async get(id) {
      const d = await json(["pages", "get", id, "--json"]);
      const m = d.markdown;
      return { id: d.page.id, title: titleOf(d.page), url: d.page.url ?? null, markdown: m.markdown, partial: Boolean(m.truncated || m.unknown_block_ids?.length) };
    },
    list: async (source) => pages(await json(["datasources", "query", source, "--limit", "50", "--json"])),
    search: async (query) =>
      pages(await json(["api", "v1/search", "-d", JSON.stringify({
        query,
        filter: { property: "object", value: "page" },
        sort: { timestamp: "last_edited_time", direction: "descending" },
        page_size: 50,
      })])),
    // Pages through every data source the integration sees (at most 10 requests of 100).
    async sources() {
      const results = [];
      let cursor;
      for (let i = 0; i < 10; i++) {
        const body = { filter: { property: "object", value: "data_source" }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
        const list = await json(["api", "v1/search", "-d", JSON.stringify(body)]);
        results.push(...(list.results ?? []));
        if (!list.has_more || !(cursor = list.next_cursor)) break;
      }
      return sourceNames({ results });
    },
    async create(title, parent) {
      // JSON strings are valid YAML, so any title survives the frontmatter.
      const args = ["pages", "create", "--json", "--content", `---\ntitle: ${JSON.stringify(title)}\n---\n`];
      if (parent) args.push("--parent", parent);
      const p = await json(args);
      return { id: p.id, title: titleOf(p) };
    },
    // exec has no stdin: the shell redirects the file, and ids only travel as positional args.
    // Appends at the end of the page without rewriting it (insert_content, deprecated but the
    // markdown endpoint's only append); the JSON body travels as one argument.
    append: (id, markdown) => json(["api", `v1/pages/${id}/markdown`, "-X", "PATCH", "-d",
      JSON.stringify({ type: "insert_content", insert_content: { content: markdown, position: { type: "end" } } })]),
    // Never pass --allow-deleting-content: child pages and databases must survive an edit.
    edit: (id, file) => run("sh", ["-c", '"$1" pages edit "$2" < "$3"', "sh", ntn, id, file]),
  };
}

/**
 * Uploads `text` unless Notion's markdown moved away from `base`, the markdown of the last
 * read or upload. Notion's last_edited_time is rounded to the minute, so content is compared.
 * Returns `{ conflict: remotePage }` or `{ base }`: the page's markdown after the edit.
 */
export async function upload(api, id, text, base, file, write, force = false) {
  const remote = await api.get(id);
  if (remote.partial) throw new Error("Notion returned partial markdown; not uploading");
  if (!force && remote.markdown !== base) return { conflict: remote };
  await write(file, PREFIX + text);
  await api.edit(id, file);
  return { base: (await api.get(id)).markdown };
}

/**
 * What a refresh does with the page it read: "drop" if the person typed after the read
 * started, "same" when Notion still has `base`, else "apply" (replace the text and base).
 * A refresh never starts while local edits wait for upload.
 */
export function refreshDecision({ typed, remote, base }) {
  if (typed) return "drop";
  return remote === base ? "same" : "apply";
}

/** Runs async jobs one after another; a failed job rejects for its caller only. */
export function serial() {
  let last = Promise.resolve();
  return (job) => {
    const p = last.then(job);
    last = p.catch(() => {});
    return p;
  };
}
