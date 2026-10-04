/**
 * 1D atomistic model of solute diffusion along a rod (pure logic, no DOM).
 *
 * Each lattice site i along the rod holds counts[i] solute atoms (0..CAPACITY), drawn as a
 * stack of circles. Site 0 is the surface reservoir: atoms there appear and disappear
 * randomly so that its mean occupancy stays at the surface concentration.
 *
 * One sweep: every solute atom attempts a hop with probability pHop = exp(-Q/kT), to the
 * left or right neighbour with equal chance (blocked by the rod end or a full site).
 * In units of sites and sweeps this gives D = pHop / 2.
 */

import { mulberry32 } from '../vacancy-diffusion/vacancy';

export const CAPACITY = 20;

export class SoluteRod {
  readonly n: number;
  readonly counts: Int32Array;
  private delta: Int32Array;
  private rand: () => number = Math.random;
  sweeps = 0;
  hops = 0;

  constructor(n: number) {
    this.n = n;
    this.counts = new Int32Array(n);
    this.delta = new Int32Array(n);
  }

  /** cs, c0: fractions (0..1) of CAPACITY for the surface and the initial rod. */
  reset(cs: number, c0: number, seed: number): void {
    this.rand = mulberry32(seed);
    this.sweeps = 0;
    this.hops = 0;
    this.counts.fill(Math.round(c0 * CAPACITY));
    this.counts[0] = Math.round(cs * CAPACITY);
  }

  get total(): number {
    let sum = 0;
    for (let i = 1; i < this.n; i++) sum += this.counts[i]!;
    return sum;
  }

  /**
   * One sweep.
   * @param pHop hop attempt probability per atom
   * @param exchange per-sweep probability scale for atoms appearing/disappearing at the surface
   * @param cs surface concentration as a fraction of CAPACITY
   */
  step(pHop: number, exchange: number, cs: number): void {
    const { n, counts, delta } = this;
    delta.fill(0);
    for (let i = 0; i < n; i++) {
      const c = counts[i]!;
      for (let k = 0; k < c; k++) {
        if (this.rand() >= pHop) continue;
        const j = this.rand() < 0.5 ? i - 1 : i + 1;
        if (j < 0 || j >= n) continue;
        if (j > 0 && counts[j]! + delta[j]! >= CAPACITY) continue;
        delta[i]! -= 1;
        delta[j]! += 1;
        this.hops++;
      }
    }
    for (let i = 0; i < n; i++) counts[i]! += delta[i]!;
    if (counts[0]! > CAPACITY) counts[0] = CAPACITY;

    // Surface reservoir: atoms leave / arrive, equilibrium occupancy = cs * CAPACITY
    const o = counts[0]!;
    let next = o;
    for (let k = 0; k < o; k++) if (this.rand() < exchange * (1 - cs)) next--;
    for (let k = 0; k < CAPACITY - o; k++) if (this.rand() < exchange * cs) next++;
    counts[0] = next;
    this.sweeps++;
  }
}
