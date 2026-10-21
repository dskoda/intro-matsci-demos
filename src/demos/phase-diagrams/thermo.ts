/**
 * Thermodynamics of binary A–B systems for the phase-diagram demo.
 * Pure model: no DOM.
 *
 * Every phase is an ideal solution with on-site (per-atom) free energies:
 *   G_φ(x, T) = (1 − x)·e_φ(A, T) + x·e_φ(B, T) + T [x ln x + (1 − x) ln(1 − x)]
 * with k_B = 1, so energies are in kelvin and kT = T. The same on-site energies
 * drive the lattice Monte Carlo, so the diagram computed here (lower convex hull
 * of the G curves) is the one the simulation should reproduce.
 */

export const L = 0;
export const ALPHA = 1;
export const BETA = 2;
export type PhaseId = typeof L | typeof ALPHA | typeof BETA;

export const PHASE_NAMES = ['L', 'α', 'β'];
export const K0 = 273.15;

export interface SystemDef {
  id: 'iso' | 'eut';
  name: string;
  labelA: string;
  labelB: string;
  phases: PhaseId[];
  /** Melting points of pure A and B (K) */
  TmA: number;
  TmB: number;
  /** Displayed temperature range (K) */
  Tmin: number;
  Tmax: number;
  /** On-site free energy of species s (0 = A, 1 = B) in phase p at T (K) */
  e(p: PhaseId, s: 0 | 1, T: number): number;
}

function liquid(Tm: number, dS: number, T: number): number {
  return dS * (Tm - T);
}

// Isomorphous: Cu–Ni-like. Both solid and liquid are ideal solutions.
const ISO_TA = 1085 + K0;
const ISO_TB = 1455 + K0;
const ISO_DS = 2.4; // entropy of fusion / k (sets the lens width)

export const ISOMORPHOUS: SystemDef = {
  id: 'iso',
  name: 'Cu–Ni (ideal-solution model)',
  labelA: 'Cu',
  labelB: 'Ni',
  phases: [L, ALPHA],
  TmA: ISO_TA,
  TmB: ISO_TB,
  Tmin: 950 + K0,
  Tmax: 1600 + K0,
  e(p, s, T) {
    if (p === L) return liquid(s === 0 ? ISO_TA : ISO_TB, ISO_DS, T);
    return 0;
  },
};

// Eutectic: α (A-rich) and β (B-rich) are distinct solids with limited solubility.
const EUT_TA = 900 + K0;
const EUT_TB = 800 + K0;
const EUT_DS = 1.4;
const EUT_DA = 2200; // cost of an A atom in β (K)
const EUT_DB = 1300; // cost of a B atom in α (K)

export const EUTECTIC: SystemDef = {
  id: 'eut',
  name: 'Binary eutectic A–B (model)',
  labelA: 'A',
  labelB: 'B',
  phases: [L, ALPHA, BETA],
  TmA: EUT_TA,
  TmB: EUT_TB,
  Tmin: 300 + K0,
  Tmax: 1000 + K0,
  e(p, s, T) {
    if (p === L) return liquid(s === 0 ? EUT_TA : EUT_TB, EUT_DS, T);
    if (p === ALPHA) return s === 0 ? 0 : EUT_DB;
    return s === 0 ? EUT_DA : 0;
  },
};

export const SYSTEMS: Record<SystemDef['id'], SystemDef> = { iso: ISOMORPHOUS, eut: EUTECTIC };

// ---------------------------------------------------------------------------
// Convex hull equilibrium
// ---------------------------------------------------------------------------

const M = 2000;
const XS = new Float64Array(M + 1);
const MIX = new Float64Array(M + 1);
for (let i = 0; i <= M; i++) {
  const x = (i + 0.5) / (M + 1);
  XS[i] = x;
  MIX[i] = x * Math.log(x) + (1 - x) * Math.log(1 - x);
}
const gBuf = new Float64Array(M + 1);
const pBuf = new Uint8Array(M + 1);
const hull = new Int32Array(M + 1);

/** A composition interval at fixed T: single-phase or a tie line between two phases. */
export interface Interval {
  phases: PhaseId[];
  /** Interval ends in composition */
  x0: number;
  x1: number;
}

