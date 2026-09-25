const directions = [
  {
    id: "01", name: "The desktop download page", reference: "Freebuff Desktop", route: "desktop",
    kicker: "ORBIT / DESKTOP WORKSPACE / IN PROGRESS",
    title: "Code, with your agent already there.",
    description: "Orbit brings a Monaco-powered workbench and an agent panel into the repository you opened. Read, ask, run, and review without leaving the project.",
    featuresTitle: "Keep the whole coding loop close.",
    featuresIntro: "Orbit keeps the repository, editor, agent conversation, terminal, and observed file changes together in one desktop workspace.",
    workflowTitle: "From an open repo to a reviewed change.",
    agentTitle: "More sessions in view. One stays in focus.",
    agentIntro: "The developing direction is an overview for up to eight agent panels, with a clear way to focus one session and return to its repo, transcript, and changes.",
    closing: "A focused home for code and agent work."
  },
  {
    id: "02", name: "The open workbench", reference: "T3 Code", route: "workbench",
    kicker: "A DESKTOP WORKBENCH FOR CODING AGENTS",
    title: "Your repo. Your agent. Same window.",
    description: "Open a project and get straight to work: Monaco in the center, a real terminal nearby, and the default agent panel attached to your current repository.",
    featuresTitle: "A workbench, not another chat tab.",
    featuresIntro: "The editor stays central. The agent has the repository context. Changes stay reviewable in the same workspace.",
    workflowTitle: "Open it. Ask. Check the diff.",
    agentTitle: "Keep the active session close to the code.",
    agentIntro: "Agent mode is growing toward a focused overview of up to eight panels. Pick a session, see what it is doing, and bring its work back to the editor.",
    closing: "Put the agent inside your development loop."
  },
  {
    id: "03", name: "Start · work · review", reference: "OpenChamber", route: "flow",
    kicker: "A REPO-FIRST DEVELOPMENT LOOP",
    title: "Start in your code. Stay for the whole loop.",
    description: "Open your repository, work with its agent, and review the resulting file changes in the same desktop environment.",
    featuresTitle: "Three steps, one workspace.",
    featuresIntro: "Orbit brings project context, agent progress, and file review together so the handoff from one step to the next stays short.",
    workflowTitle: "Start. Work. Review.",
    agentTitle: "Move between sessions, then return to one.",
    agentIntro: "The in-progress Agent mode concept keeps up to eight panels available for a quick scan, then gives the selected session the room to work.",
    closing: "Start with the repo you already have open."
  },
  {
    id: "04", name: "Repository in context", reference: "Repo-first layout", route: "repo",
    kicker: "THE REPOSITORY SETS THE CONTEXT",
    title: "The repo is the starting point.",
    description: "Orbit opens around the project you selected. Browse its files, edit in Monaco, and ask the agent about the code in front of you.",
    featuresTitle: "Everything points back to the project.",
    featuresIntro: "The active folder anchors the editor, terminal, agent session, and change review. Keep the work attached to its source.",
    workflowTitle: "One path from folder to finished change.",
    agentTitle: "Every session needs a clear repo path.",
    agentIntro: "The multi-session direction will make it easier to scan up to eight agent panels while keeping each task’s repository and review context clear.",
    closing: "Keep every question close to its source."
  },
  {
    id: "05", name: "Editor in the foreground", reference: "Workbench-led layout", route: "editor",
    kicker: "MONACO / FILES / OPEN SESSION",
    title: "The code stays in front.",
    description: "Orbit pairs a familiar VS Code-style workspace with an agent panel that starts in the open repo. Bring the conversation to the code, not the other way around.",
    featuresTitle: "A capable editor with the agent in reach.",
    featuresIntro: "Open files, follow streamed work, run the project, and inspect edits without losing your place in the codebase.",
    workflowTitle: "Read the file. Ask the question. Review the answer in code.",
    agentTitle: "A wider overview, with an editor at the center.",
    agentIntro: "Agent mode is developing toward as many as eight visible sessions. Its selected agent should lead cleanly back to the focused Monaco workspace.",
    closing: "Keep your attention where the code is."
  },
  {
    id: "06", name: "Parallel work, made legible", reference: "Agent mode direction", route: "agents",
    kicker: "AGENT MODE / THE NEXT STEP",
    title: "More sessions. One place to focus.",
    description: "Orbit is an agent development environment built around an editor and the repository you opened. Agent mode is taking shape as a calmer way to follow parallel work.",
    featuresTitle: "Build from a real workbench.",
    featuresIntro: "The current app provides the editor, repo-aware agent panel, session stream, terminal, and file changes that the broader view can grow from.",
    workflowTitle: "Scan the work. Focus a session. Review its changes.",
    agentTitle: "Up to eight panels. No eight-box wall.",
    agentIntro: "The concept uses a concise session overview, a clear focus state, and a path back to the selected repo and its diffs. Multi-session presentation is still in progress.",
    closing: "A wider view for work already underway."
  },
  {
    id: "07", name: "The editorial workspace", reference: "Editorial layout", route: "editorial",
    kicker: "A DESKTOP SPACE FOR CODE",
    title: "Room to think. Close to the work.",
    description: "Orbit gives the code room to breathe and keeps its agent nearby. Open a repository, read and edit in Monaco, then follow the change through review.",
    featuresTitle: "A measured rhythm for focused work.",
    featuresIntro: "The workspace brings familiar tools together with enough room to follow a difficult question from source file to finished diff.",
    workflowTitle: "A steady rhythm: open, ask, inspect.",
    agentTitle: "Keep the broad view quiet and useful.",
    agentIntro: "Up to eight panels is the direction for Agent mode. Each should read as a session with a task and status, with detail available when you focus it.",
    closing: "Make space for the part that needs your attention."
  },
  {
    id: "08", name: "Prompt to diff", reference: "Terminal-adjacent layout", route: "terminal",
    kicker: "LOCAL REPOSITORY / ACTIVE SESSION",
    title: "From prompt to diff.",
    description: "Open the project. Ask its agent. Watch the files change. Orbit puts the editor, terminal, and review beside the session doing the work.",
    featuresTitle: "Everything that happens between the prompt and the diff.",
    featuresIntro: "Keep file navigation, commands, session controls, and changed-file review close to the agent’s work in your local project.",
    workflowTitle: "A short route from request to review.",
    agentTitle: "Parallel sessions, kept in their lanes.",
    agentIntro: "The up-to-eight Agent mode direction should show which sessions are active, waiting, or ready for review, then open the selected session in the main workbench.",
    closing: "Stay with the work all the way through."
  },
  {
    id: "09", name: "The product field guide", reference: "Feature guide layout", route: "guide",
    kicker: "ORBIT / PRODUCT GUIDE",
    title: "A familiar editor. An agent in context.",
    description: "A clear look at Orbit: the desktop workbench, the current repository, its OpenCode session, and the changes produced along the way.",
    featuresTitle: "What Orbit puts in the workspace.",
    featuresIntro: "A concise guide to the parts of the app and how they connect during an agent-assisted coding session.",
    workflowTitle: "The working session at a glance.",
    agentTitle: "Agent mode is the next chapter.",
    agentIntro: "The current app has an Agent mode. A clearer overview for up to eight panels is in progress, with the selected session’s workbench as the detail view.",
    closing: "Know where the code is, and what changed."
  },
  {
    id: "10", name: "The everyday coding desk", reference: "Desktop utility layout", route: "utility",
    kicker: "ORBIT / DESKTOP / IN PROGRESS",
    title: "A home for the coding loop.",
    description: "Orbit is a desktop development environment where your editor, project, terminal, and coding agent share one working space.",
    featuresTitle: "Tools for the everyday development loop.",
    featuresIntro: "Bring the repo into view, keep the agent close to its files, and make reviewing changes part of the same session.",
    workflowTitle: "Open a project and keep moving.",
    agentTitle: "Make room for more than one thread.",
    agentIntro: "The developing Agent mode overview explores up to eight panels while preserving a clear, focused place to read and review the active session.",
    closing: "The desktop workspace for the work in front of you."
  }
];

