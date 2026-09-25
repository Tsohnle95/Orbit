import type { RuntimeID } from "@shared/types";
import type { TerminalCommand } from "./terminal";

export function tuiCommandForRuntime(runtimeID: RuntimeID, sessionID: string): TerminalCommand {
  if (runtimeID === "opencode") return { command: "opencode", args: ["--session", sessionID] };
  if (runtimeID === "deepseek") return { command: "dsh", args: ["--profile", "tui", "--resume", sessionID] };
  throw new Error(`TUI is not supported by runtime ${runtimeID}`);
}
