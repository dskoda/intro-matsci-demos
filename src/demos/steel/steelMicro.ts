/**
 * Microstructure of an Fe–C alloy on cooling, for the phase-diagram demo.
 * Pure model: no DOM.
 *
 * A Voronoi grain map supplies, for each pixel, a rank `rb` (0 at grain boundaries,
 * 1 at grain centres). Phase fractions come from the lever rule of the tabulated
 * diagram (`steel.ts`) and are laid out by thresholding that rank:
 *   - liquid freezes from the grain centres, so liquid is left at the boundaries;
 *   - proeutectoid α and Fe₃C, and γ in the peritectic, form at the boundaries.
 * The eutectoid reaction γ → α + Fe₃C is the only kinetic step: `pearl` (0..1) is the
 * fraction of the remaining austenite that has turned into pearlite colonies, which
 * grow from the boundaries inwards. The lamellar spacing is fixed when a pixel
 * transforms and shrinks with the undercooling below 727 °C.
 */

import { mulberry32 } from '../strengthening/strengthening';
import {
  C_ALPHA_MAX,
  C_EUTD,
  C_EUTEC,
  C_GMAX,
  CEMENTITE,
  CMAX,
  DELTA,
  GAMMA,
  ALPHA,
  L,
  T_EUTD,
  equilibrium,
} from './steel';

export const G = 256;
const N = G * G;
const GRAINS = 5; // GRAINS² grains
const COLONY = 10; // COLONY² pearlite colonies

// Pixel constituents
export const C_L = L;
export const C_DELTA = DELTA;
export const C_GAMMA = GAMMA;
export const C_ALPHA = ALPHA;
export const C_CEM = CEMENTITE;
/** Ledeburite: eutectic γ + Fe₃C (fine mixture) */
export const C_LEDEB = 5;
export const C_PEARL = 6;
/** Ledeburite after its austenite has become pearlite ("transformed ledeburite") */
export const C_LEDEB_P = 7;

export const COLORS: [number, number, number][] = [
  [86, 132, 201], // L
  [178, 132, 226], // δ
  [245, 158, 66], // γ
  [226, 232, 240], // α
  [200, 55, 70], // Fe₃C
  [245, 158, 66], // ledeburite (γ + Fe₃C dots)
  [226, 232, 240], // pearlite (stripes)
  [214, 200, 205], // transformed ledeburite
];

interface Band {
  upTo: number;
  code: number;
}

/** Weight fraction of Fe₃C in the eutectoid pearlite (the lever rule at 727 °C) */
const F_PEARL = (C_EUTD - C_ALPHA_MAX) / (CMAX - C_ALPHA_MAX);
/** Weight fraction of Fe₃C in the eutectic (ledeburite) */
const F_LEDEB = (C_EUTEC - C_GMAX) / (CMAX - C_GMAX);

interface Layout {
  bands: Band[];
  /** Area fraction of Fe₃C inside ledeburite (before its austenite becomes pearlite) */
  ledCov: number;
}

/**
 * Layout of the constituents as bands of increasing boundary rank, for an alloy c at T.
 * The areas follow the lever rule: the area of each phase equals its weight fraction.
 */
function bands(c: number, T: number): Layout {
  const lay = (b: Band[], ledCov = F_LEDEB): Layout => ({ bands: b, ledCov });
  const eq = equilibrium(c, T);
  const ph = eq.phases;
  if (ph.length === 1) return lay([{ upTo: 1, code: ph[0]!.phase }]);
  const a = ph[0]!;
  const b = ph[1]!;
  const liquid = a.phase === L ? a : b.phase === L ? b : null;
  if (liquid) {
    const solid = liquid === a ? b : a;
    return lay([
      { upTo: liquid.w, code: L },
      { upTo: 1, code: solid.phase },
    ]);
  }
  if (a.phase === DELTA) return lay([{ upTo: b.w, code: GAMMA }, { upTo: 1, code: DELTA }]);
  if (a.phase === ALPHA) return lay([{ upTo: a.w, code: ALPHA }, { upTo: 1, code: GAMMA }]);
  // γ + Fe₃C; b.w is the total weight fraction of Fe₃C
  if (c > C_GMAX) {
    // Cast iron: ledeburite at the boundaries, primary γ (or Fe₃C) in the grain centres
    const wLed = c <= C_EUTEC ? (c - C_GMAX) / (C_EUTEC - C_GMAX) : (CMAX - c) / (CMAX - C_EUTEC);
    if (c <= C_EUTEC) {
      // Cementite rejected by the cooling austenite beyond the eutectic amount: a solid layer on
      // the ledeburite, and a coarser Fe₃C texture inside it
      // Shared between the ledeburite and the austenite in proportion to their areas
      const need = Math.max(0, b.w - F_LEDEB * wLed);
      const extra = need * (1 - wLed);
      const ledCov = Math.min(1, F_LEDEB + need);
      return lay(
        [
          { upTo: wLed, code: C_LEDEB },
          { upTo: wLed + extra, code: CEMENTITE },
          { upTo: 1, code: GAMMA },
        ],
        ledCov
      );
    }
    // Primary Fe₃C takes 1 − wLed; the rest of the cementite thickens the ledeburite's Fe₃C
    const ledCov = wLed > 0 ? Math.min(1, Math.max(F_LEDEB, (b.w - (1 - wLed)) / wLed)) : F_LEDEB;
    return lay(
      [
        { upTo: wLed, code: C_LEDEB },
        { upTo: 1, code: CEMENTITE },
      ],
      ledCov
    );
  }
  return lay([{ upTo: b.w, code: CEMENTITE }, { upTo: 1, code: GAMMA }]);
}

