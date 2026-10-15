import { useState, type ReactNode } from "react";
import {
  DEFAULT_AGENT_SCENE,
  type AgentScene,
  type AgentSceneComposition
} from "../agent-scenes";

function SceneImage({
  className,
  composition
}: {
  className: string;
  composition: AgentSceneComposition;
}): ReactNode {
  const [ready, setReady] = useState(false);
  return (
    <img
      className={className}
      src={composition.src}
      data-ready={ready}
      style={{ objectPosition: composition.position }}
      alt=""
      aria-hidden="true"
      draggable={false}
      decoding="async"
      ref={(node) => {
        // A cached or failed image never fires `load` after mount; seed from
        // the synchronous state so the fade only covers the first decode.
        if (node?.complete && !ready) setReady(true);
      }}
      onLoad={() => setReady(true)}
    />
  );
}

// Decorative scene artwork layered behind the agent panel's content (the
// panel's header/scroll/dock stay above it; see `_agent-scene.scss`). The
// layer is inert and hidden from assistive tech, fades in once the artwork
// decodes, and stays invisible if an asset fails to load. `active` marks an
// on-screen conversation, which recedes the artwork so messages stay legible;
// an empty panel shows the scene at full strength.
export function AgentSceneArt({
  scene = DEFAULT_AGENT_SCENE,
  active = false
}: {
  scene?: AgentScene;
  active?: boolean;
}): ReactNode {
  return (
    <div className="agent-scene" data-agent-scene={scene.id} data-active={active} aria-hidden="true">
      <SceneImage className="agent-scene-image agent-scene-wide" composition={scene.wide} />
      <SceneImage className="agent-scene-image agent-scene-tall" composition={scene.tall} />
    </div>
  );
}
