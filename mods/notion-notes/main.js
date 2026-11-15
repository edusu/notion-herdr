// A Notion page as an editable markdown note, through the Notion CLI (`ntn`).
// As a layout block it shows the note mapped to the active space; with props.page it is a
// pane; opened as an overlay (`mod.open`) it is the dialog that chooses or creates a note.
// The save chain is adapted from tab-notes in ozcberkay/herdr-coban (Apache-2.0).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { exec, theme, settings, props, run, shared, layout, readTextFile } from "herdr";
import { client, upload, serial, refreshDecision, pageUrl, validId } from "./notion.js";
import { replaceBlock, appendedPage } from "./blocks.js";
import { pickerMethods } from "./picker.js";
import { readMethods, sourcesChanged } from "./read.js";
import { NAME, MAP_REV, REFRESH_EVERY, dir, mapPath, cachePath, metaPath, uploadPath, spaceKey, spacePage, readJson, put, loadSettings } from "./store.js";
import * as fs from "fs/promises";

const UPLOAD_AFTER = 3000;
// readTextFile reads at most 1 MiB, and UTF-8 needs up to 3 bytes per UTF-16 unit.
const MAX_CHARS = 340000;

const putMeta = (id, m) => put(metaPath(id), JSON.stringify({ base: m.base, title: m.title, url: m.url, pending: m.pending, partial: m.partial }));
// The meta goes first: a pending flag without the newest text keeps older local edits,
// while new text without the flag would be replaced by Notion's on the next open. A partial
// (read-only, possibly oversized) page keeps no local copy: it is always read from Notion.
const persist = async (id, m, text, meta = true) => {
  if (meta) await putMeta(id, m);
  if (!m.partial) await put(cachePath(id), text);
};
// What a read from Notion sets on a note.
const fromPage = (p) => ({ base: p.markdown, savedText: p.markdown, title: p.title, url: p.url, partial: p.partial || p.markdown.length > MAX_CHARS });
// Bumping rev tells an upload already in flight that newer text exists.
const changed = (m) => { m.pending = true; m.rev++; };
// Which copy edits each page: a second view of the same page opens read-only, so two
// editors never write the same files. Module scope is shared by this mod's copies.
const owners = new Map();
// Per page, across copies: when Notion was last read or a read started, which also keeps a
// second refresh from starting while one runs.
const fetchedAt = new Map();
// The start-up upload of notes left pending runs once per app session, whatever the number
// of copies; an open of a note waits for its start-up upload to finish.
let swept = false;
let listed = Promise.resolve();
const sweeping = new Map();
// notion:// opens the desktop app; once `open` fails for it, https is used for the session.
let viaApp = true;

// Herdr tells a layout block nothing when it is shown, and a hidden copy gets no renders,
// but layout() carries every node's `hidden` and each stack's `active` child.
const shownIn = (node) => {
  if (!node || node.hidden) return false;
  if (node.content?.mod === NAME && !node.content.props?.page) return true;
  const kids = node.children ?? [];
  return (node.type === "stack" ? [kids.find((c) => c.id === node.active) ?? kids[0]] : kids).some(shownIn);
};

