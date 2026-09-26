for (const preview of document.querySelectorAll("[data-seed-preview]")) {
  const design = orbitExplorations.find((item) => item.id === preview.dataset.seedPreview);
  preview.closest(".iteration-card").style.cssText = `--scene-ink:${design.ink};--scene-accent:${design.accent};--scene-paper:${design.sky};--scene-ground:${design.foreground}`;
  preview.insertAdjacentHTML("afterbegin", orbitScene(design, "seed"));
}

for (const design of orbitSpaceExplorations) {
  const grid = document.querySelector(`#lineage-${design.lineage} .iteration-card-grid`);
  const card = document.createElement("a");
  card.className = `iteration-card exploration-card ${design.light ? "scene-light" : "scene-dark"}`;
  card.href = `iterations/explore.html?design=${design.id}`;
  card.style.cssText = `--scene-ink:${design.ink};--scene-accent:${design.accent};--scene-paper:${design.sky};--scene-ground:${design.foreground}`;
  card.innerHTML = `<div class="iteration-preview exploration-preview">${orbitScene(design, "card")}<span>${design.motif.toUpperCase()}</span></div>
    <div class="iteration-card-body"><div><small>${design.family} · ${design.lineage.toUpperCase()} EXPERIMENT</small><h3>${design.name}</h3><p>${design.note}</p></div><span class="iteration-card-arrow" aria-hidden="true">↗</span></div>`;
  grid.append(card);
}
