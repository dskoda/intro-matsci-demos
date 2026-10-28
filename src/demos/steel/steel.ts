/**
 * The Fe–Fe₃C (steel) phase diagram for the phase-diagram demo.
 * Pure model: no DOM.
 *
 * Unlike the ideal-solution systems in `thermo.ts`, this is the textbook diagram,
 * tabulated as piecewise-linear boundaries in (wt% C, °C). It has three solid
 * solutions (δ, γ, α), the line compound Fe₃C (6.67 wt% C) and the three invariant
 * reactions
 *   peritectic  1493 °C: L (0.53) + δ (0.09) → γ (0.17)
 *   eutectic    1147 °C: L (4.30) → γ (2.14) + Fe₃C
 *   eutectoid    727 °C: γ (0.76) → α (0.022) + Fe₃C
 */

export const L = 0;
export const DELTA = 1;
export const GAMMA = 2;
export const ALPHA = 3;
export const CEMENTITE = 4;
export type PhaseId = 0 | 1 | 2 | 3 | 4;

export const PHASE_NAMES = ['L', 'δ', 'γ', 'α', 'Fe₃C'];
export const PHASE_LONG = ['liquid', 'δ-ferrite (bcc)', 'austenite γ (fcc)', 'ferrite α (bcc)', 'cementite Fe₃C'];

/** Carbon content of cementite (wt%) and the displayed ranges */
export const CMAX = 6.67;
export const T_MIN = 20;
export const T_MAX = 1600;
/** Invariant temperatures (°C) and compositions (wt% C) */
export const T_PERI = 1493;
export const T_EUTEC = 1147;
export const T_EUTD = 727;
export const C_EUTD = 0.76;
export const C_EUTEC = 4.3;
export const C_GMAX = 2.14;
export const C_ALPHA_MAX = 0.022;

/** A boundary as (wt% C, °C) points with increasing C */
export type Pt = [number, number][];

const LIQ1: Pt = [
  [0, 1538],
  [0.53, 1493],
];
const LIQ2: Pt = [
  [0.53, 1493],
  [C_EUTEC, T_EUTEC],
];
const LIQ3: Pt = [
  [C_EUTEC, T_EUTEC],
  [CMAX, 1227],
];
const SOL_D: Pt = [
  [0, 1538],
  [0.09, 1493],
];
const D_GD: Pt = [
  [0, 1394],
  [0.09, 1493],
];
const G_DG: Pt = [
  [0, 1394],
  [0.17, 1493],
];
const G_SOL: Pt = [
  [0.17, 1493],
  [C_GMAX, T_EUTEC],
];
const A3: Pt = [
  [0, 912],
  [0.4, 790],
  [C_EUTD, T_EUTD],
];
const A_G: Pt = [
  [0, 912],
  [C_ALPHA_MAX, T_EUTD],
];
const A_SOLV: Pt = [
  [0.005, T_MIN],
  [C_ALPHA_MAX, T_EUTD],
];
const ACM: Pt = [
  [C_EUTD, T_EUTD],
  [C_GMAX, T_EUTEC],
];

/** Lines drawn on the diagram */
export const BOUNDARIES: Pt[] = [
  [...LIQ1, ...LIQ2.slice(1), ...LIQ3.slice(1)],
  SOL_D,
  D_GD,
  [...G_DG, ...G_SOL.slice(1)],
  [
    [0, 912],
    [C_ALPHA_MAX, T_EUTD],
    [0.005, T_MIN],
  ],
  A3,
  ACM,
  // peritectic, eutectic and eutectoid horizontals
  [
    [0.09, T_PERI],
    [0.53, T_PERI],
  ],
  [
    [C_GMAX, T_EUTEC],
    [CMAX, T_EUTEC],
  ],
  [
    [C_ALPHA_MAX, T_EUTD],
    [CMAX, T_EUTD],
  ],
  // cementite
  [
    [CMAX, T_MIN],
    [CMAX, 1227],
  ],
];

/** Composition on a boundary at temperature T (the boundary must be monotonic in T) */
function cAt(p: Pt, T: number): number {
  for (let i = 0; i < p.length - 1; i++) {
    const [c0, T0] = p[i]!;
    const [c1, T1] = p[i + 1]!;
    if (T >= Math.min(T0, T1) && T <= Math.max(T0, T1)) return c0 + ((c1 - c0) * (T - T0)) / (T1 - T0);
  }
  const a = p[0]!;
  const b = p[p.length - 1]!;
  return Math.abs(T - a[1]) < Math.abs(T - b[1]) ? a[0] : b[0];
}

/** Temperature on a boundary at composition c */
function tAt(p: Pt, c: number): number {
  for (let i = 0; i < p.length - 1; i++) {
    const [c0, T0] = p[i]!;
    const [c1, T1] = p[i + 1]!;
    if (c >= c0 && c <= c1) return T0 + ((T1 - T0) * (c - c0)) / (c1 - c0);
  }
  return p[p.length - 1]![1];
}

export function liquidusT(c: number): number {
  if (c < 0.53) return tAt(LIQ1, c);
  if (c < C_EUTEC) return tAt(LIQ2, c);
  return tAt(LIQ3, c);
}

export interface PhaseAmount {
  phase: PhaseId;
  /** Carbon content of the phase (wt%) */
  x: number;
  /** Weight fraction from the lever rule */
  w: number;
}

export interface Equilibrium {
  region: string;
  phases: PhaseAmount[];
}

