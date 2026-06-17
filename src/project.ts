// Project layer: a Project is one repository (or folder). Its agents are git
// worktrees of that repo (isolated branches) so many Claude Code workers run in
// parallel without colliding. Multiple Projects run side by side; the macro view
// arranges them on a golden-angle spiral.
import { Agent } from "./agent";

export interface Project {
  id: string;
  name: string;
  root: string; // repo / folder path ("" for the scratch/home project)
  isGit: boolean;
  agents: Agent[];
}

let pseq = 0;
export function createProject(name: string, root: string, isGit: boolean): Project {
  return { id: `proj-${Date.now().toString(36)}-${pseq++}`, name, root, isGit, agents: [] };
}

export interface SpiralPoint {
  x: number; // 0..1 normalized within the container
  y: number; // 0..1
}

// Golden-angle phyllotaxis (the sunflower / golden-ratio spiral): point i sits at
// angle i·137.507° and radius ∝ √i, giving an even, organic spread.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.39996 rad ≈ 137.507°

export function goldenSpiral(n: number): SpiralPoint[] {
  if (n <= 0) return [];
  const pts: { x: number; y: number }[] = [];
  let maxR = 0;
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt(i + 0.5);
    const theta = i * GOLDEN_ANGLE;
    const x = r * Math.cos(theta);
    const y = r * Math.sin(theta);
    pts.push({ x, y });
    maxR = Math.max(maxR, r);
  }
  // Normalize into 0..1 with margin so nodes near the edge stay fully visible.
  const margin = 0.14;
  const span = 1 - margin * 2;
  return pts.map((p) => ({
    x: margin + ((p.x / maxR + 1) / 2) * span,
    y: margin + ((p.y / maxR + 1) / 2) * span,
  }));
}

// Continuous sampling of the same spiral, for drawing the guide curve behind the
// nodes. Uses the identical normalization so the curve threads through them.
export function goldenSpiralPath(n: number, step = 0.08): SpiralPoint[] {
  if (n <= 1) return [];
  const maxR = Math.sqrt(n - 1 + 0.5);
  const margin = 0.14;
  const span = 1 - margin * 2;
  const out: SpiralPoint[] = [];
  for (let t = 0; t <= n - 1 + 0.5; t += step) {
    const r = Math.sqrt(t + 0.5);
    const theta = t * GOLDEN_ANGLE;
    out.push({
      x: margin + ((((r * Math.cos(theta)) / maxR) + 1) / 2) * span,
      y: margin + ((((r * Math.sin(theta)) / maxR) + 1) / 2) * span,
    });
  }
  return out;
}
