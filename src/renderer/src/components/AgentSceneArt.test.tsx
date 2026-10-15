import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_SCENE, type AgentScene } from "../agent-scenes";
import { AgentSceneArt } from "./AgentSceneArt";

describe("AgentSceneArt", () => {
  const containers: HTMLDivElement[] = [];

  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));

  afterEach(() => {
    for (const container of containers) container.remove();
    containers.length = 0;
    vi.unstubAllGlobals();
  });

  function mount(element: ReactElement): HTMLDivElement {
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(element));
    return container;
  }

  it("renders the default scene's wide and tall compositions as decorative artwork", () => {
    const container = mount(<AgentSceneArt />);
    const layer = container.querySelector(".agent-scene");

    expect(layer?.getAttribute("aria-hidden")).toBe("true");
    expect(layer?.getAttribute("data-agent-scene")).toBe(DEFAULT_AGENT_SCENE.id);
    expect(layer?.getAttribute("data-active")).toBe("false");

    const wide = container.querySelector<HTMLImageElement>(".agent-scene-wide");
    const tall = container.querySelector<HTMLImageElement>(".agent-scene-tall");
    expect(wide?.getAttribute("src")).toBe(DEFAULT_AGENT_SCENE.wide.src);
    expect(tall?.getAttribute("src")).toBe(DEFAULT_AGENT_SCENE.tall.src);
    expect(wide?.getAttribute("aria-hidden")).toBe("true");
    expect(tall?.getAttribute("alt")).toBe("");
    expect(wide?.style.objectPosition).toBe(DEFAULT_AGENT_SCENE.wide.position);
  });

  it("fades each composition in once it decodes", () => {
    const container = mount(<AgentSceneArt />);
    const image = container.querySelector<HTMLImageElement>(".agent-scene-wide");

    act(() => image?.dispatchEvent(new Event("load")));

    expect(image?.getAttribute("data-ready")).toBe("true");
  });

  it("marks the layer active while a conversation is on screen", () => {
    const container = mount(<AgentSceneArt active />);

    expect(container.querySelector(".agent-scene")?.getAttribute("data-active")).toBe("true");
  });

  it("uses the compositions of an explicitly supplied scene", () => {
    const scene: AgentScene = {
      id: "test-scene",
      label: "Test scene",
      wide: { src: "wide.png", position: "20% 30%" },
      tall: { src: "tall.png", position: "60% 70%" }
    };
    const container = mount(<AgentSceneArt scene={scene} />);

    expect(container.querySelector(".agent-scene")?.getAttribute("data-agent-scene")).toBe("test-scene");
    expect(container.querySelector<HTMLImageElement>(".agent-scene-wide")?.getAttribute("src")).toBe("wide.png");
    expect(container.querySelector<HTMLImageElement>(".agent-scene-tall")?.style.objectPosition).toBe("60% 70%");
  });
});