/** Equilibrium state of an alloy with c wt% C at temperature T (°C). */
export function equilibrium(c: number, T: number): Equilibrium {
  const one = (p: PhaseId, x = c): Equilibrium => ({
    region: PHASE_NAMES[p]!,
    phases: [{ phase: p, x, w: 1 }],
  });
  // Two phases, left (lower C) first
  const two = (a: PhaseId, ca: number, b: PhaseId, cb: number, name: string): Equilibrium => {
    const w = Math.min(1, Math.max(0, (c - ca) / (cb - ca)));
    return {
      region: name,
      phases: [
        { phase: a, x: ca, w: 1 - w },
        { phase: b, x: cb, w },
      ],
    };
  };

  if (T >= liquidusT(c)) return one(L);
  if (c >= 6.6) return one(CEMENTITE, CMAX);

  if (T > T_PERI) {
    const cs = cAt(SOL_D, T);
    return c < cs ? one(DELTA) : two(DELTA, cs, L, cAt(LIQ1, T), 'L + δ');
  }
  if (T > T_EUTEC) {
    if (T >= 1394) {
      const cd = cAt(D_GD, T);
      const cg = cAt(G_DG, T);
      if (c < cd) return one(DELTA);
      if (c < cg) return two(DELTA, cd, GAMMA, cg, 'δ + γ');
    }
    const cs = cAt(G_SOL, T);
    if (c < cs) return one(GAMMA);
    if (c <= C_EUTEC) return two(GAMMA, cs, L, cAt(LIQ2, T), 'γ + L');
    return two(L, cAt(LIQ3, T), CEMENTITE, CMAX, 'L + Fe₃C');
  }
  if (T > T_EUTD) {
    const cm = cAt(ACM, T);
    if (T < 912) {
      const ca = cAt(A_G, T);
      const c3 = cAt(A3, T);
      if (c < ca) return one(ALPHA);
      if (c < c3) return two(ALPHA, ca, GAMMA, c3, 'α + γ');
    }
    return c < cm ? one(GAMMA) : two(GAMMA, cm, CEMENTITE, CMAX, 'γ + Fe₃C');
  }
  const cs = cAt(A_SOLV, T);
  return c < cs ? one(ALPHA) : two(ALPHA, cs, CEMENTITE, CMAX, 'α + Fe₃C');
}

/** What an alloy turns into on slow cooling, for captions and the readout */
export interface Classification {
  name: string;
  /** Proeutectoid phase (formed between the A3/Acm line and 727 °C), if any */
  pro: 'α' | 'Fe₃C' | null;
  /** Weight fraction of proeutectoid phase just above 727 °C */
  wPro: number;
  /** Weight fraction of pearlite just below 727 °C (steels) */
  wPearlite: number;
  /** Total ferrite and cementite fractions at room temperature */
  wAlpha: number;
  wCem: number;
}

export function classify(c: number): Classification {
  const wCem = Math.min(1, Math.max(0, (c - C_ALPHA_MAX) / (CMAX - C_ALPHA_MAX)));
  const base = { wAlpha: 1 - wCem, wCem };
  if (c < C_ALPHA_MAX) return { ...base, name: 'pure iron / ferrite', pro: null, wPro: 0, wPearlite: 0 };
  if (Math.abs(c - C_EUTD) < 0.02)
    return { ...base, name: 'eutectoid steel', pro: null, wPro: 0, wPearlite: 1 };
  if (c < C_EUTD) {
    const w = (C_EUTD - c) / (C_EUTD - C_ALPHA_MAX);
    return { ...base, name: 'hypoeutectoid steel', pro: 'α', wPro: w, wPearlite: 1 - w };
  }
  if (c <= C_GMAX) {
    const w = (c - C_EUTD) / (CMAX - C_EUTD);
    return { ...base, name: 'hypereutectoid steel', pro: 'Fe₃C', wPro: w, wPearlite: 1 - w };
  }
  if (Math.abs(c - C_EUTEC) < 0.05)
    return { ...base, name: 'eutectic cast iron', pro: null, wPro: 0, wPearlite: 0 };
  return {
    ...base,
    name: c < C_EUTEC ? 'hypoeutectic cast iron' : 'hypereutectic cast iron',
    pro: null,
    wPro: 0,
    wPearlite: 0,
  };
}

/** Label anchors: text at (c, T), optionally with a leader line to (ac, aT) */
export interface SteelLabel {
  name: string;
  c: number;
  T: number;
  ac?: number;
  aT?: number;
}

export const LABELS: SteelLabel[] = [
  { name: 'L', c: 3.3, T: 1440 },
  { name: 'γ + L', c: 1.95, T: 1295 },
  { name: 'γ', c: 0.9, T: 1000 },
  { name: 'γ + Fe₃C', c: 3.6, T: 900 },
  { name: 'α + Fe₃C', c: 3.4, T: 380 },
  { name: 'δ', c: 0.55, T: 1572, ac: 0.03, aT: 1470 },
  { name: 'L + δ', c: 1.5, T: 1572, ac: 0.12, aT: 1515 },
  { name: 'δ + γ', c: 1.05, T: 1385, ac: 0.1, aT: 1445 },
  { name: 'α', c: 0.7, T: 560, ac: 0.01, aT: 640 },
  { name: 'α + γ', c: 0.95, T: 845, ac: 0.18, aT: 835 },
  { name: 'L + Fe₃C', c: 5.5, T: 1330, ac: 6.1, aT: 1190 },
];
