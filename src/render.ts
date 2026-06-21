// Pure-ish rendering for the workspace: project strip, agent grid (with depth
// decks), and the macro golden-spiral view. Driven by a RenderCtx the App builds,
// so this module holds no state.
import { Agent } from "./agent";
import { Project, goldenSpiral, goldenSpiralPath } from "./project";
import { SavedProject } from "./persistence";
import { t } from "./i18n";

export type Mode = "overview" | "zoom";
export type View = "project" | "macro";
export type PermMode = "auto" | "normal" | "bypass";

export interface RenderCtx {
  grid: HTMLElement;
  macroEl: HTMLElement;
  stripEl: HTMLElement;
  countEl: HTMLElement;
  btnLayout: HTMLElement;
  btnGuard: HTMLElement;
  btnNest: HTMLElement;
  permSelect: HTMLSelectElement;
  projects: Project[];
  ap: number;
  focused: number;
  mode: Mode;
  view: View;
  layout: "square" | "fit";
  permMode: PermMode;
  guardrails: boolean;
  subagentNest: boolean;
  saved: SavedProject[];
  selectProject(i: number): void;
  setLayer(agent: Agent, li: number, ai: number): void;
  addLayer(agent: Agent, kind: "terminal" | "browser", ai: number): void;
  closeLayer(agent: Agent, li: number, ai: number): void;
  openFolder(): void;
  clone(): void;
  openSaved(sp: SavedProject): void;
  removeSaved(path: string): void;
  renameSaved(path: string): void;
  afterRender(): void;
}

export function renderAll(c: RenderCtx) {
  const total = c.projects.reduce((s, p) => s + p.agents.length, 0);
  c.countEl.textContent = `${total} ${t("unit.agents")} · ${c.projects.length} ${t("unit.proj")}`;
  c.permSelect.value = c.permMode;
  setToggleBtn(c.btnGuard, `${t("guard.label")}: ${c.guardrails ? t("on") : t("off")}`, c.guardrails);
  setToggleBtn(c.btnNest, `${t("nest.label")}: ${c.subagentNest ? t("on") : t("off")}`, c.subagentNest);
  renderStrip(c);

  if (c.projects.length === 0) {
    c.macroEl.classList.add("hidden");
    c.grid.classList.remove("hidden");
    renderEmpty(c);
    c.afterRender();
    return;
  }
  c.grid.classList.remove("grid-empty");

  if (c.view === "macro") {
    c.grid.classList.add("hidden");
    c.macroEl.classList.remove("hidden");
    renderMacro(c);
    c.afterRender();
    return;
  }
  c.macroEl.classList.add("hidden");
  c.grid.classList.remove("hidden");
  c.grid.classList.toggle("mode-zoom", c.mode === "zoom");
  c.grid.classList.toggle("mode-overview", c.mode === "overview");

  const agents = c.projects[c.ap]?.agents ?? [];
  // Only re-attach cards when the set/order actually changed. Re-attaching on
  // every render (e.g. on focus) would detach the title mid-gesture and break
  // its double-click-to-rename.
  const cards = agents.map((a) => a.cardEl);
  const cur = c.grid.children;
  let sameCards = cur.length === cards.length;
  for (let i = 0; sameCards && i < cards.length; i++) if (cur[i] !== cards[i]) sameCards = false;
  if (!sameCards) c.grid.replaceChildren(...cards);

  const n = agents.length;
  if (c.layout === "square" && n > 0) {
    const cols = bestCols(n, c.grid.clientWidth, c.grid.clientHeight);
    const rows = Math.ceil(n / cols);
    c.grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    c.btnLayout.textContent = `▦ ${cols}×${rows}`;
  } else {
    c.grid.style.gridTemplateColumns = "";
    c.btnLayout.textContent = `▦ ${t("layout.fit")}`;
  }

  agents.forEach((agent, ai) => {
    agent.cardEl.classList.toggle("focused", ai === c.focused);
    agent.cardEl.classList.toggle("zoomed", c.mode === "zoom" && ai === c.focused);
    agent.cardEl.classList.toggle("hidden", c.mode === "zoom" && ai !== c.focused);
    if (agent.titleEl.contentEditable !== "true" && agent.titleEl.textContent !== agent.title)
      agent.titleEl.textContent = agent.title; // only when changed (don't disrupt dblclick)
    agent.branchEl.textContent = agent.branch ? `⎇ ${agent.branch}` : "";
    agent.branchEl.style.display = agent.branch ? "" : "none";

    let behindRank = 0;
    agent.layers.forEach((layer, li) => {
      if (layer.el.parentElement !== agent.stackEl) agent.stackEl.appendChild(layer.el);
      const isFront = li === agent.active;
      layer.el.classList.toggle("front", isFront);
      layer.el.classList.toggle("behind", !isFront);
      if (!isFront) {
        behindRank++;
        layer.el.style.setProperty("--d", String(Math.min(behindRank, 3)));
      } else {
        layer.el.style.removeProperty("--d");
      }
    });

    renderLayerTabs(c, agent, ai);
  });

  c.afterRender();
}

