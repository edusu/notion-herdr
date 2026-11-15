// The picker dialog: pages of the default data source, or workspace search while typing,
// and a last "Create" row. Enter opens in the panel, cmd-Enter in a pane to the right.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { theme, props, run, closeOverlay } from "herdr";
import { NAME, mapPath, spacePage, readJson, mapSpace } from "./store.js";
import { ago } from "./notion.js";

const DEBOUNCE = 300;
// Data-source names for row details, looked up once per app session (module scope).
let sources = null;
const ROW = 32;
const MAX_ROWS = 11;

export const pickerMethods = {
  initPicker(cx) {
    this.query = props().query ?? "";
    this.items = []; this.at = 0; this.step = "pages"; this.loading = true; this.error = null; this.seq = 0;
    this.scroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.input = InputState.new({ value: this.query, placeholder: "Search Notion, or type a title to create…" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value(); this.step = "pages"; this.at = 0;
      const seq = ++this.seq;
      cx.timer.after(DEBOUNCE, (cx) => { if (seq === this.seq) this.fetch(cx); });
      cx.notify();
    });
    this.input.on("submit", (e, cx) => this.choose(this.shown?.[this.at], Boolean(e?.secondary), cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.fetch(cx);
    if (!sources) {
      sources = new Map();
      cx.spawn(async (cx) => {
        // A failed lookup is retried at the next picker open.
        try { await this.setup; sources = await this.api.sources(); cx.notify(); } catch { sources = null; }
      });
    }
    cx.spawn(async (cx) => {
      this.current = spacePage((await readJson(mapPath()).catch(() => null)) ?? {});
      cx.notify();
    });
  },

  fetch(cx) {
    const seq = ++this.seq, q = this.query.trim();
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        await this.setup;
        const items = q || !this.cfg.datasource ? await this.api.search(q) : await this.api.list(this.cfg.datasource);
        if (seq !== this.seq) return;
        this.items = items; this.error = null;
      } catch (e) {
        if (seq !== this.seq) return;
        this.items = []; this.error = e.message;
      }
      this.loading = false; this.at = Math.min(this.at, this.rows().length - 1);
      cx.notify();
    });
  },

  rows() {
    if (this.step === "parents") return this.cfg.parents.map((p) => ({ kind: "parent", ...p }));
    return [...this.items.map((p) => ({ kind: "page", ...p })), { kind: "create" }];
  },

  title() {
    return this.query.trim() || "Untitled";
  },

  // One choice at a time (`busy`), so a double Enter cannot create two pages or race on map.json.
  choose(row, toPane, cx) {
    if (!row || this.busy) return;
    const parents = this.cfg?.parents ?? [];
    if (row.kind === "create" && parents.length > 1) {
      this.step = "parents"; this.at = 0; this.toPane = toPane;
      this.handle.focus();
      return cx.notify();
    }
    if (row.kind === "parent") toPane = this.toPane;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await this.setup;
        const id = row.kind === "page" ? row.id : (await this.api.create(this.title(), row.kind === "parent" ? row.ref : parents[0]?.ref)).id;
        if (toPane) run("pane.split", { direction: "right", mod: NAME, props: { page: id } });
        else await mapSpace(id);
        closeOverlay(props().overlay);
      } catch (e) {
        this.error = e.message;
      }
      this.busy = false;
      cx.notify();
    });
  },

  renderPicker() {
    const t = theme();
    const rows = (this.shown = this.rows());
    const row = (r, i) => {
      const label = r.kind === "create" ? `Create "${this.title()}"` : r.kind === "parent" ? r.name : r.title;
      const mapped = r.kind === "page" && r.id === this.current;
      const parent = r.kind === "page" && (r.parent ?? r.parentIds.map((id) => sources?.get(id)).find(Boolean));
      const details = r.kind === "page" ? [parent, r.edited && ago(r.edited)].filter(Boolean).join(" · ") : "";
      return h_flex().id(`nn-row-${i}`).flex_none().h(ROW).px(10).gap(8).items_center().rounded(7).cursor_pointer()
        .when(i === this.at, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click((e, cx) => { this.at = i; this.choose(r, Boolean(e.modifiers?.platform), cx); })
        .child(r.kind === "page" ? svg(`mods/${NAME}/notes.svg`).size(14).flex_none().text_color(mapped ? t.accent : t.dim)
          : div().w(14).flex_none().text_color(t.accent).child("+"))
        .child(div().flex_1().min_w(0).truncate().text_color(r.kind === "page" ? t.foreground : t.muted).when(mapped, (el) => el.font_semibold()).child(label))
        .when(mapped, (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("this space")))
        .when(Boolean(details), (el) => el.child(div().flex_none().max_w(220).truncate().text_size(11).text_color(t.dim).child(details)));
    };
    const heading = this.step === "parents" ? `Create "${this.title()}" in…` : "Notion notes";
    const hint = this.busy ? "Creating…" : this.loading ? "Loading…" : "↵ panel · ⌘↵ pane";
    return v_flex().id("nn-picker").track_focus(this.handle).w_full().p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(props().overlay);
        else if (e.key === "down") this.at = (this.at + 1) % rows.length;
        else if (e.key === "up") this.at = (this.at + rows.length - 1) % rows.length;
        else if (e.key === "enter" && this.step === "parents") this.choose(rows[this.at], false, cx);
        else return;
        this.scroll.scroll_to_item(this.at);
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(heading))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(hint)))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(svg(`mods/${NAME}/notes.svg`).size(15).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .when(Boolean(this.error), (el) => el.child(div().text_size(11).text_color(t.ansi1).child(this.error)))
      // The dialog sizes to its content (no height in mod.json); the list scrolls past MAX_ROWS.
      .child(v_flex().id("nn-list").h(Math.min(rows.length, MAX_ROWS) * ROW).overflow_y_scrollbar().track_scroll(this.scroll).children(rows.map(row)));
  },
};
