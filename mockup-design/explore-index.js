for (const [index, group] of orbitDetailedGroups.entries()) {
  const seed = orbitExplorations.find((design) => design.id === group.seed);
  const cluster = document.createElement("div");
  cluster.className = "iteration-cluster";
  cluster.id = `lineage-${group.group}`;
  cluster.innerHTML = `<div class="cluster-heading"><span>${String(index + 1).padStart(2, "0")} / ${group.group.toUpperCase()}</span><h3>${seed.name} · a world of its own.</h3></div><div class="iteration-card-grid"></div>`;
  const grid = cluster.querySelector(".iteration-card-grid");
  for (const design of [seed, ...orbitDetailedExplorations.filter((item) => item.parent === seed.id)]) {
    const card = document.createElement("a");
    const isSeed = design === seed;
    card.className = `iteration-card exploration-card ${isSeed ? "seed-card" : ""} ${design.light ? "scene-light" : "scene-dark"}`;
    card.href = `iterations/explore.html?design=${design.id}`;
    card.style.cssText = `--scene-ink:${design.ink};--scene-accent:${design.accent};--scene-paper:${design.sky};--scene-ground:${design.foreground}`;
    card.innerHTML = `<div class="iteration-preview exploration-preview">${orbitAtmosphere(design, "card")}<span>${isSeed ? "SELECTED STARTING POINT" : design.motif.toUpperCase()}</span></div>
      <div class="iteration-card-body"><div><small>${design.family} · ${isSeed ? "FAVORITE" : "NEW LANDSCAPE"}</small><h3>${design.name}</h3><p>${isSeed ? "Saved before this round in the reference archive." : design.note}</p></div><span class="iteration-card-arrow" aria-hidden="true">↗</span></div>`;
    grid.append(card);
  }
  document.querySelector(`#detail-${seed.family}`).append(cluster);
}