/** Smooth value noise on a periodic grid, in [0, 1) */
function noiseField(rng: () => number, cells: number): (x: number, y: number) => number {
  const v = new Float32Array(cells * cells);
  for (let i = 0; i < v.length; i++) v[i] = rng();
  return (x, y) => {
    const fx = (x / G) * cells;
    const fy = (y / G) * cells;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const at = (i: number, j: number) => v[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)]!;
    const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
    const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
    return a + (b - a) * sy;
  };
}

/** Jittered-grid points on the periodic G×G domain */
function seeds(rng: () => number, n: number): [number, number][] {
  const out: [number, number][] = [];
  const cell = G / n;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) out.push([(i + 0.15 + 0.7 * rng()) * cell, (j + 0.15 + 0.7 * rng()) * cell]);
  return out;
}

const wrapD = (d: number) => {
  const a = Math.abs(d);
  return a > G / 2 ? G - a : a;
};

export class SteelMicro {
  /** Boundary rank: 0 at grain boundaries … 1 at grain centres */
  readonly rb = new Float32Array(N);
  /** Distance to the nearest grain boundary (pixels) */
  readonly bd = new Float32Array(N);
  readonly shade = new Float32Array(N);
  private readonly colony = new Uint8Array(N);
  private readonly colAngle: { c: number; s: number; ph: number }[] = [];
  /** Constituent of each pixel */
  readonly code = new Uint8Array(N);
  /** Lamellar spacing (pixels) of pearlite pixels, 0 = not pearlite */
  readonly pitch = new Float32Array(N);
  /** Texture rank 0..1 (uniform), used to place Fe₃C rods in ledeburite with exact area fraction */
  private readonly tex = new Float32Array(N);
  private ledCov = F_LEDEB;
  /** Fraction of the austenite that has transformed to pearlite */
  pearl = 0;

