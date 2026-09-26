const orbitDetailedGroups = [
  {
    seed: "04-nocturne", group: "nocturne", terrain: "alpine", base: { sky: "#121e32", horizon: "#37536a", foreground: "#112635", glow: "#b6d1cf", ink: "#f4f4ed", accent: "#b7ddd0", light: false },
    variants: [
      ["observatory", "High Observatory", "starwatch / alpine valley", "An observatory dome and delicate star trails above textured peaks.", "Keep the project in your sights.", "Watch the whole session without losing the source beneath it.", "observatory", "#b5d6d4"],
      ["umbra", "Umbra", "eclipse / charcoal ridges", "A fine corona casts shadows across dark, layered stone.", "A little light on the hard parts.", "The repository stays visible while the agent works through the unknown.", "eclipse", "#e8e5cf"],
      ["beacon", "Beacon", "distant beacon / polar sky", "A small illuminated peak carries a signal through the night.", "Find the signal in the source.", "Keep the path between question, file, and answer in view.", "beacon", "#a1e2d4"],
      ["meteor", "Meteor Watch", "meteor shower / mountain pass", "Thin luminous trails cross a broad, craggy nightscape.", "Follow the work as it moves.", "See each change land in the project that started the session.", "meteor", "#e2b9ce"],
      ["blue-hour", "Blue Hour", "blue nebula / distant hills", "Dusty blue light and an almost invisible moon soften the peaks.", "The repo stays your north star.", "Give deep work room to breathe without losing your bearings.", "moon", "#b4cceb"]
    ]
  },
  {
    seed: "04-nocturne-tidal", group: "tidal", terrain: "water", base: { sky: "#15283b", horizon: "#52717b", foreground: "#153543", glow: "#d0dfd5", ink: "#f3f5ec", accent: "#b7d9d1", light: false },
    variants: [
      ["silver-current", "Silver Current", "moon path / dark sea", "A silver path of broken reflections travels toward the horizon.", "Keep the current connected.", "From the prompt to the diff, follow the work back to its source.", "moon", "#e5e5d7"],
      ["tidal-rings", "Tidal Rings", "ringed moon / midnight water", "A smaller ringed world hangs above textured waves.", "Come back to the code.", "Let the repository anchor every change made along the way.", "saturn", "#d5dcdb"],
      ["phosphor", "Phosphor", "bioluminescence / shore", "Luminous foam and tiny lights draw a line along the shore.", "Keep a light on the work.", "See the files under every response as the session moves forward.", "crescent", "#9ce0cf"],
      ["moonwake", "Moonwake", "lunar wake / layered surf", "Moonlight stretches into a wide wake across the dark water.", "Every change has a shoreline.", "Review the work exactly where it meets your project.", "moon", "#f1d9c9"],
      ["night-tide", "Night Tide", "eclipse / glassy bay", "A distant eclipse reflects in a glassy, almost still bay.", "Let the details surface.", "Read, ask, and review with the project always in the picture.", "eclipse", "#c7d5ea"]
    ]
  },
  {
    seed: "04-mist", group: "mist", terrain: "mist", base: { sky: "#ecf2ef", horizon: "#bbd0ca", foreground: "#557e78", glow: "#fffdf0", ink: "#294841", accent: "#477b70", light: true },
    variants: [
      ["moonveil", "Moonveil", "pale moon / forest fog", "Pine silhouettes dissolve into luminous, moonlit fog.", "Clarity starts in the project.", "See the next file, question, and change emerge in context.", "moon", "#f8faeb"],
      ["halo-cloud", "Halo Cloud", "orbital halo / silver cloud", "A fine orbital ring glows through a soft silver cloud bank.", "A clear view through the haze.", "Keep code and agent close enough to follow the whole thread.", "saturn", "#e3f3e9"],
      ["quiet-signal", "Quiet Signal", "star chart / misted hills", "Subtle star-chart lines float above rolling pale hills.", "Follow the quiet signals.", "The repository gives each tool and each change a place to belong.", "beacon", "#dcefe7"],
      ["cloudbreak", "Cloudbreak", "sun break / cold ridgeline", "Light breaks through a layered horizon of frosted stone.", "Let the next step appear.", "Move through the work without letting go of the code.", "crescent", "#fff3d4"],
      ["murmur", "Murmur", "faint aurora / conifers", "A barely visible aurora brushes a line of detailed conifers.", "A calmer way to find your place.", "Follow files and edits through a quieter workspace.", "aurora", "#c0e8d0"]
    ]
  },
  {
    seed: "04-mist-planetfall", group: "planetfall", terrain: "mist", base: { sky: "#dce8ec", horizon: "#a3beca", foreground: "#486b80", glow: "#edf8f2", ink: "#2e4a57", accent: "#507e8b", light: true },
    variants: [
      ["arrival", "Arrival", "distant world / blue valley", "A textured world rises over a deep blue valley of mist.", "Land where the work begins.", "Start with the repository and find the next step from there.", "planet", "#eaf0e2"],
      ["small-world", "Small World", "small ringed world / cloud sea", "A distant ringed world floats above overlapping cloud layers.", "Everything still starts here.", "Let the repo keep the bigger picture while the agent explores.", "saturn", "#e0e7e8"],
      ["first-light", "First Light", "orbital dawn / pale mountains", "A narrow planet edge catches the first light of day.", "See the project in a new light.", "Stay oriented from the first question to the final diff.", "horizon", "#f7e9ce"],
      ["far-shore", "Far Shore", "planet and coast / silver haze", "A distant coast and planet sit inside silver atmospheric haze.", "Keep the source within reach.", "Work outward without leaving the project behind.", "planet", "#cbdde0"],
      ["skybridge", "Skybridge", "arc of light / mist", "An orbital arc bridges a wide, pale mountain pass.", "Bring the work back together.", "The agent, editor, and changes meet in the same repository.", "beacon", "#e5f3ee"]
    ]
  },
  {
    seed: "10-dusk-crescent", group: "crescent", terrain: "city", base: { sky: "#292742", horizon: "#70607f", foreground: "#242841", glow: "#e9c8b3", ink: "#f8f2ec", accent: "#eccdbf", light: false },
    variants: [
      ["rooftop", "Rooftop Moon", "crescent / roof garden", "Lit windows and rooftop foliage sit beneath a slender moon.", "A desk worth coming back to.", "Your editor, agent, and terminal have room to share the night.", "crescent", "#e9d1ba"],
      ["violet-hour", "Violet Hour", "violet twilight / city lights", "Violet haze and a moonrise soften the working city.", "Stay with the whole loop.", "Make the next change without leaving your place in the project.", "moon", "#e1b9d1"],
      ["lunar-street", "Lunar Street", "moon path / evening street", "A reflective street runs between quiet rooftops and the sky.", "Keep the work close after dark.", "The project and its tools stay in one working space.", "crescent", "#d7d8d0"],
      ["celestial-block", "Celestial Block", "orbit lines / city block", "Fine orbit lines arc above blocks of softly glowing windows.", "Everything has a place to land.", "Move between tools without leaving the project behind.", "saturn", "#e7c2b4"],
      ["night-window", "Night Window", "moon through window / skyline", "A moonlit skyline is framed like a late-night studio view.", "Make room for focused work.", "Stay with your editor and agent through the session.", "moon", "#e7dfce"]
    ]
  },
  {
    seed: "10-dusk", group: "dusk", terrain: "city", base: { sky: "#21283f", horizon: "#5e637b", foreground: "#1c293d", glow: "#edaa85", ink: "#faf3ed", accent: "#eac0a9", light: false },
    variants: [
      ["after-hours", "After Hours", "starry dusk / rooftop lights", "Tiny city lights meet a richly textured evening sky.", "A good place to keep building.", "The everyday coding loop stays calm even when the day runs long.", "moon", "#f0c29d"],
      ["copper-sky", "Copper Sky", "copper planet / distant city", "Warm atmospheric dust and a small planet cross the skyline.", "A little more room to think.", "Keep code, conversation, and changes in one workspace.", "planet", "#f4b99b"],
      ["urban-aurora", "Urban Aurora", "aurora / city lights", "A restrained aurora drifts over streets and lit windows.", "Let the work move naturally.", "The workbench keeps your tools connected to the project.", "aurora", "#b7dcc9"],
      ["starline", "Starline", "star trail / quiet skyline", "A long star trail rises beyond layered, detailed rooftops.", "One desk for every next step.", "Move from asking to editing to reviewing without changing context.", "meteor", "#d8c4d9"],
      ["low-orbit", "Low Orbit", "small moon / city edge", "A low moon meets a layered city edge at the end of day.", "Stay with the work in front of you.", "All the everyday tools remain within reach.", "horizon", "#ecd6bf"]
    ]
  },
  {
    seed: "10-dusk-orbit", group: "orbit", terrain: "city", base: { sky: "#172036", horizon: "#53617e", foreground: "#152238", glow: "#edb5a1", ink: "#f8f1ed", accent: "#eac3b3", light: false },
    variants: [
      ["satellite", "Satellite Orbit", "small ringed world / satellite", "A tiny satellite visibly travels through a smaller planet's rings.", "Keep the whole desk in orbit.", "Your tools have a shared center: the project you're working on.", "saturn", "#efc2b1"],
      ["ice-rings", "Ice Rings", "icy rings / night city", "A cool blue ring system casts a subtle glow across the city.", "Find your working center.", "Keep code and agent together through every step.", "saturn", "#b6d3e2"],
      ["ember-rings", "Ember Rings", "copper rings / dark skyline", "Copper-colored rings and a warm orb hover beyond rooftops.", "Stay close to the work.", "The editor, session, and changes belong to one desk.", "saturn", "#f0b491"],
      ["twin-orbits", "Twin Orbits", "two satellites / orbital path", "Two small lights trace a fine path around a distant planet.", "Make space for collaboration.", "Follow the session without losing sight of the files.", "saturn", "#d1c8e4"],
      ["outer-ring", "Outer Ring", "distant rings / midnight skyline", "A small planet and wide outer ring sit quietly behind the city.", "Keep the work in motion.", "From the first file to the final review, stay in the same space.", "saturn", "#dfcabd"]
    ]
  }
];

