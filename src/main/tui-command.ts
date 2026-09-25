import type { RuntimeID } from "@shared/types";
import type { TerminalCommand } from "./terminal";

export function tuiCommandForRuntime(runtimeID: RuntimeID, sessionID: string): TerminalCommand {
  if (runtimeID === "opencode") return { command: "opencode", args: ["--session", sessionID] };
  throw new Error(`TUI is not supported by runtime ${runtimeID}`);
}