const features = [
  ["01", "Navigate the repository", "Browse the project tree and move among open files while keeping the active workspace in view."],
  ["02", "Edit with Monaco", "Read and edit source in Orbit’s VS Code-style workbench, backed by the Monaco editor."],
  ["03", "Ask the agent in context", "The default agent panel is attached to the repository you opened, so project questions start beside the code."],
  ["04", "Follow workspace changes", "Orbit observes file changes during an active session and makes changed files available for diff review."],
  ["05", "Run commands nearby", "Use the integrated terminal with the active workspace as its working directory."],
  ["06", "Keep sessions distinct", "Move between sessions with their own transcripts and working state, then return to the thread that needs attention."]
];

const workflow = [
  ["01 / OPEN", "Choose a repository", "Open the project folder. Orbit brings up its files and makes the workspace available to the agent."],
  ["02 / WORK", "Ask and iterate", "Send a request, follow the streamed response, and add a follow-up or attachment as the task evolves."],
  ["03 / REVIEW", "Inspect the files", "Open Changes, inspect per-file diffs, then continue in the editor or terminal."]
];

const agentFlow = [
  ["SCAN", "See what needs attention", "A compact status and task summary keeps parallel sessions readable."],
  ["FOCUS", "Bring one session forward", "Open its transcript and repo context in the primary work area."],
  ["REVIEW", "Follow the work to its diff", "Inspect changed files in the editor, then return to the wider session list."]
];

