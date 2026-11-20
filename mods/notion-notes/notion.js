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

/** Rich text as plain text. */
export const plainText = (rich) => (rich ?? []).map((t) => t.plain_text).join("");
const plain = (rich) => plainText(rich) || "Untitled";

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

/**
 * Fallback for blocks the read view does not draw itself (callouts, toggles, columns...): Notion's
 * tags for empty lines, child pages and databases inside them become plain markdown, each child on
 * its own paragraph as Notion shows it. Display only: uploads keep the tags so children are not deleted.
 */
export function readable(text) {
  return text
    .replace(/^[ \t]*<empty-block\/>[ \t]*$/gm, "")
    .replace(/<page\s(?:[^>]*\s)?url="([^"]*)"[^>]*>([\s\S]*?)<\/page>/g, "📄 [$2]($1)\n")
    .replace(/<database\s(?:[^>]*\s)?url="([^"]*)"[^>]*>([\s\S]*?)<\/database>/g, "🗃️ [$2]($1)\n");
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

const MAX_TEXT = 2000;

/**
 * The API value of one database property for a plain JS `value`, or a readable Error: Notion's
 * own type errors start with a line that says nothing, and it creates unknown select options.
 */
export function propertyValue({ name, type, options }, value) {
  const bad = (what) => new Error(`${name}: ${what}`);
  const text = () => {
    if (typeof value !== "string") throw bad("expected text");
    if (value.length > MAX_TEXT) throw bad(`text is longer than ${MAX_TEXT} characters`);
    return value;
  };
  switch (type) {
    case "checkbox":
      if (typeof value !== "boolean") throw bad("expected true or false");
      return { checkbox: value };
    case "number": {
      const s = typeof value === "string" ? value.trim() : value;
      const n = s === null || s === "" ? null : typeof s === "string" || typeof s === "number" ? Number(s) : NaN;
      if (n !== null && !Number.isFinite(n)) throw bad(`"${value}" is not a number`);
      return { number: n };
    }
    case "select":
    case "status":
      if (value === null && type === "select") return { select: null };
      // A status cannot be cleared: Notion resets it to the default option instead.
      if (value === null) throw bad("a status cannot be empty");
      if (!options?.some((o) => o.name === value)) throw bad(`"${value}" is not one of its options`);
      return { [type]: { name: value } };
    case "title":
    case "rich_text":
      // `[]` is the empty value; a segment with empty content would stay as an empty text element.
      return { [type]: text() ? [{ text: { content: value } }] : [] };
    case "url":
    case "email":
    case "phone_number":
      return { [type]: text() || null };
    default:
      throw bad(`${type} properties are not editable`);
  }
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
    // Schema and first 50 rows. The API does not expose a view's column order, so the title
    // column comes first and the rest follow the schema's own order.
    async source(id) {
      if (!validId(id)) throw new Error(`Invalid data source id: ${firstLine(id)}`);
      const [schema, q] = await Promise.all([json(["api", `v1/data_sources/${id}`]), json(["datasources", "query", id, "--limit", "50", "--json"])]);
      const columns = Object.entries(schema.properties ?? {}).map(([name, p]) => ({
        name, type: p.type,
        ...(p.type === "select" || p.type === "status" ? { options: (p[p.type]?.options ?? []).map((o) => ({ name: o.name, color: o.color })) } : {}),
      }));
      columns.sort((a, b) => (b.type === "title") - (a.type === "title"));
      const rows = (q.results ?? []).map((r) => ({ id: r.id, url: r.url ?? null, properties: r.properties ?? {} }));
      return { columns, rows, more: Boolean(q.has_more) };
    },
    // `column` is an entry of `source(...).columns`; the value is checked before ntn runs.
    async setProperty(pageId, column, value) {
      if (!validId(pageId)) throw new Error(`Invalid page id: ${firstLine(pageId)}`);
      const properties = { [column.name]: propertyValue(column, value) };
      await run(ntn, ["api", `v1/pages/${pageId}`, "-X", "PATCH", "-d", JSON.stringify({ properties })]);
    },
    async addRow(sourceId, titleColumn, title) {
      if (!validId(sourceId)) throw new Error(`Invalid data source id: ${firstLine(sourceId)}`);
      const properties = { [titleColumn]: propertyValue({ name: titleColumn, type: "title" }, title) };
      const p = await json(["api", "v1/pages", "-d", JSON.stringify({ parent: { type: "data_source_id", data_source_id: sourceId }, properties })]);
      return { id: p.id, url: p.url ?? null };
    },
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
      // JSON strings are valid YAML, so any title survives the frontmatter. The value is joined
      // with `=`: as a separate argument, ntn takes its leading `---` for an unknown flag.
      const args = ["pages", "create", "--json", `--content=---\ntitle: ${JSON.stringify(title)}\n---\n`];
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
    // The page's markdown right after the edit, or null when the output does not carry it whole.
    async edit(id, file) {
      const out = await run("sh", ["-c", '"$1" pages edit "$2" --json < "$3"', "sh", ntn, id, file]);
      try {
        const m = JSON.parse(out);
        return typeof m.markdown === "string" && !m.truncated && !m.unknown_block_ids?.length ? m.markdown : null;
      } catch { return null; }
    },
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
  // `ntn pages edit` rejects empty markdown; this is how Notion itself writes an empty page.
  await write(file, PREFIX + (text.trim() ? text : "<empty-block/>"));
  // A separate read after the edit could take in an edit from elsewhere as base, which the next upload would then delete.
  const after = await api.edit(id, file);
  return { base: after ?? (await api.get(id)).markdown };
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
