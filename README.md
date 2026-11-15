# notion-notes

A Herdr Desktop mod that opens a Notion page as an editable markdown note, through the
[Notion CLI](https://developers.notion.com/cli/reference/commands) (`ntn`).

- **Panel** (a layout block, no props): the note mapped to the active space. Click the title
  (or **Choose note**) to open the picker.
- **Pane**: `pane.split {direction: "right", mod: "notion-notes", props: {page: "<page id>"}}`.
- **Picker** (dialog, `mod.open {name: "notion-notes"}`): with an empty query it lists the configured data source (or recently
  edited pages); typing searches the workspace (300 ms debounce). The last row creates a page
  with the typed title. `↑`/`↓` move, `Enter` opens in the panel, `⌘Enter` opens a pane to the
  right, `Esc` closes. With more than one configured parent, creating asks which one.

## Install

1. Install and log in to the CLI: `ntn login`; check with `ntn whoami`.
2. Copy `mods/notion-notes` to `~/.config/herdr-app/mods/notion-notes`, then
   `herdr-app check ~/.config/herdr-app/mods/notion-notes`.
3. Put it in your layout as a block, `{ "mod": "notion-notes" }`, for example as another
   child of a panel stack, with a Better Tabs button:

   ```json
   { "id": "notes", "label": "Notes", "icon": "mods/notion-notes/notes.svg",
     "when": { "node": "notion-notes" },
     "action": { "type": "panel", "container": "panel", "stack": "panel-body", "target": "notion-notes" } }
   ```

4. Optional key: `"cmd-shift-n": "mod.open:notion-notes"` in `keys.json` opens the picker
   (a copy opened with `mod.open` is the picker), whether or not the panel is shown.

## Read mode

The header's **Read** / **Edit** button switches the note (the choice is remembered) between
**Read**, a view drawn block by block, and **Edit**, the plain markdown text. Read changes the
note in the ways below; everything else needs Edit. Read-only notes cannot be changed in Read.

- **Text blocks**: click a paragraph, heading, bullet, numbered item, to-do, one-line quote or empty
  line to edit it in a one-line field that holds only its text (the `#`, `-`, `1.` or `> ` stays
  outside the field). Any click on the block opens the field, including one on a link in its text
  or a drag to select it; ⌘-click is left alone, and Edit follows links. The field saves when it loses focus or you press `Esc`;
  the edit then uploads like any other (see Sync rules).
  - `Enter` saves and starts a new block below, continuing a bullet, numbered or to-do list; on an
    empty list item it turns the item into a paragraph.
  - `Backspace` on an empty field turns a list item, heading or quote into a paragraph, and
    deletes an empty paragraph, moving into the end of the block above. An empty note always shows
    one empty line to click.
  - `↑` / `↓` save and move to the previous or next editable block.
  - If the block changed in Notion while open, the field stays open with **This block changed in
    Notion; copy your text or discard it** and a **Discard** button; nothing is overwritten. If
    you switch note or close the panel then, the text is shown in a **Not saved** notice instead.
  - If the text you type turns the block into one that spans the lines below (a ```` ``` ```` fence,
    a table row, a tag), `Enter` saves it and closes the field without adding a block.
- **`/` menu**: typing `/` at the start of the field or after a space opens a menu of Text,
  Heading 1-3, To-do, Bulleted list, Numbered list, Quote, Divider and Page; keep typing to filter
  (English and Spanish words), `↑` / `↓` and `Enter` or a click to pick, `Esc` to close. A type
  keeps the block's text; Divider adds a `***` line below. **Page** (`/page`) creates a subpage
  titled with the rest of the block's text (or "Untitled"), puts its link in place of the block and
  opens it in a pane to the right. Code is not offered.
- **To-dos**: the checkbox marks or unmarks the item in the note, and the edit uploads like any
  other. Done items show struck through. Not clickable in read-only notes, nor for to-dos nested
  inside other tags (columns...).
- **Callouts and toggles**: callouts are drawn as boxes with their icon and toggles as collapsible
  sections (their open state is not remembered, and is kept by line: adding lines above an open
  toggle can open another one instead). Their to-dos can be ticked; their other text is
  shown but not editable in Read. One whose tags share a line with text falls back to plain markdown.
- **Subpages**: click opens the page in a pane to the right, ⌘-click opens it in Notion.
- **Inline databases**: a table of the first 50 rows, title column first and then the schema's order
  (the API does not give a view's column order, so filters, sorting and hidden columns of the
  Notion view are not applied). Click a row to open it in a pane to the right, ⌘-click for Notion.
  `status` and `select` values show as tags in theme colours. With more rows the footer reads
  "Showing first 50 · Open in Notion". A linked database (no data source of its own) shows as a link
  only. If the rows cannot be read the block shows one error line and the rest of the page still renders.
  - Click a cell to edit it (⌘-click still opens the row): a checkbox flips; `select` and `status`
    open a menu of the schema's options (only `select` has an empty choice, because Notion resets
    a cleared status to its default); `title`, `rich_text`, `number`, `url`, `email` and
    `phone_number` open a field where `Enter` or leaving it saves and `Esc` discards. A title or
    rich text is editable only when it is plain, unformatted, unlinked text on one line, since
    the field would drop the rest. Other types stay read-only.
  - Values are checked before they are sent: Notion silently adds a `select` option that does not
    exist, so only the schema's options are accepted, and a number must be finite.
  - **+ New** at the end of the table asks for a title, creates the row and opens it in a pane.
  - A cell is drawn dimmed until Notion confirms the write, then the table is read again; an error
    shows under its row.

Still needs Edit: code blocks, multi-line quotes, dividers, tables, the text inside callouts and
toggles, other tags (columns...) and selecting text across blocks. Columns, simple tables and
other tags show as the plain markdown fallback, with child pages and databases inside them as links.

## Appending from an agent

`bin/notion-note-append` (node, no dependencies) appends markdown from stdin to the note
mapped to a folder: `--folder` (default: the current directory, then each parent until one is
in `map.json`) or `--page <id>`. It runs `ntn api v1/pages/<id>/markdown -X PATCH -d <json>`
with an `insert_content` at the end of the page, so the page body is not rewritten (Notion marks
that operation deprecated but it is the markdown endpoint's only append), using the `ntn` from
the installed mod's settings. It exits 1 with one line when no note is mapped, stdin is empty
or `ntn` fails. For an agent prompt:

```sh
printf '## Agent summary\n- what changed\n' | ~/ai/herdr/custom-mods/notion-herdr/bin/notion-note-append
```

It refuses (exit 1) while the note has edits in Herdr not yet uploaded, so an append never
forces a choice between them; retry once the note shows Synced. The check reads the note's saved
state, so typing from the last 0.8 s before the panel's next local save is not seen; that
case still ends at **Changed in Notion** in the panel, nothing is overwritten silently. An open note picks the
appended text up on its next refresh.



In the installed `mod.json`, under `settings`:

| Key | Default | Meaning |
| --- | --- | --- |
| `parents` | `[]` | `[{ "name": "Inbox", "ref": "page:<id>" }]`; `ref` is `page:<id>`, `database:<id>` or `data-source:<id>`. None: new pages are private workspace pages. |
| `datasource` | `""` | Data source (or database) id listed when the query is empty. Empty: recently edited pages. |
| `ntn` | `"ntn"` | Path to the `ntn` binary. |

## What it runs

Only `ntn`, with ids and titles passed as separate arguments, never inside a shell string:

- `ntn pages get <id> --json` to open or refresh a note and before and after each upload;
- `ntn pages edit <id>` through `sh -c '"$1" pages edit "$2" < "$3"'` (exec has no stdin).
  It never passes `--allow-deleting-content`, so child pages and databases are kept;
- `ntn pages create --json --content=<frontmatter title> [--parent <ref>]` for the picker's new
  page and for `/page`, which creates under `--parent page:<id>` (`--content=…` is joined with `=`
  because `ntn` takes a separate value starting with `---` for a flag);
- `ntn datasources query <id> --limit 50 --json` for the picker's list and for an inline
  database's rows in Read mode, `ntn api v1/data_sources/<id>` for that database's columns, and
  `ntn api v1/search -d <json>`.
- once per app session, when the picker first opens, `ntn api v1/search` filtered to data
  sources, to name database parents in picker rows (failure is silent; rows show without it).
- `ntn api v1/pages/<id> -X PATCH -d <json>` to write one cell of a database row, and
  `ntn api v1/pages -d <json>` (POST) to add a row with its title.

The header's open button runs `open notion://www.notion.so/<id>` (the Notion app); if that
fails it uses, for the rest of the session, `open` with the page's own https URL when it is on
a notion.so/notion.site/notion.com domain, else `https://www.notion.so/<id>`.

Uploads only follow edits: 3 s after typing stops, and when the panel switches note. There is
no polling of Notion.

## What it writes

Everything goes to `~/.config/herdr-app/notion-notes/` (not the mod folder, where a save
would reload the mod):

- `map.json`: space folder (prefixed with `machine:` for remote spaces) → page id. A local
  space without its own entry shows the note of the nearest mapped parent folder;
- `<page id>.md`: the local copy, saved every 0.8 s while typing (none for partial,
  read-only pages, which are always read from Notion);
- `<page id>.json`: `{ base, title, url, pending, partial }`. `base` is Notion's markdown at the last read
  or upload; `pending` means local edits are not in Notion yet;
- `<page id>.upload.md`: the text of the last upload.

## Sync rules

- Before uploading, the page's current markdown is compared with `base`. If Notion changed,
  nothing is written and the note shows **Changed in Notion** with **Reload** (take
  Notion's version, dropping local edits) and **Overwrite** (upload local edits anyway).
  Content is compared rather than `last_edited_time` because Notion rounds that time to the
  minute.
- A note opens from its local copy, then is read again from Notion when it is opened, when
  the panel is shown again, or when the space changes back to it: at most once per 15 s per
  page, and only without unsent edits. A Notion change replaces the text unless you typed
  meanwhile; a failed read only shows an error line.
- Pages Notion returns as truncated or with unsupported blocks, and notes over 340,000
  characters (Herdr reads at most 1 MiB per file), open read-only.
- A page already open in another view (panel and pane) opens read-only in the second one.
- Known limits: after `pages edit`, the new `base` comes from a second `pages get`, so a Notion
  edit landing between the two is not detected. An upload cut off by quitting can show
  **Changed in Notion** on the next start even though Notion has your own text; Overwrite is
  then safe.
- Closing Herdr leaves unsent edits marked `pending`. The first panel copy of the next app
  session uploads every pending note, one at a time and with the same conflict check; a
  conflict or failure stays pending, without an error until that note is opened.
- Marking a to-do and saving a block in Read mode upload the whole page through `ntn pages edit`,
  like any edit (saves within 3 s of each other go up together). If Notion recreates blocks on
  upload, comments attached to blocks could be lost; this has not been tested, so try it on a
  scratch page with a block comment before using real pages.
- `/page` creates the subpage, reads the parent again and takes that markdown as `base` (Notion
  appends the new `<page>` line to it), then uploads the note with the block replaced by that
  link, which moves the line into place. If the parent changed in some other way meanwhile, `base`
  is left alone and the upload reports the conflict.
- Cell edits and new rows go straight to Notion through the API. They are not part of the page
  upload or its conflict check, and the last write wins.
- A refresh does not apply while a block is open for editing or a subpage is being created.
- A note starting with `---` is uploaded behind an empty frontmatter block, because
  `ntn pages edit` strips a leading frontmatter.

## Self-check

`node tests/self-check.mjs` runs the CLI parsing, upload ordering and conflict decision
against `tests/fake-ntn.mjs`.

## Credits

The save chain follows `tab-notes` from
[ozcberkay/herdr-coban](https://github.com/ozcberkay/herdr-coban), Apache-2.0
(`LICENSE-tab-notes`). `notes.svg` and `external-link.svg` are Lucide's `file-text` and `external-link`, ISC (`mods/notion-notes/LICENSE-lucide`).
