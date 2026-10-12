/**
 * Multi-order-parameter phase-field model of recrystallization and grain growth.
 * Pure model: no DOM, no three.js.
 *
 * Free energy (reduced units):
 *   f = sum_i (-eta_i^2/2 + eta_i^4/4) + gamma sum_{i<j} eta_i^2 eta_j^2
 *       + kappa/2 sum_i |grad eta_i|^2 + sum_{i old} E(x) eta_i^2
 *
 * Old grains (order parameters 0..Q_OLD-1) carry the stored defect energy E(x)
 * from cold work; new grains (Q_OLD..Q-1) are defect free. A new grain that
 * sweeps through the material consumes the stored energy. With E = 0 the same
 * equations give curvature-driven grain growth.
 */

import { mulberry32 } from '../strengthening/strengthening';

export const N = 128;
export const Q_OLD = 10;
export const Q_NEW = 8;
export const Q = Q_OLD + Q_NEW;
export const S_MAX = 2.5;
export const DT = 0.1;
/** Largest time step: at low mobility the step is capped so rates stay resolved. */
export const DT_MAX = 2;
export const T_REF = 900;

const GAMMA = 1.5;
const KAPPA = 1.0;
const ACTIVE = 1e-3;
const KB = 8.617e-5; // eV/K

// Activation energies (eV): recovery < nucleation < boundary migration
const Q_MOB = 0.8;
const Q_NUC = 0.55;
const Q_REC = 0.35;

// Prefactors (calibrated by sweeps)
/** Tunable rates (calibrated by sweeps). */
export const TUNING = {
  nucRate: 0.5, // seed attempts per time unit at T_REF
  recRate: 0.006, // recovery rate per time unit at T_REF
};
const NUC_RADIUS = 4;
const E_CONST = 0.5; // stored energy scale

/** Arrhenius factor relative to T_REF: exp(-Q/k (1/T - 1/T_ref)). */
export function arrhenius(Qact: number, T: number): number {
  return Math.exp((-Qact / KB) * (1 / T - 1 / T_REF));
}
export const mobility = (T: number): number => arrhenius(Q_MOB, T);

export interface StructureSettings {
  /** Approximate number of grains in the initial (annealed) box. */
  grains: number;
  /** Spread of grain sizes, 0 (uniform) to 1 (very heterogeneous). */
  dispersion: number;
  seed: number;
}

/**
 * Grain structure defined in "material space" (a box N wide and S_MAX*N tall).
 * Rolling by a reduction `eps` samples it at x/s, y*s with s = 1/(1-eps), so grains
 * flatten and elongate without remapping any field.
 */
export class Structure {
  readonly seedX: Float32Array;
  readonly seedY: Float32Array;
  readonly seedW: Float32Array;
  /** Random factor per grain, used for the stored-energy heterogeneity. */
  readonly factor: Float32Array;
  /** Order-parameter index assigned to every grain. */
  readonly color: Uint8Array;
  readonly count: number;
  readonly rng: () => number;

  constructor(readonly settings: StructureSettings) {
    this.rng = mulberry32(settings.seed);
    const cols = Math.max(2, Math.round(Math.sqrt(settings.grains)));
    const rows = Math.max(2, Math.round((settings.grains * S_MAX) / cols));
    this.count = cols * rows;
    const cw = N / cols;
    const ch = (N * S_MAX) / rows;
    const a = Math.sqrt((N * N) / settings.grains);
    this.seedX = new Float32Array(this.count);
    this.seedY = new Float32Array(this.count);
    this.seedW = new Float32Array(this.count);
    this.factor = new Float32Array(this.count);
    let k = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++, k++) {
        this.seedX[k] = (i + 0.5 + (this.rng() - 0.5) * 0.8) * cw;
        this.seedY[k] = (j + 0.5 + (this.rng() - 0.5) * 0.8) * ch;
        this.seedW[k] = settings.dispersion * a * a * 1.2 * (this.rng() - 0.4);
        this.factor[k] = this.rng();
      }
    }
    this.color = new Uint8Array(this.count);
    this.assignColors();
  }

  /** Grain id for every cell at stretch s. */
  labels(s: number): Int32Array {
    const out = new Int32Array(N * N);
    for (let j = 0; j < N; j++) {
      const y = (j + 0.5) * s;
      for (let i = 0; i < N; i++) {
        const x = (i + 0.5) / s;
        let best = 0;
        let bd = Infinity;
        for (let k = 0; k < this.count; k++) {
          const dx = x - this.seedX[k]!;
          const dy = y - this.seedY[k]!;
          const d = dx * dx + dy * dy - this.seedW[k]!;
          if (d < bd) {
            bd = d;
            best = k;
          }
        }
        out[j * N + i] = best;
      }
    }
    return out;
  }

  /** Greedy graph colouring on the union of the adjacency at several stretches. */
  private assignColors() {
    const adj: Set<number>[] = Array.from({ length: this.count }, () => new Set<number>());
    for (let s = 1; s <= S_MAX + 1e-9; s += 0.15) {
      const lab = this.labels(s);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const a = lab[j * N + i]!;
          if (i + 1 < N) link(adj, a, lab[j * N + i + 1]!);
          if (j + 1 < N) link(adj, a, lab[(j + 1) * N + i]!);
        }
      }
    }
    const order = Array.from({ length: this.count }, (_, k) => k).sort((p, q) => adj[q]!.size - adj[p]!.size);
    const assigned = new Int16Array(this.count).fill(-1);
    for (const g of order) {
      const used = new Int32Array(Q_OLD);
      for (const nb of adj[g]!) {
        const c = assigned[nb]!;
        if (c >= 0) used[c]!++;
      }
      let best = 0;
      for (let c = 1; c < Q_OLD; c++) if (used[c]! < used[best]!) best = c;
      assigned[g] = best;
      this.color[g] = best;
    }
  }
}

