import type { editor } from "monaco-editor";
import { KeyCode, KeyMod } from "monaco-editor/esm/vs/editor/editor.api.js";
import { describe, expect, it, vi } from "vitest";
import { wireEditorNavigationKeys } from "./editor-navigation";

describe("wireEditorNavigationKeys", () => {
  it("binds command/control plus arrows to document and line boundaries", () => {
    const commands = new Map<number, () => void>();
    const trigger = vi.fn();
    const target = {
      addCommand: (binding: number, handler: () => void) => {
        commands.set(binding, handler);
        return null;
      },
      trigger
    } as unknown as editor.IStandaloneCodeEditor;

    wireEditorNavigationKeys(target);

    commands.get(KeyMod.CtrlCmd | KeyCode.UpArrow)?.();
    commands.get(KeyMod.CtrlCmd | KeyCode.DownArrow)?.();
    commands.get(KeyMod.CtrlCmd | KeyCode.LeftArrow)?.();
    commands.get(KeyMod.CtrlCmd | KeyCode.RightArrow)?.();

    expect(trigger.mock.calls).toEqual([
      ["keyboard", "cursorTop", null],
      ["keyboard", "cursorBottom", null],
      ["keyboard", "cursorHome", null],
      ["keyboard", "cursorEnd", null]
    ]);
  });
});