function renderLayerTabs(c: RenderCtx, agent: Agent, ai: number) {
  agent.tabsEl.replaceChildren();
  agent.layers.forEach((layer, li) => {
    const tab = document.createElement("button");
    tab.className = "ltab" + (li === agent.active ? " active" : "");
    if (layer.kind === "subagent") {
      const ic = document.createElement("span");
      ic.className = "ltab-emoji";
      ic.textContent = "🤖";
      tab.appendChild(ic);
    } else {
      tab.appendChild(layerIcon(layer.kind));
    }
    const label = document.createElement("span");
    label.className = "ltab-label";
    label.textContent = layer.title;
    tab.appendChild(label);
    tab.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      c.setLayer(agent, li, ai);
    });
    if (li === agent.active && agent.layers.length > 1) {
      const x = document.createElement("span");
      x.className = "ltab-x";
      x.textContent = "×";
      x.title = t("tip.layerClose");
      x.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        c.closeLayer(agent, li, ai);
      });
      tab.appendChild(x);
    }
    agent.tabsEl.appendChild(tab);
  });

  for (const [kind, tipKey] of [
    ["terminal", "tip.addTerm"],
    ["browser", "tip.addBrowser"],
  ] as const) {
    const add = document.createElement("button");
    add.className = "ltab-add";
    add.title = t(tipKey);
    add.append(document.createTextNode("＋"), layerIcon(kind));
    add.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      c.addLayer(agent, kind, ai);
    });
    agent.tabsEl.appendChild(add);
  }
}

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  return el;
}

/// Minimal monochrome line icons (inherit currentColor): terminal = `>_`,
/// browser = globe. Recognizable at a glance, still understated.
function layerIcon(kind: "terminal" | "browser"): SVGElement {
  const svg = svgEl("svg", { class: "ltab-ico", viewBox: "0 0 16 16" });
  if (kind === "browser") {
    svg.append(
      svgEl("circle", { cx: 8, cy: 8, r: 6 }),
      svgEl("ellipse", { cx: 8, cy: 8, rx: 2.6, ry: 6 }),
      svgEl("line", { x1: 2, y1: 8, x2: 14, y2: 8 })
    );
  } else {
    svg.append(
      svgEl("polyline", { points: "3,4 7,8 3,12" }),
      svgEl("line", { x1: 8.5, y1: 12, x2: 13, y2: 12 })
    );
  }
  return svg;
}

// Choose a column count that fills the window with well-proportioned cells:
// for each candidate, fit the largest target-aspect (≈1.6 landscape) cell and
// keep the count that yields the biggest cell. Wider windows -> more columns.
function bestCols(n: number, W: number, H: number): number {
  if (!W || !H) return Math.ceil(Math.sqrt(n));
  const target = 1.6;
  let best = 1;
  let bestScore = -Infinity;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = W / cols;
    const ch = H / rows;
    const w = Math.min(cw, ch * target); // largest target-aspect cell that fits
    const score = (w * w) / target; // its area
    if (score > bestScore + 0.5) {
      bestScore = score;
      best = cols;
    }
  }
  return best;
}

