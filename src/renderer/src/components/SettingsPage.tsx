import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { CommandOption, McpServerOption, PluginOption, SkillOption } from "@shared/types";
import { useStore } from "../store";
import { APPEARANCES, type ThemeId, useTheme } from "../theme";
import { OrbitMark } from "./OrbitMark";
import { ProviderSettings } from "./ProviderSettings";
import { ServerSettings } from "./ServerSettings";
import type { SettingsSection } from "./SettingsSidebar";

const themes: Array<{ id: ThemeId; name: string; description: string; colors: { base: string; pane: string; editor: string; agent: string; terminal: string; accent: string; good: string; muted: string } }> = APPEARANCES.map(({ id, name, description, colors }) => ({
  id,
  name,
  description,
  colors: { base: colors.base, pane: colors.pane, editor: colors.editor, agent: colors.agent, terminal: colors.console, accent: colors.accent, good: colors.good, muted: colors.muted }
}));

const sectionCopy: Record<SettingsSection, { title: string; description: string }> = {
  appearance: { title: "Appearance", description: "Choose how Orbit looks and how code is presented." },
  plugins: { title: "Plugins", description: "Review commands and skills available in the current workspace." },
  providers: { title: "Providers", description: "Connect model services supported by OpenCode." },
  safety: { title: "Safety", description: "Set permission and follow-up defaults for agent behavior." },
  voice: { title: "Voice", description: "Configure voice input preferences and review availability." },
  model: { title: "Model", description: "Choose the model used by the current workspace." },
  servers: { title: "Servers", description: "See and stop the Vite preview servers running in this app." },
  mobile: { title: "Mobile Setup", description: "Prepare secure access to Orbit from another device." },
  about: { title: "About", description: "Version and product information for this installation." }
};

function SettingRow({ title, detail, control }: { title: string; detail: string; control: ReactNode }): ReactNode {
  return (
    <div className="settings-list-row">
      <div><strong>{title}</strong><small>{detail}</small></div>
      {control}
    </div>
  );
}

