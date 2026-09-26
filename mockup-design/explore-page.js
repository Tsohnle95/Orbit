const designId = new URLSearchParams(window.location.search).get("design");
const design = orbitExplorations.find((item) => item.id === designId);
const app = document.querySelector("#app");
const sceneMessages = {
  "04-canopy": "Begin in the clearing. Keep the code in view.",
  "04-estuary": "Follow the current from question to change.",
  "04-terrace": "Each layer leads back to the source.",
  "04-topography": "The work has a place on the map.",
  "04-glasshouse": "Context is something worth keeping alive.",
  "04-nocturne": "Stay oriented, even in the deep work.",
  "04-sandstone": "Shape the next change from the code beneath it.",
  "04-mist": "See the next step come into focus.",
  "04-bloom": "Build on the project that is already growing.",
  "04-orbitline": "Every path leads back to the repository.",
  "10-parchment": "Everything you need on the same page.",
  "10-grid": "The right tools, already lined up.",
  "10-lagoon": "Find a rhythm that keeps moving.",
  "10-copper": "Keep the tools warm and the work close.",
  "10-atlas": "A clear route through the day’s work.",
  "10-prism": "Different tools. One shared focus.",
  "10-dusk": "A good place to keep going.",
  "10-studio": "A room for every part of the process.",
  "10-midnight": "See the whole system without losing focus.",
  "10-daybreak": "Start fresh. Stay with the work."
};