/// First-run / no-projects state: guide the user to open a folder, clone, or
/// reopen a saved project (label + path). Rendered into the grid area.
function renderEmpty(c: RenderCtx) {
  c.grid.classList.add("grid-empty");
  c.grid.style.gridTemplateColumns = "";

  const panel = document.createElement("div");
  panel.className = "empty-panel";

  const title = document.createElement("div");
  title.className = "empty-title";
  title.textContent = t("empty.title");

  const actions = document.createElement("div");
  actions.className = "empty-actions";
  const folder = document.createElement("button");
  folder.textContent = t("btn.folder");
  folder.onclick = () => c.openFolder();
  const clone = document.createElement("button");
  clone.textContent = t("btn.clone");
  clone.onclick = () => c.clone();
  actions.append(folder, clone);
  panel.append(title, actions);

  if (c.saved.length) {
    const sub = document.createElement("div");
    sub.className = "empty-sub";
    sub.textContent = t("empty.saved");
    panel.appendChild(sub);
    const list = document.createElement("div");
    list.className = "saved-list";
    for (const sp of c.saved) {
      const row = document.createElement("div");
      row.className = "saved-row";
      const open = document.createElement("button");
      open.className = "saved-open";
      open.textContent = `${sp.isGit ? "⎇" : "•"} ${sp.label}`;
      open.title = sp.path;
      open.onclick = () => c.openSaved(sp);
      const path = document.createElement("span");
      path.className = "saved-path";
      path.textContent = sp.path;
      const ren = document.createElement("button");
      ren.className = "saved-act";
      ren.textContent = "✎";
      ren.title = t("saved.rename");
      ren.onclick = () => c.renameSaved(sp.path);
      const del = document.createElement("button");
      del.className = "saved-act";
      del.textContent = "×";
      del.title = t("saved.remove");
      del.onclick = () => c.removeSaved(sp.path);
      row.append(open, path, ren, del);
      list.appendChild(row);
    }
    panel.appendChild(list);
  }

  c.grid.replaceChildren(panel);
}

/// Update a toggle button's text label (keeps its inline icon) and on-state.
function setToggleBtn(btn: HTMLElement, label: string, on: boolean) {
  const txt = btn.querySelector<HTMLElement>(".btn-txt");
  if (txt) txt.textContent = label;
  btn.classList.toggle("on", on);
}

function renderStrip(c: RenderCtx) {
  c.stripEl.replaceChildren();
  c.projects.forEach((p, i) => {
    const tab = document.createElement("button");
    tab.className = "proj-tab" + (i === c.ap && c.view === "project" ? " active" : "");
    tab.textContent = `${p.isGit ? "⎇" : "•"} ${p.name} (${p.agents.length})`;
    tab.addEventListener("click", () => c.selectProject(i));
    c.stripEl.appendChild(tab);
  });
}

const SVG_NS = "http://www.w3.org/2000/svg";

function renderMacro(c: RenderCtx) {
  const pts = goldenSpiral(c.projects.length);
  c.macroEl.replaceChildren();

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "macro-svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  const guide = goldenSpiralPath(c.projects.length);
  if (guide.length) svg.appendChild(polyline("spiral-guide", guide));
  if (pts.length > 1) svg.appendChild(polyline("spiral-link", pts));
  c.macroEl.appendChild(svg);

  c.projects.forEach((p, i) => {
    const node = document.createElement("div");
    node.className = "macro-node" + (i === c.ap ? " active" : "");
    node.style.left = `${pts[i].x * 100}%`;
    node.style.top = `${pts[i].y * 100}%`;
    const size = 56 + p.agents.length * 7;
    node.style.width = `${size}px`;
    node.style.height = `${size}px`;
    const name = document.createElement("div");
    name.className = "macro-name";
    name.textContent = p.name;
    const count = document.createElement("div");
    count.className = "macro-count";
    count.textContent = `${p.agents.length}`;
    node.append(name, count);
    node.addEventListener("click", () => c.selectProject(i));
    c.macroEl.appendChild(node);
  });
}

function polyline(cls: string, pts: { x: number; y: number }[]): SVGPolylineElement {
  const el = document.createElementNS(SVG_NS, "polyline");
  el.setAttribute("class", cls);
  el.setAttribute("points", pts.map((p) => `${p.x * 100},${p.y * 100}`).join(" "));
  el.setAttribute("vector-effect", "non-scaling-stroke");
  return el;
}
