import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { applyW3cMarkers } from "../w3c-validation";
import type { EditorStatus } from "./editor-status";

const W3C_FILE = /\.(?:html?|css)$/i;

interface ValidateResult {
  errors: number;
  warnings: number;
  failed: boolean;
}

export function StatusBar({ editorStatus = null }: { editorStatus?: EditorStatus | null }): ReactNode {
  const { tabs, activePath } = useStore();
  const activeTab = tabs.find((tab) => tab.path === activePath);
  const cursorStatus = editorStatus?.path === activeTab?.path ? editorStatus : null;
  const w3cFile = activeTab !== undefined && W3C_FILE.test(activeTab.path);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ValidateResult | null>(null);
  const runIdRef = useRef(0);

  useEffect(() => {
    runIdRef.current += 1;
    setRunning(false);
    setResult(null);
  }, [activePath, activeTab?.content]);

  const validate = (): void => {
    if (!activeTab || !w3cFile || running) return;
    const runId = ++runIdRef.current;
    setRunning(true);
    setResult(null);
    void window.openshell.validateW3c(activeTab.path, activeTab.content)
      .then((diagnostics) => {
        if (runId !== runIdRef.current) return;
        applyW3cMarkers(activeTab.path, diagnostics);
        const errors = diagnostics.filter((d) => d.severity === "error").length;
        setRunning(false);
        setResult({ errors, warnings: diagnostics.length - errors, failed: false });
      })
      .catch(() => {
        if (runId !== runIdRef.current) return;
        setRunning(false);
        setResult({ errors: 0, warnings: 0, failed: true });
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

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        {w3cFile && resultText && (
          <span className={`validate-result ${resultTone}`} data-testid="validate-result">
            {resultText}
          </span>
        )}
        {w3cFile && (
          <button
            className="statusbar-btn validate-btn"
            data-testid="validate-btn"
            disabled={running}
            title="Run the W3C Nu Html Checker / CSS Validator on the open file"
            onClick={validate}
          >
            {running && <span className="validate-spinner" aria-hidden="true" />}
            {running ? "Validating…" : "Validate"}
          </button>
        )}
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