const details = [
  ["Session controls", "Choose from available agents and models, then continue the same conversation with follow-ups."],
  ["Tool permissions", "See permission requests and respond within the active session."],
  ["Attachments and prompts", "Attach relevant files, use slash commands, and respond to structured questions."],
  ["Usage visibility", "Review available provider and session usage details from the app."],
  ["Extensions", "Manage the plugins and skills available in your Orbit setup."],
  ["Appearance", "Choose among the app’s available appearance profiles in Settings."]
];

const questions = [
  ["Is this a screenshot of the real Orbit app?", "Yes. The workbench image is the screenshot supplied for the Orbit redesign. It appears directly on the page without a decorative browser or device frame."],
  ["Does Orbit show eight agent panels today?", "No. Up to eight panels is a design direction for Agent mode and is still in progress. The screenshot shows the current app with one agent panel."],
  ["Which runtime is enabled?", "OpenCode V2 is the runtime enabled in the current Orbit app."],
  ["What is Orbit built around?", "Orbit is an Electron and React desktop app with a Monaco editor, a repository-aware agent workspace, an integrated terminal, and review for observed workspace changes."]
];

const getMarkup = (items, className) => items.map((item) => {
  if (className === "feature-row") {
    return `<article class="${className}"><span class="item-number">${item[0]}</span><div><h3>${item[1]}</h3><p>${item[2]}</p></div></article>`;
  }
  if (className === "workflow-step") {
    return `<li class="${className}"><span class="item-number">${item[0]}</span><h3>${item[1]}</h3><p>${item[2]}</p></li>`;
  }
  if (className === "agent-step") {
    return `<article class="${className}"><span class="item-number">${item[0]}</span><div><h3>${item[1]}</h3><p>${item[2]}</p></div></article>`;
  }
  if (className === "detail-row") {
    return `<article class="${className}"><h3>${item[0]}</h3><p>${item[1]}</p></article>`;
  }
  return `<details class="faq-item"><summary>${item[0]}</summary><p>${item[1]}</p></details>`;
}).join("");

const params = new URLSearchParams(window.location.search);
const requested = params.get("direction") || "01";
const currentIndex = Math.max(0, directions.findIndex((direction) => direction.id === requested));
const current = directions[currentIndex];
document.body.dataset.direction = current.id;
document.title = `Orbit — ${current.name}`;

document.querySelector("#route-number").textContent = current.id;
document.querySelector("#route-name").textContent = current.name;
document.querySelector("#route-reference").textContent = current.reference;
document.querySelector("#hero-kicker").textContent = current.kicker;
document.querySelector("#hero-title").textContent = current.title;
document.querySelector("#hero-description").textContent = current.description;
document.querySelector("#features-title").textContent = current.featuresTitle;
document.querySelector("#features-intro").textContent = current.featuresIntro;
document.querySelector("#workflow-title").textContent = current.workflowTitle;
document.querySelector("#agent-title").textContent = current.agentTitle;
document.querySelector("#agent-intro").textContent = current.agentIntro;
document.querySelector("#closing-title").textContent = current.closing;
document.querySelector("#footer-direction").textContent = `${current.id} / ${current.name}`;

document.querySelector("#feature-list").innerHTML = getMarkup(features, "feature-row");
document.querySelector("#workflow-list").innerHTML = getMarkup(workflow, "workflow-step");
document.querySelector("#agent-flow").innerHTML = getMarkup(agentFlow, "agent-step");
document.querySelector("#details-list").innerHTML = getMarkup(details, "detail-row");
document.querySelector("#faq-list").innerHTML = getMarkup(questions, "faq-item");

const previous = directions[(currentIndex + directions.length - 1) % directions.length];
const next = directions[(currentIndex + 1) % directions.length];
const previousLink = document.querySelector("#previous-route");
const nextLink = document.querySelector("#next-route");
previousLink.href = `variation.html?direction=${previous.id}`;
previousLink.textContent = `← ${previous.id} / ${previous.name}`;
nextLink.href = `variation.html?direction=${next.id}`;
nextLink.textContent = `${next.id} / ${next.name} →`;
