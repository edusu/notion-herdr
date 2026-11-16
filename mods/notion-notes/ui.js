// Text sizes, and the fixed sizes around them, from the font_size and scale settings in mod.json.
// Module scope is shared by this mod's copies, which all read the same mod.json.

/** Sizes at the defaults, in px. Text follows font_size; `body` is its default. */
export const TEXT = { title: 22, h2: 18, h3: 15, body: 13, input: 12.8, small: 12, tiny: 11 };
/** Heights and widths that hold text: they follow the larger of scale and font_size, so text always fits. */
export const BOX = {
  header: 42, paneHeader: 34, pickerRow: 32, search: 36, block: 28, button: 26, row: 26, smallButton: 22, line: 20,
  check: 15, arrow: 12, menu: 220, cellMenu: 200,
};
/** Icons follow scale only. */
export const ICON = { icon: 14, iconLarge: 15 };

/** The sizes the views draw with; setSizes rewrites them in place. */
export const ui = { text: { ...TEXT }, size: { ...BOX, ...ICON } };

const fit = (v, min, max, fallback) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);

/** Applies the settings, kept to the ranges mod.schema.json allows. Sizes round to whole px. */
export function setSizes(scale, fontSize) {
  const s = fit(scale, 0.8, 1.6, 1), f = fit(fontSize, 9, 24, TEXT.body) / TEXT.body, box = Math.max(s, f);
  for (const k in TEXT) ui.text[k] = TEXT[k] * f;
  for (const k in BOX) ui.size[k] = Math.round(BOX[k] * box);
  for (const k in ICON) ui.size[k] = Math.round(ICON[k] * s);
}
