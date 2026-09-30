import { useEffect, useRef, useState, type ReactNode } from "react";
import type { W3cDiagnostic } from "@shared/types";
import { useStore } from "../store";
import { applyW3cMarkers, clearW3cMarkers } from "../w3c-validation";
import type { ValidationReport } from "../validation-report";
import type { EditorStatus } from "./editor-status";

const W3C_FILE = /\.(?:html?|css)$/i;

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
  const w3cFile = activeTab !== undefined && W3C_FILE.test(activeTab.path);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ValidateResult | null>(null);
  const [markersShown, setMarkersShown] = useState(false);
  const runIdRef = useRef(0);

  useEffect(() => {
    runIdRef.current += 1;
    setRunning(false);
    setResult(null);
    setMarkersShown(false);
  }, [activePath, activeTab?.content]);

  const validate = (): void => {
    if (!activeTab || !w3cFile || running) return;
    if (result && !result.failed && result.diagnostics.length > 0) {
      if (markersShown) clearW3cMarkers(activeTab.path);
      else applyW3cMarkers(activeTab.path, result.diagnostics);
      setMarkersShown(!markersShown);
      return;
    }
    const runId = ++runIdRef.current;
    setRunning(true);
    setResult(null);
    void window.openshell.validateW3c(activeTab.path, activeTab.content)
      .then((diagnostics) => {
        if (runId !== runIdRef.current) return;
        applyW3cMarkers(activeTab.path, diagnostics);
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
      ? markersShown ? "Hide squiggles" : "Show squiggles"
      : result ? "Validate again" : "Validate";
  const validationTitle = !w3cFile
    ? "Open an HTML or CSS file to run validation"
    : canToggleMarkers
      ? markersShown ? "Hide validation squiggles" : "Show validation squiggles"
      : "Run the W3C Nu Html Checker / CSS Validator on the open file";

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        {w3cFile && resultText && (
          <span className={`validate-result ${resultTone}`} data-testid="validate-result">
            {resultText}
          </span>
        )}
        <button
          className="statusbar-btn validate-btn"
          data-testid="validate-btn"
          disabled={!w3cFile || running}
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
