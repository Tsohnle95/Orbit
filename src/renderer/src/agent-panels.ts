export const MAX_AGENT_PANELS = 8;

export function agentPanelGrid(panelCount: number): { columns: number; rows: number } {
  if (panelCount < 3) return { columns: Math.max(1, panelCount), rows: 1 };
  return {
    columns: Math.ceil(panelCount / 2),
    rows: 2
  };
}
