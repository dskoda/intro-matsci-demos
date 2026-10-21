/**
 * Lattice Monte Carlo of a binary alloy with phase labels. Pure model: no DOM.
 *
 * Each site holds an atom (A or B) and a phase label (L, α, β, or an inert
 * inoculant particle). The energy is the sum of the on-site free energies of
 * `thermo.ts` plus J per nearest-neighbour bond between different phases:
 *   E = Σ_i e_{φ_i}(s_i, T) + J Σ_<ij> [φ_i ≠ φ_j]
 * Within a phase, atoms mix ideally, so large domains reproduce the convex-hull
 * phase diagram: tie-line compositions and lever-rule fractions emerge.
 *
 * Moves (Metropolis, kT = T):
 *  - phase flip of one site (non-conserved: melting, solidification, α ↔ β)
 *  - swap of an A–B neighbour pair (conserved: diffusion). Swaps involving a
 *    solid site are attempted with probability dSolid (slow solid diffusion).
 *
 * J = jRed · T keeps the phase-label field ordered at every temperature, while
 * small enough for solid to nucleate on inoculant particles at modest undercooling.
 */

import { mulberry32 } from '../strengthening/strengthening';
import type { SystemDef } from './thermo';

export const N = 128;
export const INERT = 3;
const NP = 4; // phase labels incl. inert
// Ordering transition of the phase labels: J/kT = 0.88 (two labels, Ising) and 1.005 (three, Potts)
const J_RED: Record<SystemDef['id'], number> = { iso: 1.0, eut: 1.15 };
export const INOC_R = 3;
const INOC_SOLID = 1; // solid–inoculant bond: J/2

/** Interface cost (in units of J/2) between two phase labels. Inoculants are partly wetted by solids. */
function bondCost(p: number, q: number): number {
  if (p === q) return 0;
  if (p === INERT || q === INERT) return p === 0 || q === 0 ? 2 : INOC_SOLID;
  return 2;
}
const COST = new Uint8Array(NP * NP);
for (let p = 0; p < NP; p++) for (let q = 0; q < NP; q++) COST[p * NP + q] = bondCost(p, q);

export interface PhaseStats {
  /** Fraction of (non-inert) sites in each phase */
  frac: number[];
  /** B fraction of all sites in each phase (NaN if absent) */
  x: number[];
  /** B fraction of sites with no neighbour of another phase (NaN if none) */
  xBulk: number[];
}

export class LatticeMC {
  readonly species = new Uint8Array(N * N);
  readonly phase = new Uint8Array(N * N);
  /** Monte Carlo time in sweeps */
  time = 0;
  dSolid = 1;
  /** Interface energy per unlike bond in units of kT */
  jRed: number;
  private sys: SystemDef;
  private T = 1000;
  private rng: () => number;
  private nActive = N * N;
  private nB = 0;
  // Acceptance tables, rebuilt when T changes
  private flipAcc = new Float64Array(NP * NP * 2 * 17);
  private swapAcc = new Float64Array(NP * NP);
  private nbr = new Int32Array(N * N * 4);

