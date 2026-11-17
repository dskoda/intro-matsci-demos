/**
 * Band diagrams and carrier density (Lecture 14: Electrical properties)
 *
 * Pure module, no DOM and no three.js.
 *
 * Physics: a metal has a partly filled band, so its density of free electrons is large and
 * practically independent of temperature. In an intrinsic semiconductor or insulator the
 * valence band is full and the conduction band is empty at T = 0. Heat promotes electrons
 * across the gap Eg, giving n = p = sqrt(Nc Nv) (T/300)^(3/2) exp(-Eg / 2kT), in cm^-3.
 * The curve is computed in log10 so that huge gaps do not underflow.
 *
 * Schematic part: real densities span 20 orders of magnitude, so the dots drawn in the band
 * diagram are proportional to log10(n) between `LOG_N_MIN` and `LOG_N_MAX` (see `dotCount`).
 * `BandSim` moves those dots around: it creates and annihilates electron-hole pairs for a
 * gap material and flickers the occupation near the Fermi level for a metal.
 */

/** Boltzmann constant in eV/K. */
export const KB_EV = 8.617333e-5;

/** Slot grid of one band: row 0 is the bottom of the band. */
export const ROWS = 10;
export const COLS = 14;
export const NSLOT = ROWS * COLS;

/** Highest temperature of the demo, in K. */
export const T_MAX = 1500;

/** Density of free electrons in a metal (about copper), cm^-3. */
export const METAL_N = 8.5e22;

/** Effective densities of states at 300 K (silicon-like), cm^-3. */
const NC_300 = 2.8e19;
const NV_300 = 1.04e19;

/** Gaps above this are called insulators (eV). */
export const INSULATOR_GAP = 3;

export type Kind = 'metal' | 'gap';
export type Material = 'metal' | 'semiconductor' | 'insulator';

export interface Preset {
  id: Material;
  label: string;
  gap: number;
}

export const PRESETS: Preset[] = [
  { id: 'metal', label: 'Metal (partly filled band)', gap: 0 },
  { id: 'semiconductor', label: 'Semiconductor (Si, 1.12 eV)', gap: 1.12 },
  { id: 'insulator', label: 'Insulator (diamond, 5.5 eV)', gap: 5.5 },
];

/** Name of a gap material for display. */
export function classify(kind: Kind, gap: number): Material {
  if (kind === 'metal') return 'metal';
  return gap < INSULATOR_GAP ? 'semiconductor' : 'insulator';
}

/** log10 of the carrier density (cm^-3) available for conduction. -Infinity at T = 0. */
export function log10Density(kind: Kind, gap: number, T: number): number {
  if (kind === 'metal') return Math.log10(METAL_N);
  if (T <= 0) return -Infinity;
  const lnPrefactor = 0.5 * Math.log(NC_300 * NV_300) + 1.5 * Math.log(T / 300);
  const ln = lnPrefactor - gap / (2 * KB_EV * T);
  return ln / Math.LN10;
}

/** Carrier density in cm^-3 (0 when it underflows). */
export function density(kind: Kind, gap: number, T: number): number {
  const l = log10Density(kind, gap, T);
  return Number.isFinite(l) ? Math.pow(10, l) : 0;
}

/** Schematic dots: zero below 10^LOG_N_MIN cm^-3, `MAX_PAIRS` at 10^LOG_N_MAX. */
export const LOG_N_MIN = 9;
export const LOG_N_MAX = 19;
export const MAX_PAIRS = 24;

export function dotCount(kind: Kind, gap: number, T: number): number {
  if (kind === 'metal') return 0;
  const l = log10Density(kind, gap, T);
  if (!Number.isFinite(l)) return 0;
  const x = (l - LOG_N_MIN) / (LOG_N_MAX - LOG_N_MIN);
  return MAX_PAIRS * Math.min(1, Math.max(0, x));
}

/** Fermi-Dirac occupation for an energy offset `e` from E_F in units of kT. */
export function fermi(e: number): number {
  if (e > 40) return 0;
  if (e < -40) return 1;
  return 1 / (1 + Math.exp(e));
}

/** An electron-hole pair. `phase`: 0 electron rising, 1 free, 2 electron falling back. */
export interface Pair {
  cb: number;
  vb: number;
  phase: 0 | 1 | 2;
  t: number;
}

/** Duration of the jump across the gap, in s. */
export const JUMP_TIME = 0.7;

const REC_RATE = 0.4;
const CATCHUP = 3;

export class BandSim {
  kind: Kind = 'gap';
  gap = 1.12;
  temperature = 300;

  /** Gap material: pairs, and which slots they use. */
  pairs: Pair[] = [];
  cbUsed = new Uint8Array(NSLOT);
  /** Hole slots in the valence band (a hole sits on an empty slot). */
  vbHole = new Uint8Array(NSLOT);

  /** Metal: fixed random numbers per slot (occupied when below the Fermi factor). */
  private u = new Float32Array(NSLOT);
  occupied = new Uint8Array(NSLOT);

  time = 0;

  constructor() {
    for (let i = 0; i < NSLOT; i++) this.u[i] = Math.random();
    this.update(0);
  }

  /** Mean number of pairs the temperature asks for (schematic, see `dotCount`). */
  get target(): number {
    return dotCount(this.kind, this.gap, this.temperature);
  }

  /** Width (in rows) of the thermal spread of carriers around the band edge or E_F. */
  private spread(): number {
    return 0.08 + (0.25 * this.temperature) / T_MAX;
  }