export function SettingsPage({ section, onClose }: { section: SettingsSection; onClose: () => void }): ReactNode {
  const { theme, setTheme } = useTheme();
  const {
    session,
    runtimes,
    models,
    currentModel,
    switchModel,
    loadModels,
    refreshRuntimes,
    providerUsage,
    refreshProviderUsage,
    approvalMode,
    toggleApprovalMode,
    followUpBehavior,
    setFollowUpBehavior
  } = useStore();
  const [commands, setCommands] = useState<CommandOption[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerOption[]>([]);
  const [plugins, setPlugins] = useState<PluginOption[]>([]);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [openCodeAction, setOpenCodeAction] = useState<"sync" | "update" | null>(null);
  const [openCodeFeedback, setOpenCodeFeedback] = useState("");
  const copy = sectionCopy[section];
  const runtime = (runtimes ?? []).find((item) => item.id === (session?.runtimeID ?? "opencode"));
  const openCodeRuntime = (runtimes ?? []).find((item) => item.id === "opencode");

  const runOpenCodeAction = async (action: "sync" | "update"): Promise<void> => {
    if (openCodeAction) return;
    const intent = action === "update"
      ? "OpenCode will update its global CLI using its own updater. Orbit will then restart the shared OpenCode service to match."
      : "Orbit will restart the shared OpenCode service so it matches the installed CLI.";
    if (!window.confirm(`${intent}\n\nActive agent runs in Orbit or other OpenCode apps may be interrupted. Continue?`)) return;
    setOpenCodeAction(action);
    setOpenCodeFeedback("");
    try {
      const result = action === "update"
        ? await window.openshell.updateOpenCode()
        : await window.openshell.syncOpenCode();
      await refreshRuntimes().catch(() => []);
      setOpenCodeFeedback(action === "update"
        ? result.cliUpdated
          ? `Updated OpenCode from ${result.previousVersion} to ${result.version}. Orbit is synced.`
          : `OpenCode ${result.version} is already current. Orbit is synced.`
        : `Orbit is synced to OpenCode ${result.version}.`);
    } catch (error) {
      setOpenCodeFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setOpenCodeAction(null);
    }
  };

  useEffect(() => {
    if (section !== "model") return;
    void refreshRuntimes().catch(() => {});
    if (session) void loadModels(session.workspace);
  }, [section, session?.workspace, refreshRuntimes, loadModels]);

  useEffect(() => {
    if (section !== "plugins") return;
    if (!session) {
      setCommands([]);
      setMcpServers([]);
      setPlugins([]);
      setSkills([]);
      return;
    }
    void window.openshell.commands(session.workspace).then(setCommands).catch(() => setCommands([]));
    void window.openshell.mcpList(session.workspace).then(setMcpServers).catch(() => setMcpServers([]));
    void window.openshell.pluginsList(session.workspace).then(setPlugins).catch(() => setPlugins([]));
    void window.openshell.skillsList(session.workspace).then(setSkills).catch(() => setSkills([]));
  }, [section, session]);

  useEffect(() => {
    if (section === "providers" && session) void refreshProviderUsage();
  }, [section, session?.id, refreshProviderUsage]);

  return (
    <main className="settings-page">
      <header className="settings-page-header">
        <div className="settings-page-brand"><OrbitMark size={34} /></div>
        <div>
          <p className="settings-page-kicker">Orbit preferences</p>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
        <button className="settings-close" onClick={onClose}>Back to workspace</button>
      </header>

      {section === "appearance" && <section className="settings-section" aria-label="Appearance settings">
        <div className="theme-grid" role="radiogroup" aria-label="Color theme">
          {themes.map((option) => (
            <button
              key={option.id}
              className={`theme-card ${theme === option.id ? "selected" : ""}`}
              role="radio"
              aria-checked={theme === option.id}
              onClick={() => setTheme(option.id)}
            >
              <span
                className="theme-preview"
                style={{
                  "--preview-base": option.colors.base,
                  "--preview-pane": option.colors.pane,
                  "--preview-editor": option.colors.editor,
                  "--preview-agent": option.colors.agent,
                  "--preview-terminal": option.colors.terminal,
                  "--preview-accent": option.colors.accent,
                  "--preview-good": option.colors.good,
                  "--preview-muted": option.colors.muted
                } as CSSProperties}
              >
                <span className="theme-preview-rail" />
                <span className="theme-preview-sidebar" />
                <span className="theme-preview-editor"><i /><i /><i /></span>
                <span className="theme-preview-agent" />
                <span className="theme-preview-terminal" />
              </span>
              <span className="theme-card-copy"><strong>{option.name}</strong><small>{option.description}</small></span>
              <span className="theme-swatches">{[option.colors.base, option.colors.pane, option.colors.accent, option.colors.good, option.colors.muted].map((color) => <i key={color} style={{ background: color }} />)}</span>
              <span className="theme-check">{theme === option.id ? "Selected" : "Select"}</span>
            </button>
          ))}
        </div>
      </section>}

      {section === "plugins" && <section className="settings-section">
        <div className="settings-list">
          {commands.length === 0 ? <div className="settings-empty">No workspace commands or skills were reported.</div> : commands.map((command) => (
            <SettingRow key={`${command.kind}:${command.name}`} title={command.name} detail={command.description ?? "No description provided."} control={<span className="settings-badge">{command.kind ?? "command"}</span>} />
          ))}
        </div>
        <h2 className="settings-group-title">Skills</h2>
        <div className="settings-list">
          {skills.length === 0 ? <div className="settings-empty">No skills are available in this workspace.</div> : skills.map((skill) => (
            <SettingRow key={skill.id} title={skill.name} detail={skill.description ?? skill.location ?? "No description provided."} control={<span className="settings-badge">{skill.slash ? "slash" : "skill"}</span>} />
          ))}
        </div>
        <h2 className="settings-group-title">Plugins</h2>
        <div className="settings-list">
          {plugins.length === 0 ? <div className="settings-empty">No plugins are active in this workspace.</div> : plugins.map((plugin) => (
            <SettingRow key={plugin.id} title={plugin.id} detail={`Source: ${plugin.source}`} control={<span className="settings-badge">{plugin.status}</span>} />
          ))}
        </div>
        <h2 className="settings-group-title">MCP servers</h2>
        <div className="settings-list">
          {mcpServers.length === 0 ? <div className="settings-empty">No MCP servers are configured for this workspace.</div> : mcpServers.map((server) => (
            <SettingRow key={server.name} title={server.name} detail="Managed by the OpenCode runtime." control={<span className={`settings-badge ${server.status === "connected" ? "available" : ""}`}>{server.status}</span>} />
          ))}
        </div>
      </section>}

      {section === "providers" && <section className="settings-section">
        {runtime && !runtime.capabilities.providerCredentials
          ? <div className="settings-callout"><strong>Managed by {runtime.name}</strong><p>This runtime does not expose provider credential editing through Orbit. Configure credentials in the runtime, then refresh its model list here.</p></div>
          : <ProviderSettings workspace={session?.workspace ?? null} usage={providerUsage} refreshModels={() => loadModels(session?.workspace)} />}
      </section>}

      {section === "safety" && <section className="settings-section">
        <div className="settings-list">
          {(!runtime || runtime.capabilities.permissions) && <SettingRow
            title="Tool permissions"
            detail="Choose whether agent tool actions need confirmation."
            control={<span className="settings-segmented"><button className={approvalMode !== "approve" ? "on" : ""} onClick={() => approvalMode === "approve" && toggleApprovalMode()}>Ask</button><button className={approvalMode === "approve" ? "on" : ""} onClick={() => approvalMode !== "approve" && toggleApprovalMode()}>Approve</button></span>}
          />}
          {(!runtime || runtime.capabilities.steering) && <SettingRow
            title="Follow-up behavior"
            detail="Queue new prompts or use them to steer active work."
            control={<span className="settings-segmented"><button className={followUpBehavior !== "steer" ? "on" : ""} onClick={() => setFollowUpBehavior("queue")}>Queue</button><button className={followUpBehavior === "steer" ? "on" : ""} onClick={() => setFollowUpBehavior("steer")}>Steer</button></span>}
          />}
        </div>
      </section>}

      {section === "voice" && <section className="settings-section">
        <div className="settings-list">
          <SettingRow title="Voice input" detail="Voice transcription is not included in this build. Controls will appear here when a voice service is available." control={<span className="settings-badge">Unavailable</span>} />
        </div>
      </section>}

      {section === "model" && <section className="settings-section">
        <div className="settings-list">
          <SettingRow
            title="Default model"
            detail={session ? `Used for new prompts in ${session.directory}.` : "Open a workspace to choose its default model."}
            control={<select className="settings-select" value={currentModel ? `${currentModel.providerID}:${currentModel.id}` : ""} disabled={!session || models.length === 0} onChange={(event) => {
              const model = models.find((option) => `${option.providerID}:${option.id}` === event.target.value);
              if (model) void switchModel(model.id, model.providerID, model.variant);
            }}><option value="">{models.length === 0 ? "No models available" : "Select a model"}</option>{models.map((model) => <option key={`${model.providerID}:${model.id}`} value={`${model.providerID}:${model.id}`}>{model.name} · {model.providerID}</option>)}</select>}
          />
        </div>
        <h2 className="settings-group-title">OpenCode</h2>
        <div className="settings-callout"><strong>Orbit uses the global OpenCode CLI.</strong><p>Sync and update restart the shared OpenCode service. Active runs in Orbit or other OpenCode apps may be interrupted.</p></div>
        <div className="settings-list">
          <SettingRow
            title="Installed CLI"
            detail="The version resolved from Orbit's PATH."
            control={<span className="settings-badge">{openCodeRuntime?.version ?? "Not found"}</span>}
          />
          <SettingRow
            title="Sync installed version"
            detail="Restart the shared service to use the CLI version already installed."
            control={<button className="settings-action-button" disabled={!openCodeRuntime?.version || openCodeAction !== null} onClick={() => void runOpenCodeAction("sync")}>{openCodeAction === "sync" ? "Syncing…" : "Sync"}</button>}
          />
          <SettingRow
            title="Update to latest"
            detail="Run OpenCode's updater for its detected install method, then sync the service."
            control={<button className="settings-action-button" disabled={!openCodeRuntime?.version || openCodeAction !== null} onClick={() => void runOpenCodeAction("update")}>{openCodeAction === "update" ? "Updating…" : "Update"}</button>}
          />
        </div>
        {openCodeFeedback && <p className="settings-action-feedback" role="status" aria-live="polite">{openCodeFeedback}</p>}
      </section>}

      {section === "servers" && <ServerSettings />}

      {section === "mobile" && <section className="settings-section">
        <div className="settings-callout"><strong>Mobile access is on while Orbit is open.</strong><p>Orbit runs the mobile server for as long as this app is open, and stops it when you quit. Sessions are shared: pick up a conversation on the phone where you left off on desktop, and start new ones from either. On your phone, connect to this Mac's Tailscale address at port 3011 (for example <code>http://100.x.y.z:3011</code>) using your mobile password. If the phone can't connect, make sure Orbit is running.</p></div>
      </section>}

      {section === "about" && <section className="settings-section">
        <div className="settings-about"><OrbitMark size={72} /><div><h2>Orbit</h2><p>Version 0.1.0</p><small>A native desktop cockpit for coding agents.</small></div></div>
      </section>}
    </main>
  );
}