  constructor(sys: SystemDef, seed: number) {
    this.sys = sys;
    this.jRed = J_RED[sys.id];
    this.rng = mulberry32(seed);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = j * N + i;
        this.nbr[4 * c] = j * N + ((i + 1) % N);
        this.nbr[4 * c + 1] = j * N + ((i + N - 1) % N);
        this.nbr[4 * c + 2] = ((j + 1) % N) * N + i;
        this.nbr[4 * c + 3] = ((j + N - 1) % N) * N + i;
      }
    }
  }

  get temperature(): number {
    return this.T;
  }

  /** Random solution of composition x0, all in phase `p0`, with optional inoculants. */
  reset(x0: number, T: number, p0: number, inoculants: number): void {
    this.time = 0;
    this.phase.fill(p0);
    for (let k = 0; k < inoculants; k++) {
      const ci = Math.floor(this.rng() * N);
      const cj = Math.floor(this.rng() * N);
      for (let dj = -INOC_R; dj <= INOC_R; dj++) {
        for (let di = -INOC_R; di <= INOC_R; di++) {
          if (di * di + dj * dj > INOC_R * INOC_R + 1) continue;
          this.phase[((cj + dj + N) % N) * N + ((ci + di + N) % N)] = INERT;
        }
      }
    }
    this.nActive = 0;
    this.nB = 0;
    for (let c = 0; c < N * N; c++) {
      if (this.phase[c] === INERT) {
        this.species[c] = 0;
        continue;
      }
      this.nActive++;
      const s = this.rng() < x0 ? 1 : 0;
      this.species[c] = s;
      this.nB += s;
    }
    this.setT(T);
    this.setComposition(x0);
  }

  get composition(): number {
    return this.nB / this.nActive;
  }

  /** Transmute random atoms until the overall B fraction equals x0 (alloying). */
  setComposition(x0: number): void {
    const target = Math.round(x0 * this.nActive);
    let guard = 0;
    while (this.nB !== target && guard++ < 50 * N * N) {
      const c = Math.floor(this.rng() * N * N);
      if (this.phase[c] === INERT) continue;
      if (this.nB < target && this.species[c] === 0) {
        this.species[c] = 1;
        this.nB++;
      } else if (this.nB > target && this.species[c] === 1) {
        this.species[c] = 0;
        this.nB--;
      }
    }
  }

  setT(T: number): void {
    this.T = T;
    const nPh = this.sys.phases.length;
    const e = (p: number, s: 0 | 1) => (p < nPh ? this.sys.e(this.sys.phases[p]!, s, T) : 0);
    for (let p = 0; p < nPh; p++) {
      for (let q = 0; q < nPh; q++) {
        for (let s = 0; s < 2; s++) {
          const de = (e(q, s as 0 | 1) - e(p, s as 0 | 1)) / T;
          for (let dn = -8; dn <= 8; dn++) {
            const b = de + 0.5 * this.jRed * dn;
            this.flipAcc[((p * NP + q) * 2 + s) * 17 + dn + 8] = b <= 0 ? 1 : Math.exp(-b);
          }
        }
      }
    }
    // Moving a B atom from phase p into phase q (and an A atom the other way)
    for (let p = 0; p < nPh; p++) {
      for (let q = 0; q < nPh; q++) {
        const b = (e(q, 1) + e(p, 0) - e(p, 1) - e(q, 0)) / T;
        this.swapAcc[p * NP + q] = b <= 0 ? 1 : Math.exp(-b);
      }
    }
  }

  /** One Monte Carlo sweep: N² phase-flip attempts and N² swap attempts. */
  sweep(): void {
    const { species, phase, nbr, flipAcc, swapAcc, rng } = this;
    const nPh = this.sys.phases.length;
    const NN = N * N;
    const dSolid = this.dSolid;
    for (let n = 0; n < NN; n++) {
      // Phase flip
      let c = (rng() * NN) | 0;
      const p = phase[c]!;
      if (p !== INERT) {
        let q = (rng() * (nPh - 1)) | 0;
        if (q >= p) q++;
        let dn = 0;
        for (let d = 0; d < 4; d++) {
          const r = phase[nbr[4 * c + d]!]!;
          dn += COST[q * NP + r]! - COST[p * NP + r]!;
        }
        const a = flipAcc[((p * NP + q) * 2 + species[c]!) * 17 + dn + 8]!;
        if (a >= 1 || rng() < a) phase[c] = q;
      }
      // Species swap with a neighbour
      c = (rng() * NN) | 0;
      const o = nbr[4 * c + ((rng() * 4) | 0)]!;
      const sc = species[c]!;
      if (sc === species[o]) continue;
      const pc = phase[c]!;
      const po = phase[o]!;
      if (pc === INERT || po === INERT) continue;
      if ((pc !== 0 || po !== 0) && dSolid < 1 && rng() >= dSolid) continue;
      // B atom moves from the B site's phase into the other site's phase
      const a = sc === 1 ? swapAcc[pc * NP + po]! : swapAcc[po * NP + pc]!;
      if (a >= 1 || rng() < a) {
        species[c] = 1 - sc;
        species[o] = sc;
      }
    }
    this.time++;
  }

  stats(): PhaseStats {
    const nPh = this.sys.phases.length;
    const cnt = new Array<number>(nPh).fill(0);
    const nb = new Array<number>(nPh).fill(0);
    const bc = new Array<number>(nPh).fill(0);
    const bb = new Array<number>(nPh).fill(0);
    for (let c = 0; c < N * N; c++) {
      const p = this.phase[c]!;
      if (p === INERT) continue;
      const s = this.species[c]!;
      cnt[p]!++;
      nb[p]! += s;
      let bulk = true;
      for (let d = 0; d < 4; d++) if (this.phase[this.nbr[4 * c + d]!] !== p) bulk = false;
      if (bulk) {
        bc[p]!++;
        bb[p]! += s;
      }
    }
    return {
      frac: cnt.map((v) => v / this.nActive),
      x: cnt.map((v, p) => (v > 0 ? nb[p]! / v : NaN)),
      xBulk: bc.map((v, p) => (v > 20 ? bb[p]! / v : NaN)),
    };
  }
}