  constructor(seed: number) {
    const rng = mulberry32(seed * 7919 + 13);
    const gs = seeds(rng, GRAINS);
    const grainShade = gs.map(() => 0.93 + 0.12 * rng());
    const cs = seeds(rng, COLONY);
    for (let k = 0; k < cs.length; k++) {
      const th = rng() * Math.PI;
      this.colAngle.push({ c: Math.cos(th), s: Math.sin(th), ph: rng() * 10 });
    }
    const n1 = noiseField(rng, 12);
    const n2 = noiseField(rng, 32);
    const key = new Float32Array(N);
    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        let d1 = 1e9;
        let d2 = 1e9;
        let g1 = 0;
        for (let k = 0; k < gs.length; k++) {
          const d = Math.hypot(wrapD(x - gs[k]![0]), wrapD(y - gs[k]![1]));
          if (d < d1) {
            d2 = d1;
            d1 = d;
            g1 = k;
          } else if (d < d2) d2 = d;
        }
        let best = 1e9;
        let bk = 0;
        for (let k = 0; k < cs.length; k++) {
          const d = Math.hypot(wrapD(x - cs[k]![0]), wrapD(y - cs[k]![1]));
          if (d < best) {
            best = d;
            bk = k;
          }
        }
        const i = y * G + x;
        this.bd[i] = (d2 - d1) / 2;
        this.shade[i] = grainShade[g1]!;
        this.colony[i] = bk;
        key[i] = this.bd[i]! + 6 * (n1(x, y) - 0.5) + 3 * (n2(x, y) - 0.5);
      }
    }
    // Rank → uniform [0, 1]
    const rank = (k: Float32Array, out: Float32Array) => {
      const idx = Uint32Array.from({ length: N }, (_, i) => i);
      idx.sort((a, b) => k[a]! - k[b]!);
      for (let r = 0; r < N; r++) out[idx[r]!] = r / (N - 1);
    };
    rank(key, this.rb);
    const tk = new Float32Array(N);
    for (let y = 0; y < G; y++)
      for (let x = 0; x < G; x++)
        tk[y * G + x] = -Math.sin(x * 1.3) * Math.sin(y * 1.3 + x * 0.35) + 0.5 * n2(x + 40, y + 17);
    rank(tk, this.tex);
  }

  /**
   * Update the constituents for an alloy c (wt% C) at T (°C).
   * `steps` is the elapsed simulation time (it drives the eutectoid kinetics);
   * `equilibrate` jumps to the finished microstructure at this state.
   */
  update(c: number, T: number, steps: number, equilibrate = false) {
    const dT = T_EUTD - T;
    if (dT < 0) {
      this.pearl = 0;
    } else if (equilibrate) {
      this.pearl = 1;
    } else if (dT > 0) {
      this.pearl = Math.min(1, this.pearl + (steps * 0.002 * dT) / (dT + 25));
    }
    // Below 727 °C the proeutectoid constituents stay as they were at the eutectoid temperature
    const lay: Layout =
      c >= 6.6
        ? { bands: [{ upTo: 1, code: CEMENTITE }], ledCov: F_LEDEB }
        : bands(c, Math.max(T, T_EUTD + 0.5));
    const bs = lay.bands;
    this.ledCov = lay.ledCov;
    const pitchNow = Math.min(14, Math.max(5.5, 220 / (Math.max(dT, 0) + 12)));
    for (let i = 0; i < N; i++) {
      const r = this.rb[i]!;
      let lo = 0;
      let bi = 0;
      while (bi < bs.length - 1 && r >= bs[bi]!.upTo) {
        lo = bs[bi]!.upTo;
        bi++;
      }
      let code = bs[bi]!.code;
      if (dT >= 0 && this.pearl > 0 && (code === GAMMA || code === C_LEDEB)) {
        const hi = bs[bi]!.upTo;
        const rp = hi > lo ? (r - lo) / (hi - lo) : 0;
        if (rp <= this.pearl) {
          code = code === GAMMA ? C_PEARL : C_LEDEB_P;
          if (this.pitch[i] === 0) this.pitch[i] = pitchNow;
        } else this.pitch[i] = 0;
      } else this.pitch[i] = 0;
      this.code[i] = code;
    }
  }

  /** RGBA pixels, G×G */
  paint(out: Uint8ClampedArray) {
    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        const i = y * G + x;
        const code = this.code[i]!;
        const base = COLORS[code]!;
        let r = base[0];
        let g = base[1];
        let b = base[2];
        if (code === C_PEARL || code === C_LEDEB_P) {
          const p = this.pitch[i]!;
          if (code === C_PEARL && p > 0) {
            const ca = this.colAngle[this.colony[i]!]!;
            const s = (x * ca.c + y * ca.s) / p + ca.ph;
            const u = s - Math.floor(s);
            const d = Math.min(u, 1 - u) * p;
            // Box-filtered stripe of width F_PEARL·p, so the Fe₃C area is the lever-rule fraction
            const hw = (F_PEARL * p) / 2;
            const cov = Math.max(0, Math.min(hw, d + 0.5) - Math.max(-hw, d - 0.5));
            const cem = COLORS[C_CEM]!;
            r += (cem[0] - r) * cov;
            g += (cem[1] - g) * cov;
            b += (cem[2] - b) * cov;
          }
        }
        if (code === C_LEDEB || code === C_LEDEB_P) {
          // Fe₃C rods/dots in the eutectic mixture
          // Austenite inside transformed ledeburite is pearlite, which holds F_PEARL of Fe₃C
          const frac = code === C_LEDEB_P ? this.ledCov + (1 - this.ledCov) * F_PEARL : this.ledCov;
          const cov = this.tex[i]! < frac ? 1 : 0;
          const cem = COLORS[C_CEM]!;
          r += (cem[0] - r) * cov;
          g += (cem[1] - g) * cov;
          b += (cem[2] - b) * cov;
        }
        if (code !== C_L) {
          const f = this.shade[i]! * (this.bd[i]! < 0.9 ? 0.55 : 1);
          r *= f;
          g *= f;
          b *= f;
        }
        const o = i * 4;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = 255;
      }
    }
  }
}