const orbitDetailedExplorations = orbitDetailedGroups.flatMap(({ seed, group, terrain, base, variants }) => {
  const parent = orbitExplorations.find((item) => item.id === seed);
  const colorShift = (hex, amount) => `#${[1, 3, 5].map((offset) => Math.max(0, Math.min(255, parseInt(hex.slice(offset, offset + 2), 16) + amount)).toString(16).padStart(2, "0")).join("")}`;
  const shifts = [-10, 5, -16, 12, -4];
  return variants.map(([slug, name, motif, note, title, lede, celestial, tint], index) => ({
    ...parent, ...base, id: `${seed}-detail-${slug}`, parent: seed, group, terrain,
    name, motif, note, title, lede, celestial, tint, detailIndex: index, atmosphere: true,
    sky: colorShift(base.sky, shifts[index]), horizon: colorShift(base.horizon, shifts[(index + 2) % 5]),
    foreground: colorShift(base.foreground, shifts[(index + 3) % 5]),
    form: ["grounded", "inset", "floating", "framed", "diagram"][index],
    message: `${name}: keep the next step connected to the work.`
  }));
});

const selectedCelestials = ["crescent", "moon", "moon", "planet", "crescent", "moon", "saturn"];
orbitDetailedGroups.forEach(({ seed, terrain }, index) => {
  Object.assign(orbitExplorations.find((item) => item.id === seed), {
    terrain, celestial: selectedCelestials[index], atmosphere: true, detailIndex: index
  });
});

orbitExplorations.push(...orbitDetailedExplorations);
