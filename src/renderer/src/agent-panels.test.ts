import { describe, expect, it } from "vitest";
import { agentPanelGrid, MAX_AGENT_PANELS } from "./agent-panels";

describe("agent panel limits and grid", () => {
  it("supports eight panels in a two-row grid", () => {
    expect(MAX_AGENT_PANELS).toBe(8);
    expect(agentPanelGrid(8)).toEqual({ columns: 4, rows: 2 });
  });

  it.each([
    [1, { columns: 1, rows: 1 }],
    [2, { columns: 2, rows: 1 }],
    [3, { columns: 2, rows: 2 }],
    [4, { columns: 2, rows: 2 }],
    [5, { columns: 3, rows: 2 }],
    [6, { columns: 3, rows: 2 }],
    [7, { columns: 4, rows: 2 }]
  ])("lays out %i panels", (count, expected) => {
    expect(agentPanelGrid(count as number)).toEqual(expected);
  });
});
