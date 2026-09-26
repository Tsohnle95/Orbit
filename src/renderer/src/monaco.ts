import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import { emmetCSS, emmetHTML } from "emmet-monaco-es";
import { APPEARANCES } from "./appearances";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker?: (moduleId: string, label: string) => Worker;
    };
  }
}

window.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string): Worker {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  }
};

loader.config({ monaco });

emmetHTML(monaco, ["html"]);
emmetCSS(monaco, ["css", "scss", "less"]);

for (const { id, scheme, colors } of APPEARANCES) {
  const legacyColors = id === "kitty" ? {
    "editor.lineHighlightBackground": "#343a5526",
    "editorLineNumber.foreground": "#626b78",
    "editor.selectionBackground": "#2e4d78",
    "diffEditor.insertedTextBackground": "#5bd69a20",
    "diffEditor.removedTextBackground": "#ff4b6720",
    "diffEditor.insertedLineBackground": "#5bd69a14",
    "diffEditor.removedLineBackground": "#ff4b6714",
    "scrollbarSlider.background": "#e7e7ee17",
    "scrollbarSlider.hoverBackground": "#e7e7ee2b"
  } : id === "original" ? {
    "editor.lineHighlightBackground": "#2d2926",
    "editorLineNumber.foreground": "#57534e",
    "editor.selectionBackground": "#4a352c",
    "diffEditor.insertedTextBackground": "#9dc2a11f",
    "diffEditor.removedTextBackground": "#e2988a1f",
    "diffEditor.insertedLineBackground": "#9dc2a117",
    "diffEditor.removedLineBackground": "#e2988a17",
    "scrollbarSlider.hoverBackground": "#ffffff26"
  } : {};
  monaco.editor.defineTheme(`orbit-${id}`, {
    base: scheme === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: colors.syntaxComment.slice(1), fontStyle: "italic" },
      { token: "keyword", foreground: colors.syntaxKeyword.slice(1) },
      { token: "string", foreground: colors.syntaxString.slice(1) },
      { token: "number", foreground: colors.syntaxNumber.slice(1) },
      { token: "type", foreground: colors.icon.slice(1) },
      { token: "function", foreground: colors.syntaxFunction.slice(1) }
    ],
    colors: {
      "editor.background": colors.editorOpaque,
      "editor.foreground": colors.ink,
      "editor.lineHighlightBackground": colors.selected,
      "editorLineNumber.foreground": colors.faint,
      "editorCursor.foreground": colors.accent,
      "editor.selectionBackground": colors.selected,
      "editorGutter.background": colors.editorOpaque,
      "diffEditor.insertedTextBackground": `${colors.good}24`,
      "diffEditor.removedTextBackground": `${colors.danger}24`,
      "diffEditor.insertedLineBackground": `${colors.good}16`,
      "diffEditor.removedLineBackground": `${colors.danger}16`,
      "diffEditorOverview.insertedForeground": `${colors.good}b3`,
      "diffEditorOverview.removedForeground": `${colors.danger}b3`,
      "diffEditor.diagonalFill": colors.editorOpaque,
      "scrollbarSlider.background": scheme === "light" ? "#00000018" : "#ffffff17",
      "scrollbarSlider.hoverBackground": scheme === "light" ? "#0000002b" : "#ffffff2b",
      "minimap.background": colors.editorOpaque,
      ...legacyColors
    }
  });
}

export { monaco };

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  xml: "xml",
  sql: "sql",
  dockerfile: "dockerfile",
  graphql: "graphql",
  vue: "html",
  svelte: "html",
  txt: "plaintext",
  log: "plaintext",
  diff: "diff"
};

export function languageForPath(p: string): string {
  const base = p.split("/").pop() ?? "";
  const lower = base.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return LANGUAGE_BY_EXT[ext] ?? "plaintext";
}
