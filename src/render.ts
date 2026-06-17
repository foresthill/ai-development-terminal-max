// Pure-ish rendering for the workspace: project strip, agent grid (with depth
// decks), and the macro golden-spiral view. Driven by a RenderCtx the App builds,
// so this module holds no state.
import { Agent } from "./agent";
import { Project, goldenSpiral, goldenSpiralPath } from "./project";

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
  permSelect: HTMLSelectElement;
  projects: Project[];
  ap: number;
  focused: number;
  mode: Mode;
  view: View;
  layout: "square" | "fit";
  permMode: PermMode;
  guardrails: boolean;
  selectProject(i: number): void;
  setLayer(agent: Agent, li: number, ai: number): void;
  afterRender(): void;
}

export function renderAll(c: RenderCtx) {
  const total = c.projects.reduce((s, p) => s + p.agents.length, 0);
  c.countEl.textContent = `${total} agents · ${c.projects.length} proj`;
  c.permSelect.value = c.permMode;
  c.btnGuard.textContent = `🛡 guard: ${c.guardrails ? "on" : "off"}`;
  c.btnGuard.classList.toggle("on", c.guardrails);
  renderStrip(c);

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
  c.grid.replaceChildren(...agents.map((a) => a.cardEl));

  const n = agents.length;
  if (c.layout === "square" && n > 0) {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    c.grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    c.btnLayout.textContent = `▦ ${cols}×${rows}`;
  } else {
    c.grid.style.gridTemplateColumns = "";
    c.btnLayout.textContent = "▦ fit";
  }

  agents.forEach((agent, ai) => {
    agent.cardEl.classList.toggle("focused", ai === c.focused);
    agent.cardEl.classList.toggle("zoomed", c.mode === "zoom" && ai === c.focused);
    agent.cardEl.classList.toggle("hidden", c.mode === "zoom" && ai !== c.focused);
    if (agent.titleEl.contentEditable !== "true") agent.titleEl.textContent = agent.title;

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

    agent.dotsEl.innerHTML = "";
    agent.layers.forEach((layer, li) => {
      const dot = document.createElement("span");
      dot.className = "dot" + (li === agent.active ? " active" : "");
      dot.textContent = layer.kind === "browser" ? "◉" : "▣";
      dot.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        c.setLayer(agent, li, ai);
      });
      agent.dotsEl.appendChild(dot);
    });
  });

  c.afterRender();
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