function link(adj: Set<number>[], a: number, b: number) {
  if (a === b) return;
  adj[a]!.add(b);
  adj[b]!.add(a);
}

/** Smooth random field in [-1, 1] (bilinear value noise). */
function smoothNoise(rng: () => number, cell: number): Float32Array {
  const g = Math.ceil(N / cell) + 2;
  const grid = new Float32Array(g * g);
  for (let k = 0; k < grid.length; k++) grid[k] = rng() * 2 - 1;
  const out = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const fx = i / cell;
      const fy = j / cell;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const v00 = grid[y0 * g + x0]!;
      const v10 = grid[y0 * g + x0 + 1]!;
      const v01 = grid[(y0 + 1) * g + x0]!;
      const v11 = grid[(y0 + 1) * g + x0 + 1]!;
      out[j * N + i] = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
    }
  }
  return out;
}

/**
 * Stored (defect) energy map after cold work by reduction `eps`. It varies from
 * grain to grain, inside grains (noise and shear bands), and is enhanced near
 * grain boundaries.
 */
export function buildStoredEnergy(
  structure: Structure,
  labels: Int32Array,
  eps: number,
  heterogeneity: number
): Float32Array {
  const rng = mulberry32(structure.settings.seed + 7919);
  const noise = smoothNoise(rng, 14);
  const phase = rng() * Math.PI * 2;
  // Boundary proximity: blurred boundary mask
  let mask: Float32Array = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = labels[j * N + i]!;
      if ((i + 1 < N && labels[j * N + i + 1] !== a) || (j + 1 < N && labels[(j + 1) * N + i] !== a)) {
        mask[j * N + i] = 1;
      }
    }
  }
  for (let pass = 0; pass < 3; pass++) mask = blur(mask, 2);
  let mx = 1e-6;
  for (const v of mask) if (v > mx) mx = v;

  const scale = E_CONST * Math.pow(eps, 0.7);
  const out = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const c = j * N + i;
      const gf = Math.min(2, Math.max(0.15, 1 + heterogeneity * (structure.factor[labels[c]!]! * 2 - 1) * 0.9));
      const band = Math.sin((i * 0.7 + j * 1.0) / 6 + phase);
      const local = 1 + heterogeneity * (0.35 * noise[c]! + 0.15 * band);
      const bonus = 1 + heterogeneity * 1.2 * (mask[c]! / mx);
      out[c] = scale * gf * Math.max(0.2, local) * bonus;
    }
  }
  return out;
}

function blur(src: Float32Array, r: number): Float32Array {
  const tmp = new Float32Array(N * N);
  const out = new Float32Array(N * N);
  const w = 2 * r + 1;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += src[j * N + Math.min(N - 1, Math.max(0, i + d))]!;
      tmp[j * N + i] = s / w;
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += tmp[Math.min(N - 1, Math.max(0, j + d)) * N + i]!;
      out[j * N + i] = s / w;
    }
  }
  return out;
}

export interface Stats {
  /** Recrystallised area fraction. */
  X: number;
  /** Mean linear grain size (cells). */
  size: number;
  /** Mean effective stored energy. */
  energy: number;
  grains: number;
}

export class PhaseField {
  eta: Float32Array[] = [];
  private next: Float32Array[] = [];
  private mask = new Int32Array(N * N);
  private active = new Int32Array(N * N);
  E0: Float32Array;
  readonly rng: () => number;
  rec = 1;
  time = 0;
  /** Number of nuclei seeded so far. */
  nuclei = 0;