/** Region name, e.g. "L", "α", "L + α" */
export function regionName(phases: PhaseId[]): string {
  return [...phases]
    .sort((a, b) => a - b)
    .map((p) => PHASE_NAMES[p])
    .join(' + ');
}

/** Lower convex hull of the G curves at temperature T, as a list of intervals. */
export function hullAt(sys: SystemDef, T: number): Interval[] {
  const ea = sys.phases.map((p) => sys.e(p, 0, T));
  const eb = sys.phases.map((p) => sys.e(p, 1, T));
  for (let i = 0; i <= M; i++) {
    const x = XS[i]!;
    let best = Infinity;
    let bp = 0;
    for (let k = 0; k < sys.phases.length; k++) {
      const g = (1 - x) * ea[k]! + x * eb[k]!;
      if (g < best) {
        best = g;
        bp = k;
      }
    }
    gBuf[i] = best + T * MIX[i]!;
    pBuf[i] = sys.phases[bp]!;
  }
  // Andrew's monotone chain (lower hull)
  let h = 0;
  for (let i = 0; i <= M; i++) {
    while (h >= 2) {
      const a = hull[h - 2]!;
      const b = hull[h - 1]!;
      const cross =
        (XS[b]! - XS[a]!) * (gBuf[i]! - gBuf[a]!) - (gBuf[b]! - gBuf[a]!) * (XS[i]! - XS[a]!);
      if (cross <= 0) h--;
      else break;
    }
    hull[h++] = i;
  }
  const out: Interval[] = [];
  const push = (phases: PhaseId[], x0: number, x1: number) => {
    const last = out[out.length - 1];
    if (last && phases.length === 1 && last.phases.length === 1 && last.phases[0] === phases[0]) {
      last.x1 = x1;
    } else {
      out.push({ phases, x0, x1 });
    }
  };
  for (let k = 0; k + 1 < h; k++) {
    const a = hull[k]!;
    const b = hull[k + 1]!;
    const pa = pBuf[a]! as PhaseId;
    const pb = pBuf[b]! as PhaseId;
    if (b - a <= 2 || pa === pb) push([pb], XS[a]!, XS[b]!);
    else push([pa, pb], XS[a]!, XS[b]!);
  }
  out[0]!.x0 = 0;
  out[out.length - 1]!.x1 = 1;
  return out;
}

export interface PhaseAmount {
  phase: PhaseId;
  /** Composition (fraction B) */
  x: number;
  /** Mass (mole) fraction from the lever rule */
  w: number;
}

export interface Equilibrium {
  region: string;
  phases: PhaseAmount[];
}

