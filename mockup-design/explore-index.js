for (const design of orbitExplorations) {
  const grid = document.querySelector(`#direction-${design.family} .iteration-card-grid`);
  const card = document.createElement("a");
  card.className = `iteration-card exploration-card ${design.light ? "scene-light" : "scene-dark"}`;
  card.href = `iterations/explore.html?design=${design.id}`;
  card.style.cssText = `--scene-ink:${design.ink};--scene-accent:${design.accent};--scene-paper:${design.sky};--scene-ground:${design.foreground}`;
  card.innerHTML = `<div class="iteration-preview exploration-preview">${orbitScene(design)}<span>${design.motif.toUpperCase()}</span></div>
    <div class="iteration-card-body"><div><small>${design.family} · NEW</small><h3>${design.name}</h3><p>${design.note}</p></div><span class="iteration-card-arrow" aria-hidden="true">↗</span></div>`;
  grid.append(card);
}