  constructor(labels: Int32Array, color: Uint8Array, E0: Float32Array, seed: number) {
    this.E0 = E0;
    this.rng = mulberry32(seed + 104729);
    for (let i = 0; i < Q; i++) {
      this.eta.push(new Float32Array(N * N));
      this.next.push(new Float32Array(N * N));
    }
    for (let c = 0; c < N * N; c++) this.eta[color[labels[c]!]!]![c] = 1;
    // Smooth the sharp initial interfaces without stored energy or time advance
    const e0 = this.E0;
    const zero = new Float32Array(N * N);
    this.E0 = zero;
    for (let k = 0; k < 25; k++) this.evolve(1, DT);
    this.E0 = e0;
    this.time = 0;
  }

  /** Effective stored energy at cell c. */
  private effective(c: number, sNew: number): number {
    return this.E0[c]! * this.rec * (1 - Math.min(1, sNew));
  }

  /** One Allen-Cahn step with mobility factor L and time step dt (L*dt <= 0.1 keeps it stable). */
  private evolve(L: number, dt: number) {
    const eta = this.eta;
    const next = this.next;
    const mask = this.mask;
    const active = this.active;
    for (let c = 0; c < N * N; c++) {
      let m = 0;
      for (let k = 0; k < Q; k++) if (eta[k]![c]! > ACTIVE) m |= 1 << k;
      mask[c] = m;
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = j * N + i;
        active[c] =
          mask[c]! |
          mask[j * N + Math.max(0, i - 1)]! |
          mask[j * N + Math.min(N - 1, i + 1)]! |
          mask[Math.max(0, j - 1) * N + i]! |
          mask[Math.min(N - 1, j + 1) * N + i]!;
      }
    }
    for (let j = 0; j < N; j++) {
      const jm = Math.max(0, j - 1) * N;
      const jp = Math.min(N - 1, j + 1) * N;
      for (let i = 0; i < N; i++) {
        const c = j * N + i;
        const im = Math.max(0, i - 1);
        const ip = Math.min(N - 1, i + 1);
        const bits = active[c]!;
        let sumsq = 0;
        let sNew = 0;
        for (let k = 0; k < Q; k++) {
          if (!(bits & (1 << k))) continue;
          const v = eta[k]![c]!;
          sumsq += v * v;
          if (k >= Q_OLD) sNew += v * v;
        }
        const E = this.effective(c, sNew);
        for (let k = 0; k < Q; k++) {
          const arr = eta[k]!;
          if (!(bits & (1 << k))) {
            next[k]![c] = 0;
            continue;
          }
          const v = arr[c]!;
          const lap = arr[j * N + im]! + arr[j * N + ip]! + arr[jm + i]! + arr[jp + i]! - 4 * v;
          let rate = v * v * v - v + 2 * GAMMA * v * (sumsq - v * v) - KAPPA * lap;
          if (k < Q_OLD) rate += 2 * E * v;
          let nv = v - L * dt * rate;
          if (nv < 0) nv = 0;
          else if (nv > 1.2) nv = 1.2;
          next[k]![c] = nv;
        }
      }
    }
    this.eta = next;
    this.next = eta;
  }

  /**
   * Advance by one step at temperature T (Kelvin). The time step grows as the mobility
   * falls (L*dt stays at most 0.1, which keeps the scheme stable) up to DT_MAX.
   * Returns the physical time advanced.
   */
  step(T: number): number {
    const L = Math.min(1, mobility(T));
    const dt = Math.min(DT_MAX, DT / L);
    this.evolve(L, dt);
    this.time += dt;
    this.rec *= Math.exp(-dt * TUNING.recRate * arrhenius(Q_REC, T));
    const attempts = this.poisson(dt * TUNING.nucRate * arrhenius(Q_NUC, T));
    for (let k = 0; k < attempts; k++) if (this.tryNucleate()) this.nuclei++;
    return dt;
  }

  private poisson(lambda: number): number {
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * (this.rng() + this.rng() + this.rng() - 1.5) * 2));
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = this.rng();
    while (p > limit) {
      k++;
      p *= this.rng();
    }
    return k;
  }

  /** Try to seed one nucleus at a high-energy site. Returns true if placed. */
  private tryNucleate(): boolean {
    let emax = 1e-6;
    for (let c = 0; c < N * N; c += 7) if (this.E0[c]! > emax) emax = this.E0[c]!;
    for (let attempt = 0; attempt < 30; attempt++) {
      const cx = Math.floor(this.rng() * N);
      const cy = Math.floor(this.rng() * N);
      const c = cy * N + cx;
      let sNew = 0;
      for (let k = Q_OLD; k < Q; k++) sNew += this.eta[k]![c]! ** 2;
      if (sNew > 0.1) continue;
      const e = this.effective(c, sNew);
      if (this.rng() * emax * this.rec > e) continue;
      const k = this.freeIndex(cx, cy);
      if (k < 0) return false;
      const r2 = NUC_RADIUS * NUC_RADIUS;
      for (let dy = -NUC_RADIUS; dy <= NUC_RADIUS; dy++) {
        for (let dx = -NUC_RADIUS; dx <= NUC_RADIUS; dx++) {
          if (dx * dx + dy * dy > r2) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= N || y >= N) continue;
          for (let m = 0; m < Q; m++) this.eta[m]![y * N + x] = m === k ? 1 : 0;
        }
      }
      return true;
    }
    return false;
  }

  /** New-grain index whose nearest existing grain is farthest from (cx, cy); -1 if none is free. */
  private freeIndex(cx: number, cy: number): number {
    const R = 22;
    let best = -1;
    let bestD = 2 * NUC_RADIUS + 6;
    for (let k = Q_OLD; k < Q; k++) {
      let dmin = R;
      const arr = this.eta[k]!;
      for (let y = Math.max(0, cy - R); y <= Math.min(N - 1, cy + R); y++) {
        for (let x = Math.max(0, cx - R); x <= Math.min(N - 1, cx + R); x++) {
          if (arr[y * N + x]! > 0.05) {
            const d = Math.hypot(x - cx, y - cy);
            if (d < dmin) dmin = d;
          }
        }
      }
      if (dmin > bestD) {
        bestD = dmin;
        best = k;
      }
    }
    return best;
  }

  /** Index of the dominant order parameter for every cell. */
  dominant(out: Uint8Array): Uint8Array {
    for (let c = 0; c < N * N; c++) {
      let b = 0;
      let bv = -1;
      for (let k = 0; k < Q; k++) {
        const v = this.eta[k]![c]!;
        if (v > bv) {
          bv = v;
          b = k;
        }
      }
      out[c] = b;
    }
    return out;
  }

  /** Sum of eta^2 (1 inside grains, smaller at boundaries). */
  sumSquares(c: number): number {
    let s = 0;
    for (let k = 0; k < Q; k++) s += this.eta[k]![c]! ** 2;
    return s;
  }

  /** Effective stored energy map (for display). */
  energyMap(out: Float32Array): Float32Array {
    for (let c = 0; c < N * N; c++) {
      let sNew = 0;
      for (let k = Q_OLD; k < Q; k++) sNew += this.eta[k]![c]! ** 2;
      out[c] = this.effective(c, sNew);
    }
    return out;
  }

  stats(): Stats {
    const dom = this.dominant(new Uint8Array(N * N));
    let fresh = 0;
    let e = 0;
    for (let c = 0; c < N * N; c++) {
      if (dom[c]! >= Q_OLD) fresh++;
      let sNew = 0;
      for (let k = Q_OLD; k < Q; k++) sNew += this.eta[k]![c]! ** 2;
      e += this.effective(c, sNew);
    }
    const grains = countComponents(dom);
    return { X: fresh / (N * N), size: N / Math.sqrt(Math.max(1, grains)), energy: e / (N * N), grains };
  }
}