class NotionNotes extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.mode = p.page ? "pane" : p.overlay ? "picker" : "panel";
    this.setup = loadSettings().then((cfg) => { this.cfg = cfg; this.api = client(exec, cfg.ntn); });
    if (this.mode === "picker") return this.initPicker(cx);

    // Local files go through `disk` and Notion calls through `net`, so a slow upload never
    // holds back saving what is typed.
    this.disk = serial(); this.net = serial();
    this.page = null; this.meta = null; this.editor = null; this.dirty = false;
    this.conflict = null; this.creating = null; this.errors = {}; this.gen = 0; this.changedAt = 0;
    try { this.reading = localStorage.getItem("view") !== "edit"; } catch { this.reading = true; }
    this.setup.catch((e) => { this.errors.settings = `Settings in mod.json: ${e.message}`; cx.notify(); });
    cx.timer.every(800, (cx) => this.tick(cx));
    if (this.mode === "pane") {
      if (validId(p.page)) this.open(p.page, cx);
      else this.errors.open = "Not a Notion page id";
      return;
    }
    this.key = undefined; this.map = null; this.mapRev = shared(MAP_REV);
    this.loadMap(cx);
    if (!swept) { swept = true; this.sweep(cx); }
  }

  // Uploads every note left pending by an earlier session, one at a time, through the same
  // conflict check. Failures and conflicts are left pending, silently: the note shows them
  // when it is opened, and the next start tries again.
  // Every candidate is registered in `sweeping` before the first upload, and load() waits for
  // the listing, so an open can never race the sweep for the same note.
  sweep(cx) {
    listed = (async () => {
      let names = [];
      try { await this.setup; names = await fs.readdir(dir()); } catch { return; }
      let prev = Promise.resolve();
      for (const name of names) {
        const id = name.slice(0, -5);
        if (!name.endsWith(".json") || !validId(id)) continue;
        prev = prev.then(() => (owners.has(id) ? null : this.sweepOne(id))).catch(() => {});
        const job = prev;
        sweeping.set(id, job);
        job.then(() => sweeping.delete(id));
      }
    })();
  }

  // The sweep is already sequential and skips pages a view holds, so it needs no queue of its own.
  async sweepOne(id) {
    const m = await this.disk(() => readJson(metaPath(id)));
    if (!m?.pending || m.partial) return;
    const text = await this.disk(() => readTextFile(cachePath(id)));
    if (text == null) return;
    const r = await upload(this.api, id, text, m.base, uploadPath(id), put);
    if (r.conflict) return;
    fetchedAt.set(id, Date.now());
    await this.disk(() => putMeta(id, { ...m, base: r.base, pending: false }));
  }

  loadMap(cx) {
    cx.spawn(async (cx) => {
      try { this.map = (await readJson(mapPath())) ?? {}; this.errors.map = null; }
      catch (e) { this.errors.map = `Cannot read map.json: ${e.message}`; this.map = {}; }
      this.key = undefined;
      cx.notify();
    });
  }

  openPicker() {
    run("mod.open", { name: NAME });
  }

  canUpload(m) {
    return m?.pending && !m.uploading && !m.held && !m.readonly && !this.conflict && !this.creating;
  }

  // Local saves every 0.8 s, like tab-notes; an upload once typing has stopped for 3 s.
  // Its timer keeps running while the panel is hidden, so this is where showing is noticed.
  tick(cx) {
    if (this.mode === "panel") {
      const visible = shownIn(layout());
      // After a space change while hidden, render opens the new note and refreshes it there.
      if (visible && !this.visible && spaceKey() === this.key) this.refresh(cx);
      this.visible = visible;
    }
    // A read-only second view takes the note over once the view that edited it is gone.
    if (this.meta?.elsewhere && !owners.has(this.page)) this.open(this.page, cx);
    if (this.reading && this.sourcesSeen !== sourcesChanged()) { this.sourcesSeen = sourcesChanged(); cx.notify(); }
    if (this.dirty && this.editor) this.save(cx);
    if (this.canUpload(this.meta) && Date.now() - this.changedAt >= UPLOAD_AFTER) this.push(this.page, this.meta, false, cx);
  }

  save(cx) {
    this.dirty = false;
    const id = this.page, m = this.meta, text = this.editor.value();
    if (text.length > MAX_CHARS) { this.errors.save = "Note too large to save locally"; return; }
    // The meta only changes when the note turns pending; later saves rewrite just the text.
    const flips = !m.pending;
    changed(m);
    const rev = m.rev;
    cx.spawn(async (cx) => {
      try {
        await this.disk(async () => { await persist(id, m, text, flips); m.savedText = text; m.savedRev = rev; });
        if (this.meta === m) this.errors.save = null;
      } catch (e) {
        if (this.meta === m) { this.errors.save = `Save failed: ${e.message}`; this.dirty = true; }
      }
      cx.notify();
    });
  }

  // Uploads the last text saved to disk. A failure holds further uploads until the next edit,
  // so an offline note does not retry against Notion every tick.
  push(id, m, force, cx) {
    m.uploading = true;
    cx.spawn(async (cx) => {
      try {
        await this.net(async () => {
          const text = m.savedText, rev = m.savedRev;
          const r = await upload(this.api, id, text, m.base, uploadPath(id), put, force);
          if (r.conflict) { if (this.meta === m) this.conflict = r.conflict; return; }
          m.base = r.base;
          m.pending = m.rev !== rev;
          fetchedAt.set(id, Date.now());
          await this.disk(() => putMeta(id, m));
        });
        if (this.meta === m) this.errors.upload = null;
      } catch (e) {
        m.held = true;
        if (this.meta === m) this.errors.upload = `Upload failed: ${e.message}`;
      }
      m.uploading = false;
      cx.notify();
    });
  }

  // Creates a subpage in place of `block`. The remote steps share the upload queue, so they never
  // interleave with an upload comparing `base`; canUpload stops new ones from queuing meanwhile.
  createPage(block, title, cx) {
    const id = this.page, m = this.meta;
    this.creating = block;
    cx.spawn(async (cx) => {
      let made = null;
      try {
        await this.net(async () => {
          made = await this.api.create(title, `page:${id}`);
          // The page exists now: a failed read must not keep its tag out of the note.
          const remote = await this.api.get(id).catch(() => null);
          const found = remote && appendedPage(remote.markdown, m.base, made.id);
          // Notion refuses an upload that lacks the new tag ("would delete 1 child page"), so it is never dropped.
          const line = found ?? `<page url="${pageUrl(made.id)}">${title}</page>`;
          const place = (text) => replaceBlock(text, block, line) ?? (text ? `${text}\n${line}` : line);
          // The old base would read as a conflict now; with no tag found it stays, and the upload reports it.
          if (found) m.base = remote.markdown;
          if (this.meta === m) {
            this.setText(place(this.editor.value()), m);
            if (found) await this.disk(() => putMeta(id, m));
            return;
          }
          // The note was left meanwhile: its saved copy gets the tag, queued after the save that leaving started.
          await this.disk(async () => {
            const text = place(m.savedText);
            changed(m);
            await persist(id, m, text);
            m.savedText = text; m.savedRev = m.rev;
          });
        });
        if (this.meta === m) {
          this.errors.page = null;
          this.openPage(made.id, null, {}, cx);
        }
      } catch (e) {
        if (this.meta === m) this.errors.page = `Cannot create page: ${e.message}${made ? " (the subpage exists in Notion)" : ""}`;
      }
      this.creating = null;
      cx.notify();
    });
  }

  // The local copy opens at once and refresh() checks Notion; unsent edits always win.
  // An unreadable meta file stops the open rather than risk replacing them.
  async load(id, fresh) {
    await this.setup;
    await listed;
    await sweeping.get(id);
    const saved = await this.disk(() => readJson(metaPath(id)));
    const cached = saved && !saved.partial ? await this.disk(() => readTextFile(cachePath(id))) : null;
    if (cached != null && (saved.pending || !fresh)) {
      const rev = saved.pending ? 1 : 0;
      return { ...saved, rev, savedRev: rev, savedText: cached };
    }
    const p = await this.api.get(id);
    fetchedAt.set(id, Date.now());
    const m = { ...fromPage(p), pending: false, rev: 0, savedRev: 0 };
    await this.disk(() => persist(id, m, p.markdown));
    return m;
  }

  release() {
    if (owners.get(this.page) === this) owners.delete(this.page);
  }

  // Leaving a note saves it and starts its upload.
  leave(cx) {
    this.endEdit(cx, true);
    if (!this.meta) return;
    if (this.dirty && this.editor) this.save(cx);
    if (this.canUpload(this.meta)) this.push(this.page, this.meta, false, cx);
  }

  editorFor(m) {
    const editor = EditorState.new({ language: "md", value: m.savedText, line_numbers: false, folding: false, soft_wrap: true,
      readonly: m.readonly, font_family: settings().font_family, font_size: 13 });
    editor.on("change", () => this.edited(m));
    return editor;
  }

  // Every local change goes through here, so a held upload is released by any edit.
  edited(m) {
    this.dirty = true; this.changedAt = Date.now(); m.held = false;
  }

  // Reads the page again when it comes into view, unless local edits are waiting (the upload
  // and its conflict check handle those). A failure keeps the text and only shows the error.
  refresh(cx) {
    const id = this.page, m = this.meta;
    if (!m || m.elsewhere || m.pending || m.uploading || this.dirty || this.conflict || this.editing || this.creating) return;
    const started = Date.now();
    if (started - (fetchedAt.get(id) ?? 0) < REFRESH_EVERY) return;
    fetchedAt.set(id, started);
    cx.spawn(async (cx) => {
      try {
        const p = await this.api.get(id);
        if (this.meta !== m) return;
        const decision = refreshDecision({ typed: this.changedAt > started, remote: p.markdown, base: m.base });
        this.errors.refresh = null;
        if (decision === "same" && (m.url !== p.url || m.title !== p.title)) {
          Object.assign(m, { url: p.url, title: p.title });
          await this.disk(() => putMeta(id, m));
        }
        // A block opened while the read was in flight: its text stays for the next refresh.
        if (decision !== "apply" || this.editing || this.creating) return;
        Object.assign(m, fromPage(p));
        m.readonly = m.partial;
        this.editor.release();
        this.editor = this.editorFor(m);
        await this.disk(() => persist(id, m, p.markdown));
      } catch (e) {
        // A failed read does not count against the throttle: the next show tries again.
        if (fetchedAt.get(id) === started) fetchedAt.delete(id);
        if (this.meta === m) this.errors.refresh = `Refresh failed: ${e.message}`;
      } finally {
        cx.notify();
      }
    });
  }

  open(id, cx, fresh = false) {
    this.endEdit(cx, true);
    this.release();
    this.editor?.release();
    this.editor = null; this.page = id; this.meta = null; this.conflict = null; this.dirty = false;
    this.errors = { settings: this.errors.settings, map: this.errors.map, draft: this.errors.draft };
    if (!id) return;
    const gen = ++this.gen;
    cx.spawn(async (cx) => {
      try {
        const m = await this.load(id, fresh);
        if (this.gen !== gen) return;
        m.elsewhere = owners.has(id) && owners.get(id) !== this;
        if (!m.elsewhere) owners.set(id, this);
        m.readonly = m.partial || m.elsewhere;
        this.meta = m;
        this.editor = this.editorFor(m);
        this.refresh(cx);
      } catch (e) {
        // No editor: typing into an empty one would later overwrite the page.
        if (this.gen === gen) this.errors.open = `Cannot open note: ${e.message}`;
      }
      cx.notify();
    });
  }

  // Drops local edits: the note is read again from Notion.
  reload(cx) {
    const id = this.page, m = this.meta;
    m.pending = false;
    this.disk(() => putMeta(id, m)).catch(() => {});
    this.open(id, cx, true);
  }

  openInNotion(cx, id = this.page, url = this.meta?.url) {
    cx.spawn(async (cx) => {
      try {
        // Without an app for notion://, `open` exits non-zero and the https URL is used instead.
        let r = viaApp ? await exec("open", [pageUrl(id, url, true)]) : null;
        if (r?.code !== 0) {
          viaApp = false;
          r = await exec("open", [pageUrl(id, url, false)]);
        }
        if (r.code !== 0) throw new Error(r.stderr.trim() || `open exited with ${r.code}`);
        this.errors.link = null;
      } catch (e) {
        this.errors.link = `Cannot open in Notion: ${e.message}`;
      }
      cx.notify();
    });
  }

  toggleView(cx) {
    if (!this.endEdit(cx)) return;
    this.reading = !this.reading;
    try { localStorage.setItem("view", this.reading ? "read" : "edit"); } catch {}
    cx.notify();
  }

  overwrite(cx) {
    this.conflict = null;
    this.push(this.page, this.meta, true, cx);
  }

  async close() {
    this.endEdit(undefined, true);
    this.release();
    if (!this.dirty || !this.editor || !this.meta) return;
    // An upload does not fit in close's 250 ms: keep it pending for the next start.
    const id = this.page, m = this.meta, text = this.editor.value();
    changed(m);
    await this.disk(() => persist(id, m, text));
  }

  statusText(m) {
    if (!m) return "";
    if (m.uploading) return "Syncing…";
    if (m.elsewhere) return "Read-only: open in another view";
    if (m.partial) return "Read-only: partial page";
    return m.pending || this.dirty ? "Not synced" : "Synced";
  }

  render(cx) {
    if (this.mode === "picker") return this.renderPicker(cx);
    if (this.mode === "panel") {
      const rev = shared(MAP_REV);
      if (rev !== this.mapRev) { this.mapRev = rev; this.loadMap(cx); }
      const key = spaceKey();
      if (this.map && key !== this.key) {
        this.key = key;
        const id = spacePage(this.map);
        if ((id ?? null) !== this.page) { this.leave(cx); this.open(validId(id) ? id : null, cx); }
        else this.refresh(cx);
      }
    }
    const t = theme(), m = this.meta, pane = this.mode === "pane";
    const error = Object.values(this.errors).find(Boolean);
    const status = this.statusText(m);
    const button = (id, label, primary, action) => h_flex().id(id).h(26).px(10).items_center().rounded(6).flex_none()
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12).cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click((_e, cx) => action(cx)).child(label);
    // The editor state stays alive while reading, so cursor and undo survive the switch.
    const body = this.reading && this.editor ? this.renderRead(cx)
      : this.editor ? Editor.new(this.editor).flex_1().min_h(0).p(6)
      : !this.page && this.mode === "panel" ? v_flex().flex_1().items_center().justify_center().gap(10)
          .child(div().text_color(t.dim).child("No note for this space"))
          .child(button("nn-choose", "Choose note", true, () => this.openPicker()))
      : div().p(12).text_color(t.dim).child(error || !this.page ? "" : "Loading note…");
    return v_flex().id("notion-notes").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      // A pane already has Herdr's header (it shows the mod's name and no mod can change it), so
      // the pane drops the "Notes" label and keeps one compact row: page title, status, controls.
      .child(h_flex().h(pane ? 34 : 42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(!pane, (el) => el.child(div().flex_none().font_semibold().child("Notes")))
        .child(h_flex().id("nn-title").flex_1().min_w(0).when(!pane, (el) => el.justify_end()).cursor_pointer()
          .when(this.mode === "panel", (el) => el.on_click(() => this.openPicker()))
          .child(div().min_w(0).truncate().text_size(pane ? 13 : 12).text_color(pane ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
            .child(m?.title ?? (this.mode === "panel" ? "Choose note" : ""))))
        .when(Boolean(status), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(status)))
        .when(Boolean(this.editor), (el) => el
          .child(button("nn-view", this.reading ? "Markdown" : "Read", false, (cx) => this.toggleView(cx)))
          .child(button("nn-notion", svg(`mods/${NAME}/external-link.svg`).size(14).text_color(t.foreground), false, (cx) => this.openInNotion(cx)).px(6))))
      .when(Boolean(error), (el) => el.child(div().px(14).py(6).text_size(11).text_color(t.ansi1).child(error)))
      .when(Boolean(this.conflict), (el) => el.child(h_flex().px(14).py(8).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.blocked).child("Changed in Notion"))
        .child(button("nn-reload", "Reload", false, (cx) => this.reload(cx)))
        .child(button("nn-overwrite", "Overwrite", true, (cx) => this.overwrite(cx)))))
      .child(body);
  }
}

Object.assign(NotionNotes.prototype, pickerMethods, readMethods);
export default NotionNotes;
