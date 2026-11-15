// The read view: the note drawn block by block from parseBlocks. It only changes text through
// toggleTodo on the editor, so uploads still send the editor's text and never one rebuilt from blocks.
import { div } from "gpui-kit";
import { v_flex, h_flex, Checkbox, TextView } from "gpui-base";
import { theme, run } from "herdr";
import { NAME, REFRESH_EVERY } from "./store.js";
import { readable } from "./notion.js";
import { parseBlocks, toggleTodo, cell } from "./blocks.js";

const INDENT = 18;

// Notion colour name → Herdr theme token; anything else is muted.
const TAG_COLORS = { red: "ansi1", green: "ansi2", yellow: "ansi3", blue: "ansi4", purple: "ansi5", pink: "ansi13", orange: "ansi11", brown: "ansi3" };

// Data source id → { at, busy, data, error }, shared by every view. `at` is set when a read
// starts, so a failed read waits out the same throttle as a good one.
const sources = new Map();
// Bumped when any read ends: every view showing that data source redraws on its next tick, not
// only the one that started the read.
let sourcesRev = 0;
export const sourcesChanged = () => sourcesRev;

// One TextView per block keeps bold, code and links working. Ids are the block's first line,
// which stays unique and stable while a to-do is toggled.
const md = (id, source) => TextView.markdown(id, source).selectable(true);