/** Number of 4-connected regions of equal index (ignoring tiny ones). */
export function countComponents(dom: Uint8Array): number {
  const seen = new Uint8Array(N * N);
  const stack: number[] = [];
  let count = 0;
  for (let s = 0; s < N * N; s++) {
    if (seen[s]) continue;
    const id = dom[s]!;
    let area = 0;
    stack.length = 0;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      area++;
      const x = c % N;
      const y = (c - x) / N;
      if (x > 0 && !seen[c - 1] && dom[c - 1] === id) (seen[c - 1] = 1), stack.push(c - 1);
      if (x < N - 1 && !seen[c + 1] && dom[c + 1] === id) (seen[c + 1] = 1), stack.push(c + 1);
      if (y > 0 && !seen[c - N] && dom[c - N] === id) (seen[c - N] = 1), stack.push(c - N);
      if (y < N - 1 && !seen[c + N] && dom[c + N] === id) (seen[c + N] = 1), stack.push(c + N);
    }
    if (area >= 6) count++;
  }
  return count;
}

/** Relative strength: Taylor hardening from stored energy plus Hall-Petch. Calibrated to 1 when annealed. */
export function relativeStrength(energy: number, size: number, refSize: number): number {
  const taylor = 1.1 * Math.sqrt(Math.max(0, energy) / E_CONST);
  const hp = 0.6 * Math.sqrt(refSize / Math.max(size, 1));
  return 0.4 + hp + taylor;
}
