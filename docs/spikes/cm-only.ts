/**
 * Size probe: what CodeMirror alone would add to `public/app.js`.
 *
 * Imports exactly the surface a real knag integration needs and nothing else - no
 * language support, no search, no autocomplete, no lint, no default theme beyond the
 * base one the view ships. Everything referenced so esbuild cannot tree-shake away the
 * thing being measured.
 *
 * If this file ever imports something knag would not actually use, the number it
 * produces is a lie in the safe direction, which is the wrong direction for a
 * dependency decision.
 */

import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";

export const surface = {
  EditorState,
  RangeSetBuilder,
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  defaultKeymap,
  history,
  historyKeymap,
};

// esbuild drops a module with no side effects and no consumed exports.
(globalThis as unknown as { __cm: unknown }).__cm = surface;