export const readMethods = {
  toggleBlock(block, cx) {
    if (this.editor && !this.meta.readonly) {
      // null: the text moved under this block since it was drawn.
      const next = toggleTodo(this.editor.value(), block.from, block.label);
      if (next !== null) {
        this.editor.set_value(next);
        // The docs do not say whether set_value emits "change"; edited() is idempotent.
        this.edited(this.meta);
      }
    }
    cx.notify();
  },

  // A page opens in a pane to the right, ⌘-click opens it in Notion.
  openPage(id, url, e, cx) {
    if (e.modifiers?.platform) this.openInNotion(cx, id, url);
    else run("pane.split", { direction: "right", mod: NAME, props: { page: id } });
  },

  // A database opens only in Notion: pane mode reads pages.
  openBlock(block, e, cx) {
    if (!block.id) return;
    if (block.type === "page") this.openPage(block.id, block.url, e, cx);
    else this.openInNotion(cx, block.id, block.url);
  },

  // The rows under a database's title: the table, "Loading…" or the read error. Draws from the
  // cache and starts a read when it is older than REFRESH_EVERY.
  renderSource(block, t, cx) {
    let e = sources.get(block.source);
    if (!e) sources.set(block.source, (e = {}));
    if (!e.busy && Date.now() - (e.at ?? 0) >= REFRESH_EVERY) {
      e.busy = true;
      e.at = Date.now();
      cx.spawn(async (cx) => {
        try {
          await this.setup;
          e.data = await this.api.source(block.source);
          e.error = null;
        } catch (err) {
          e.error = err.message;
        } finally {
          e.busy = false;
          sourcesRev++;
          cx.notify();
        }
      });
    }
    const note = (text, color) => div().flex_none().px(6).text_xs().text_color(color).child(text);
    const d = e.data;
    if (!d) return [e.error ? note(e.error, t.ansi1) : note("Loading…", t.dim)];
    const cells = (cols, props) => cols.map((col, c) => {
      const { text, color } = props(col);
      const ink = t[TAG_COLORS[color] ?? "muted"];
      return h_flex().flex_1().flex_grow(c === 0 ? 2 : 1).min_w(0).overflow_hidden()
        .child(color !== undefined && text
          ? div().min_w(0).truncate().rounded(10).border_1().border_color(ink).bg(t.raised).px(6).text_xs().text_color(ink).child(text)
          : div().min_w(0).truncate().child(text));
    });
    return [
      h_flex().flex_none().px(6).py(2).gap(8).border_b(1).border_color(t.border).text_xs().text_color(t.muted)
        .children(d.columns.map((col, c) => div().flex_1().flex_grow(c === 0 ? 2 : 1).min_w(0).truncate().child(col.name))),
      ...d.rows.map((r, i) => h_flex().id(`nn-r-${block.from}-${i}`).flex_none().min_h(26).px(6).gap(8).items_center().rounded(6)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((ev, cx) => this.openPage(r.id, r.url, ev, cx))
        .children(cells(d.columns, (col) => cell(r.properties[col.name])))),
      ...(d.more ? [h_flex().id(`nn-m-${block.from}`).flex_none().px(6).py(4).cursor_pointer().text_xs().text_color(t.muted)
        .on_click((ev, cx) => this.openBlock(block, ev, cx)).child("Showing first 50 · Open in Notion")] : []),
      ...(e.error ? [note(e.error, t.ansi1)] : []),
    ];
  },

  renderRead(cx) {
    const t = theme(), ro = Boolean(this.meta?.readonly);
    const row = (block) => {
      const id = `nn-b-${block.from}`;
      const pad = (depth) => h_flex().flex_none().items_start().pl(depth * INDENT);
      switch (block.type) {
        case "todo": {
          const on = block.done;
          return pad(block.depth).gap(8)
            .child(Checkbox.new(`nn-t-${block.from}`).checked(on).disabled(ro).on_change((_v, cx) => this.toggleBlock(block, cx))
              .accessibility_label(block.label).flex().items_center().justify_center().size(15).flex_none().mt(2).rounded(4)
              .border_1().border_color(on ? t.accent : t.border).bg(on ? t.accent : t.background)
              .when(!ro, (el) => el.cursor_pointer())
              .when(on, (el) => el.child(div().text_size(11).text_color(t.accent_foreground).child("✓"))))
            .when(Boolean(block.label), (el) => el.child(div().flex_1().min_w(0).text_color(on ? t.dim : t.foreground)
              .child(md(id, on ? `~~${block.label}~~` : block.label))));
        }
        case "bullet":
        case "numbered":
          return pad(block.depth).gap(6)
            .child(div().flex_none().text_color(t.muted).child(block.type === "bullet" ? "•" : block.marker))
            .child(div().flex_1().min_w(0).child(md(id, block.text)));
        case "paragraph":
          return pad(block.depth).child(div().flex_1().min_w(0).child(md(id, block.text)));
        case "quote":
          return div().flex_none().border_l(2).border_color(t.border).pl(10).text_color(t.muted).child(md(id, block.text));
        case "code":
          return div().flex_none().rounded(6).bg(t.raised).p(8).child(md(id, block.raw));
        case "divider":
          return div().flex_none().h(1).my(6).bg(t.border);
        case "page":
        case "database": {
          const link = h_flex().id(`nn-p-${block.from}`).flex_none().h(28).px(6).gap(8).items_center().rounded(6)
            .when(Boolean(block.id), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((e, cx) => this.openBlock(block, e, cx)))
            .child(div().flex_none().child(block.type === "page" ? "📄" : "🗃️"))
            .child(div().flex_1().min_w(0).truncate().child(block.title));
          // A linked database has no data source of its own, so it stays a link.
          return block.type === "database" && block.source
            ? v_flex().flex_none().gap(2).child(link).children(this.renderSource(block, t, cx))
            : link;
        }
        case "empty":
        case "blank":
          return div().flex_none().h(8);
        case "heading":
          return md(id, block.raw);
        default:
          return md(id, readable(block.raw));
      }
    };
    return v_flex().id("nn-read").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(10).gap(4)
      .children(this.blocks().map(row));
  },

  // Renders happen far more often than edits, so the parse is kept until the text changes.
  blocks() {
    const text = this.editor.value();
    if (text !== this.parsedText) { this.parsedText = text; this.parsed = parseBlocks(text); }
    return this.parsed;
  },
};