if (!design) {
  app.innerHTML = `<main class="missing-design"><h1>That exploration isn't here.</h1><a href="../index.html">See all Orbit designs →</a></main>`;
} else {
  const isRepo = design.family === "04";
  const colors = `--scene-ink:${design.ink};--scene-accent:${design.accent};--scene-paper:${design.sky};--scene-ground:${design.foreground}`;
  document.title = `Orbit — ${design.name}`;
  document.body.classList.add(`explore-${design.family}`, `scene-${design.scene}`, `form-${design.form}`, `type-${design.type}`, design.light ? "scene-light" : "scene-dark");
  document.body.style.cssText = colors;

  const projectDiagram = `<div class="project-map" aria-label="One repository connects the editor, agent, and change review">
    <div class="map-origin"><span class="map-icon">⌁</span><small>OPEN PROJECT</small><strong>~/code/orbit</strong><span>main · local workspace</span></div>
    <div class="map-path" aria-hidden="true"><span></span><span></span><span></span></div>
    <div class="map-destinations"><div><span class="map-key">01 / READ</span><strong>Monaco editor</strong><small>App.tsx ↗</small></div><div><span class="map-key">02 / ASK</span><strong>Agent in context</strong><small>Working in this repo ↗</small></div><div><span class="map-key">03 / REVIEW</span><strong>Changed files</strong><small>3 changes ready ↗</small></div></div>
  </div>`;
  const desktopDock = `<div class="desktop-dock" aria-label="The editor, agent, terminal, and change review share one desk">
    <div class="dock-pane"><span class="dock-glyph">⌘</span><span><small>READ + EDIT</small><strong>Monaco workbench</strong></span><i>01</i></div>
    <div class="dock-pane"><span class="dock-glyph">✳</span><span><small>ASK</small><strong>Agent beside your code</strong></span><i>02</i></div>
    <div class="dock-pane"><span class="dock-glyph">›_</span><span><small>RUN</small><strong>Integrated terminal</strong></span><i>03</i></div>
    <div class="dock-pane"><span class="dock-glyph">±</span><span><small>REVIEW</small><strong>Changes and diffs</strong></span><i>04</i></div>
  </div>`;
  const repoProof = `<div class="proof-visual proof-repo"><div class="proof-window-top"><span>ORBIT / FILES</span><span>main ↗</span></div><div class="proof-folders"><p>⌄ &nbsp; orbit</p><p>⌄ &nbsp; src</p><p class="active">TS &nbsp; App.tsx</p><p>SCSS &nbsp; _layout.scss</p><p>⌄ &nbsp; mockup-design</p></div><div class="proof-focus"><span>App.tsx</span><code><b>const</b> repo = useWorkspace();<br /><b>return</b> &lt;AgentPanel repo={repo} /&gt;;</code></div><div class="proof-window-foot">The same project stays with every tool &nbsp; ↗</div></div>`;
  const deskProof = `<div class="proof-visual proof-desk"><div class="proof-window-top"><span>YOUR WORKSPACE / ACTIVE</span><span>⌘ K</span></div><div class="proof-screen"><div class="screen-editor"><span>App.tsx</span><code><b>export</b> function Workspace() {<br />&nbsp; <i>const</i> root = useRepo();<br />&nbsp; <b>return</b> &lt;Agent context={root} /&gt;;<br />}</code></div><div class="screen-agent"><span class="screen-status"></span> Agent<div>Following the code in your project…</div><small>✓ &nbsp; 2 files opened</small></div></div><div class="proof-terminal"><span>orbit $</span> npm run check &nbsp; <strong>✓ ready</strong></div></div>`;

  app.innerHTML = `
    <header class="explore-nav">
      <a class="explore-brand" href="../index.html"><span aria-hidden="true">◉</span> orbit</a>
      <nav aria-label="Page navigation"><a href="#inside">${isRepo ? "The project" : "The workbench"}</a><a href="#review">The loop</a></nav>
      <button class="theme-toggle" type="button" data-theme-toggle aria-label="Toggle dark mode" aria-pressed="false"><span class="theme-icon" aria-hidden="true">◐</span><span>Dark mode</span></button>
    </header>
    <main>
      <section class="art-hero" aria-labelledby="hero-title">
        ${orbitScene(design)}
        <div class="hero-light" aria-hidden="true"></div>
        <div class="art-hero-content">
          <div class="art-hero-copy">
            <p class="art-kicker"><span class="live-dot"></span>${isRepo ? "YOUR REPOSITORY / YOUR WORKSPACE" : "THE DESKTOP WORKSPACE FOR CODING AGENTS"}</p>
            <h1 id="hero-title">${design.title}</h1>
            <p class="art-lede">${design.lede}</p>
            <div class="art-actions"><a class="art-button" href="#inside">${isRepo ? "Explore the workspace" : "Step inside"}<span aria-hidden="true">↓</span></a><a class="art-secondary" href="#review">See the whole loop <span aria-hidden="true">→</span></a></div>
            <div class="art-facts" aria-label="Orbit workspace features"><span>Repository first</span><span>Monaco editor</span><span>OpenCode V2</span></div>
          </div>
          <figure class="art-product">
            <img src="../assets/orbit-workbench-reference.png" width="1375" height="779" alt="Orbit desktop workbench showing the repository explorer, editor, terminal, and agent panel in one window." />
            <figcaption><span class="live-dot"></span>${isRepo ? "Project open · Files in view" : "One desk · All your tools"}</figcaption>
          </figure>
        </div>
      </section>
      <section class="art-inside" id="inside">
        <div class="art-section-header"><p class="art-section-label">${isRepo ? "01 / THE SOURCE" : "01 / YOUR DESK"}</p><h2>${design.section}</h2><p>${isRepo ? "Orbit starts with a real repository. Your editor, terminal, agent session, and review all stay attached to the folder you chose." : "The desktop workspace puts your code, conversation, terminal, and changes together. No tab shuffle between the important parts."}</p></div>
        ${isRepo ? projectDiagram : desktopDock}
      </section>
      <section class="art-interlude" aria-label="${isRepo ? "The repository stays at the center" : "A connected desktop workspace"}">
        ${orbitScene(design, "interlude")}
        <div class="interlude-copy"><span class="interlude-mark" aria-hidden="true">◉</span><p>${isRepo ? "ONE REPOSITORY / MANY NEXT STEPS" : "ONE DESK / A BETTER RHYTHM"}</p><h2>${sceneMessages[design.id]}</h2></div>
        <div class="interlude-note"><span class="live-dot"></span>${isRepo ? "~/code/orbit · project open" : "Orbit desktop · workspace active"}</div>
      </section>
      <section class="art-review" id="review">
        <div class="review-words"><p class="art-section-label">02 / FROM START TO FINISH</p><h2>${isRepo ? "Follow the work back to its source." : "Stay for the whole coding loop."}</h2><p>${isRepo ? "Read a file, ask a question about it, then open the diff. The work stays legible because it never leaves its project behind." : "Bring a project into view, work alongside the agent, run a command, and review the changes before moving on."}</p><div class="review-sequence"><span>01 &nbsp; OPEN</span><span>02 &nbsp; ASK</span><span>03 &nbsp; REVIEW</span></div></div>
        ${isRepo ? repoProof : deskProof}
      </section>
      <section class="art-close"><div><p class="art-section-label">${isRepo ? "KEEP THE PROJECT CLOSE" : "WORK WHERE THE WORK IS"}</p><h2>${isRepo ? "A clear place to begin." : "Make yourself at home."}</h2></div><a class="art-button" href="#inside">Explore Orbit <span aria-hidden="true">↑</span></a></section>
    </main>
    <footer class="art-footer"><a class="explore-brand" href="../index.html"><span aria-hidden="true">◉</span> orbit</a><span>${isRepo ? "Built around your repository." : "A home for the coding loop."}</span></footer>`;
}
