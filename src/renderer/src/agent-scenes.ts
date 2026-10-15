import citadelWide from "./assets/agent-scenes/citadel-wide.webp";
import citadelTall from "./assets/agent-scenes/citadel-tall.webp";

// Artwork configuration for the agent panel's decorative scenes. Each scene
// pairs a wide composition with a tall crop of the same artwork; the panel
// picks between them by its own width (see `_agent-scene.scss`), so one scene
// reads correctly from the narrowest docked panel to maximized Agent Mode.
// Adding a scene means adding both assets under `assets/agent-scenes/` and an
// entry here.
export interface AgentSceneComposition {
  src: string;
  /** CSS `object-position` for the composition's focal point. */
  position: string;
}

export interface AgentScene {
  id: string;
  label: string;
  /** Full-frame composition for wide panels and Agent Mode. */
  wide: AgentSceneComposition;
  /** Cropped composition that keeps the subject visible in narrow panels. */
  tall: AgentSceneComposition;
}

const citadel: AgentScene = {
  id: "citadel",
  label: "Citadel",
  wide: { src: citadelWide, position: "50% 46%" },
  tall: { src: citadelTall, position: "50% 44%" }
};

export const AGENT_SCENES: readonly AgentScene[] = [citadel];

export const DEFAULT_AGENT_SCENE: AgentScene = citadel;
