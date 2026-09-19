import type { editor } from "monaco-editor";
import { KeyCode, KeyMod } from "monaco-editor/esm/vs/editor/editor.api.js";

export function wireEditorNavigationKeys(target: editor.IStandaloneCodeEditor): void {
  target.addCommand(KeyMod.CtrlCmd | KeyCode.UpArrow, () => {
    target.trigger("keyboard", "cursorTop", null);
  });
  target.addCommand(KeyMod.CtrlCmd | KeyCode.DownArrow, () => {
    target.trigger("keyboard", "cursorBottom", null);
  });
  target.addCommand(KeyMod.CtrlCmd | KeyCode.LeftArrow, () => {
    target.trigger("keyboard", "cursorHome", null);
  });
  target.addCommand(KeyMod.CtrlCmd | KeyCode.RightArrow, () => {
    target.trigger("keyboard", "cursorEnd", null);
  });
}