/** Equilibrium state of an alloy of overall composition x0 at temperature T. */
export function equilibrium(sys: SystemDef, x0: number, T: number): Equilibrium {
  const iv = hullAt(sys, T);
  let seg = iv[iv.length - 1]!;
  for (const s of iv) {
    if (x0 <= s.x1) {
      seg = s;
      break;
    }
  }
  if (seg.phases.length === 1) {
    return { region: regionName(seg.phases), phases: [{ phase: seg.phases[0]!, x: x0, w: 1 }] };
  }
  const w2 = (x0 - seg.x0) / (seg.x1 - seg.x0);
  return {
    region: regionName(seg.phases),
    phases: [
      { phase: seg.phases[0]!, x: seg.x0, w: 1 - w2 },
      { phase: seg.phases[1]!, x: seg.x1, w: w2 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Precomputed diagram
// ---------------------------------------------------------------------------

export interface Polyline {
  xs: number[];
  Ts: number[];
}

export interface Diagram {
  sys: SystemDef;
  /** Region raster: region index per (column x, row T), row 0 = Tmin */
  cols: number;
  rows: number;
  raster: Uint8Array;
  regions: string[];
  /** Label anchor (x, T) for each region */
  labels: { name: string; x: number; T: number }[];
  boundaries: Polyline[];
  /** Eutectic point, if any */
  eutectic: { T: number; x: number; xa: number; xb: number } | null;
}

function hasLiquid(sys: SystemDef, T: number): boolean {
  return hullAt(sys, T).some((s) => s.phases.includes(L));
}

export function buildDiagram(sys: SystemDef): Diagram {
  let eutectic: Diagram['eutectic'] = null;
  if (sys.phases.length === 3) {
    let lo = sys.Tmin;
    let hi = Math.min(sys.TmA, sys.TmB);
    for (let k = 0; k < 40; k++) {
      const mid = 0.5 * (lo + hi);
      if (hasLiquid(sys, mid)) hi = mid;
      else lo = mid;
    }
    const above = hullAt(sys, hi + 0.5);
    const liq = above.find((s) => s.phases.length === 1 && s.phases[0] === L);
    const below = equilibrium(sys, 0.5, lo - 0.01);
    eutectic = {
      T: 0.5 * (lo + hi),
      x: liq ? 0.5 * (liq.x0 + liq.x1) : 0.5,
      xa: below.phases[0]!.x,
      xb: below.phases[below.phases.length - 1]!.x,
    };
  }

  // Region raster on a uniform grid
  const cols = 400;
  const rows = 300;
  const raster = new Uint8Array(cols * rows);
  const regions: string[] = [];
  const sums: { x: number; T: number; n: number }[] = [];
  for (let r = 0; r < rows; r++) {
    const T = sys.Tmin + ((r + 0.5) / rows) * (sys.Tmax - sys.Tmin);
    const iv = hullAt(sys, T);
    let k = 0;
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) / cols;
      while (k < iv.length - 1 && x > iv[k]!.x1) k++;
      const name = regionName(iv[k]!.phases);
      let id = regions.indexOf(name);
      if (id < 0) {
        id = regions.length;
        regions.push(name);
        sums.push({ x: 0, T: 0, n: 0 });
      }
      raster[r * cols + c] = id;
      const s = sums[id]!;
      s.x += x;
      s.T += T;
      s.n++;
    }
  }
  const labels = regions.map((name, i) => {
    const s = sums[i]!;
    return { name, x: s.x / s.n, T: s.T / s.n };
  });

  // Boundary polylines: tie-line ends traced across T levels, keyed by the regions they separate
  const levels: number[] = [];
  const nT = 500;
  for (let k = 0; k <= nT; k++) levels.push(sys.Tmin + (k / nT) * (sys.Tmax - sys.Tmin));
  const specials = [sys.TmA, sys.TmB];
  if (eutectic) specials.push(eutectic.T);
  for (const t of specials) levels.push(t - 0.05, t + 0.05);
  levels.sort((a, b) => a - b);

  const open = new Map<string, Polyline>();
  const boundaries: Polyline[] = [];
  for (const T of levels) {
    if (T < sys.Tmin || T > sys.Tmax) continue;
    const iv = hullAt(sys, T);
    const seen = new Set<string>();
    for (let k = 0; k + 1 < iv.length; k++) {
      const key = regionName(iv[k]!.phases) + '|' + regionName(iv[k + 1]!.phases);
      seen.add(key);
      let line = open.get(key);
      if (!line) {
        line = { xs: [], Ts: [] };
        open.set(key, line);
        boundaries.push(line);
      }
      line.xs.push(iv[k]!.x1);
      line.Ts.push(T);
    }
    for (const key of [...open.keys()]) if (!seen.has(key)) open.delete(key);
  }
  // Close lens tips onto the pure-component melting points
  const kept = boundaries.filter((b) => b.xs.length >= 3);
  for (const b of kept) {
    for (const end of [0, b.xs.length - 1]) {
      const x = b.xs[end]!;
      const T = b.Ts[end]!;
      for (const [xm, Tm] of [
        [0, sys.TmA],
        [1, sys.TmB],
      ] as const) {
        if (Math.abs(x - xm) < 0.02 && Math.abs(T - Tm) < 15) {
          if (end === 0) {
            b.xs.unshift(xm);
            b.Ts.unshift(Tm);
          } else {
            b.xs.push(xm);
            b.Ts.push(Tm);
          }
          break;
        }
      }
    }
  }

  return { sys, cols, rows, raster, regions, labels, boundaries: kept, eutectic };
}
