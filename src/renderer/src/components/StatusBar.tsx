import { useEffect, useRef, useState, type ReactNode } from "react";
import type { W3cDiagnostic } from "@shared/types";
import { useStore } from "../store";
import { applyW3cMarkers, clearW3cMarkers } from "../w3c-validation";
import { monaco } from "../monaco";
import { getEditor } from "../reveal";
import type { ValidationReport } from "../validation-report";
import type { EditorStatus } from "./editor-status";

const W3C_FILE = /\.(?:html?|css)$/i;
const SCSS_FILE = /\.scss$/i;

function scssDiagnostics(path: string): W3cDiagnostic[] {
  const model = getEditor(path)?.getModel();
  if (!model || model.isDisposed() || model.getLanguageId() !== "scss") return [];
  return monaco.editor.getModelMarkers({ resource: model.uri })
    .filter((marker) => marker.owner === "scss" && (marker.severity === monaco.MarkerSeverity.Error || marker.severity === monaco.MarkerSeverity.Warning))
    .map((marker) => ({
      line: marker.startLineNumber,
      column: marker.startColumn,
      endLine: marker.endLineNumber,
      endColumn: marker.endColumn,
      message: marker.message,
      severity: marker.severity === monaco.MarkerSeverity.Warning ? "warning" : "error",
      source: "monaco-scss"
    }));
}

function setValidationDecorations(path: string, visible: boolean): void {
  getEditor(path)?.updateOptions({ renderValidationDecorations: visible ? "on" : "off" });
}

interface ValidateResult {
  errors: number;
  warnings: number;
  failed: boolean;
  diagnostics: W3cDiagnostic[];
}

export function StatusBar({
  editorStatus = null,
  onValidationComplete
}: {
  editorStatus?: EditorStatus | null;
  onValidationComplete?: (report: ValidationReport) => void;
}): ReactNode {
  const { tabs, activePath } = useStore();
  const activeTab = tabs.find((tab) => tab.path === activePath);
  const cursorStatus = editorStatus?.path === activeTab?.path ? editorStatus : null;
  const scssFile = activeTab !== undefined && SCSS_FILE.test(activeTab.path);
  const w3cFile = activeTab !== undefined && W3C_FILE.test(activeTab.path);
  const validatableFile = w3cFile || scssFile;
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ValidateResult | null>(null);
  const [markersShown, setMarkersShown] = useState(false);
  const runIdRef = useRef(0);

  useEffect(() => {
    runIdRef.current += 1;
    if (activePath) setValidationDecorations(activePath, true);
    setRunning(false);
    setResult(null);
    setMarkersShown(false);
  }, [activePath, activeTab?.content]);

  useEffect(() => () => {
    if (activePath) setValidationDecorations(activePath, true);
  }, [activePath]);

  const validate = (): void => {
    if (!activeTab || !validatableFile || running) return;
    if (result && !result.failed && result.diagnostics.length > 0) {
      const show = !markersShown;
      if (scssFile) setValidationDecorations(activeTab.path, show);
      else if (show) applyW3cMarkers(activeTab.path, result.diagnostics);
      else clearW3cMarkers(activeTab.path);
      setMarkersShown(show);
      return;
    }
    const runId = ++runIdRef.current;
    setRunning(true);
    setResult(null);
    const validation = scssFile
      ? Promise.resolve(scssDiagnostics(activeTab.path))
      : window.openshell.validateW3c(activeTab.path, activeTab.content);
    void validation
      .then((diagnostics) => {
        if (runId !== runIdRef.current) return;
        if (scssFile) setValidationDecorations(activeTab.path, true);
        else applyW3cMarkers(activeTab.path, diagnostics);
        const errors = diagnostics.filter((d) => d.severity === "error").length;
        setRunning(false);
        setResult({ errors, warnings: diagnostics.length - errors, failed: false, diagnostics });
        setMarkersShown(diagnostics.length > 0);
        onValidationComplete?.({ path: activeTab.path, diagnostics });
      })
      .catch((error: unknown) => {
        if (runId !== runIdRef.current) return;
        setRunning(false);
        setResult({ errors: 0, warnings: 0, failed: true, diagnostics: [] });
        onValidationComplete?.({
          path: activeTab.path,
          diagnostics: [],
          error: error instanceof Error ? error.message : String(error)
        });
      });
  };

  const resultText = result
    ? result.failed
      ? "Validation failed"
      : result.errors > 0
        ? `${result.errors} error${result.errors === 1 ? "" : "s"}${result.warnings > 0 ? `, ${result.warnings} warning${result.warnings === 1 ? "" : "s"}` : ""}`
        : result.warnings > 0
          ? `${result.warnings} warning${result.warnings === 1 ? "" : "s"}`
          : "No problems"
    : null;

  const resultTone = result
    ? result.failed
      ? "failed"
      : result.errors > 0
        ? "has-errors"
        : result.warnings > 0
          ? "has-warnings"
          : "clean"
    : "";
  const canToggleMarkers = Boolean(result && !result.failed && result.diagnostics.length > 0);
  const validationLabel = running
    ? "Validating…"
    : canToggleMarkers
    ? markersShown ? "Hide errors" : "Show errors"
      : result ? "Validate again" : "Validate";
  const validationTitle = !validatableFile
    ? "Open an HTML, CSS, or SCSS file to run validation"
    : canToggleMarkers
      ? markersShown ? "Hide errors" : "Show errors"
      : scssFile ? "Show Sass diagnostics from the SCSS language service" : "Run the W3C Nu Html Checker / CSS Validator on the open file";

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        {validatableFile && resultText && (
          <span className={`validate-result ${resultTone}`} data-testid="validate-result">
            {resultText}
          </span>
        )}
        <button
          className="statusbar-btn validate-btn"
          data-testid="validate-btn"
          disabled={!validatableFile || running}
          title={validationTitle}
          onClick={validate}
        >
          {running && <span className="validate-spinner" aria-hidden="true" />}
          {validationLabel}
        </button>
      </div>
      <div className="statusbar-right">
        {activeTab && (
          <>
            <span className="statusbar-item statusbar-metadata" data-testid="cursor-position">
              Ln {cursorStatus?.lineNumber ?? 1}, Col {cursorStatus?.column ?? 1}
            </span>
            <span className="statusbar-item statusbar-metadata" data-testid="indentation-status">
              {cursorStatus?.insertSpaces === false ? "Tab Size" : "Spaces"}: {cursorStatus?.tabSize ?? 2}
            </span>
            <span className="statusbar-item statusbar-metadata" data-testid="encoding-status">UTF-8</span>
            <span className="statusbar-item statusbar-path" title={activeTab.path}>
              {activeTab.path}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