  /** Fill the diagram with the equilibrium number of dots at once. */
  reset(): void {
    this.pairs = [];
    this.cbUsed.fill(0);
    this.vbHole.fill(0);
    for (let i = 0; i < NSLOT; i++) this.u[i] = Math.random();
    if (this.kind === 'gap') {
      const k = Math.round(this.target);
      for (let i = 0; i < k; i++) this.spawn(1);
    }
    this.update(0);
  }

  /** Number of electrons in the conduction band (those falling back no longer count). */
  get electrons(): number {
    let n = 0;
    for (const p of this.pairs) if (p.phase !== 2) n++;
    return n;
  }

  private pickSlot(used: Uint8Array, fromTop: boolean): number {
    const lam = this.spread();
    // Depth below the band edge (conduction band: height above the bottom edge).
    const free: number[] = new Array<number>(ROWS).fill(0);
    let edge = -1;
    for (let d = 0; d < ROWS; d++) {
      const row = fromTop ? ROWS - 1 - d : d;
      for (let c = 0; c < COLS; c++) if (!used[row * COLS + c]) free[d]!++;
      if (edge < 0 && free[d]! > 0) edge = d;
    }
    if (edge < 0) return -1;
    // Rows above the lowest row that still has room are reached only thermally.
    const w = free.map((f, d) => (d < edge ? 0 : f * Math.exp(-(d - edge) / lam)));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    let depth = edge;
    for (let d = edge; d < ROWS; d++) {
      r -= w[d]!;
      if (r <= 0) {
        depth = d;
        break;
      }
    }
    const row = fromTop ? ROWS - 1 - depth : depth;
    let k = Math.floor(Math.random() * free[depth]!);
    for (let c = 0; c < COLS; c++) {
      const slot = row * COLS + c;
      if (!used[slot] && k-- === 0) return slot;
    }
    return -1;
  }

  private spawn(phase: 0 | 1): void {
    const cb = this.pickSlot(this.cbUsed, false);
    const vb = this.pickSlot(this.vbHole, true);
    if (cb < 0 || vb < 0) return;
    this.cbUsed[cb] = 1;
    this.vbHole[vb] = 1;
    this.pairs.push({ cb, vb, phase, t: 0 });
  }

  /** Try to move a carrier to a neighbouring slot; thermal Metropolis rule on the row. */
  private hop(used: Uint8Array, slot: number, hole: boolean): number {
    const row = Math.floor(slot / COLS);
    const col = slot % COLS;
    const dir = Math.floor(Math.random() * 4);
    const dr = dir === 0 ? 1 : dir === 1 ? -1 : 0;
    const dc = dir === 2 ? 1 : dir === 3 ? -1 : 0;
    const nr = row + dr;
    const nc = col + dc;
    if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) return slot;
    const next = nr * COLS + nc;
    if (used[next]) return slot;
    // Electrons cost energy going up the conduction band, holes going down the valence band.
    const dE = hole ? -dr : dr;
    if (dE > 0 && Math.random() > Math.exp(-dE / this.spread())) return slot;
    used[slot] = 0;
    used[next] = 1;
    return next;
  }

  /** Advance by dt seconds. */
  step(dt: number): void {
    this.time += dt;
    this.update(dt);
  }

  private update(dt: number): void {
    if (this.kind === 'metal') {
      this.updateMetal(dt);
      return;
    }
    if (dt <= 0) return;
    const k = this.target;
    let active = 0;
    for (const p of this.pairs) if (p.phase !== 2) active++;

    // Generation (Poisson) with a boost when the pair number is below the target.
    const gen = (REC_RATE * k + CATCHUP * Math.max(0, k - active)) * dt;
    let nGen = Math.floor(gen) + (Math.random() < gen - Math.floor(gen) ? 1 : 0);
    while (nGen-- > 0) this.spawn(0);

    const recRate = REC_RATE + (CATCHUP * Math.max(0, active - k)) / Math.max(active, 1);
    const hopRate = 2 + (6 * this.temperature) / T_MAX;
    const keep: Pair[] = [];
    for (const p of this.pairs) {
      p.t += dt;
      if (p.phase === 0 && p.t >= JUMP_TIME) {
        p.phase = 1;
        p.t = 0;
      } else if (p.phase === 1) {
        if (Math.random() < recRate * dt) {
          p.phase = 2;
          p.t = 0;
        } else if (Math.random() < hopRate * dt) {
          if (Math.random() < 0.5) p.cb = this.hop(this.cbUsed, p.cb, false);
          else p.vb = this.hop(this.vbHole, p.vb, true);
        }
      } else if (p.phase === 2 && p.t >= JUMP_TIME) {
        this.cbUsed[p.cb] = 0;
        this.vbHole[p.vb] = 0;
        continue;
      }
      keep.push(p);
    }
    this.pairs = keep;
  }

  private updateMetal(dt: number): void {
    const kd = 0.04 + (0.4 * this.temperature) / 300;
    const mid = (ROWS - 1) / 2;
    const rate = 0.6 + (2 * this.temperature) / T_MAX;
    const redraw = dt <= 0 ? 1 : Math.min(1, rate * dt);
    for (let i = 0; i < NSLOT; i++) {
      if (Math.random() < redraw) this.u[i] = Math.random();
      const row = Math.floor(i / COLS);
      this.occupied[i] = this.u[i]! < fermi((row - mid) / Math.min(kd, 2.2)) ? 1 : 0;
    }
  }
}
