/**
 * Notched plate: fracture, fatigue and creep of a 2D close-packed crystal.
 *
 * Pure engine (no DOM, no three.js). Atoms interact through a Morse pair
 * potential (shifted-force at the cutoff) in reduced units (mass = k_B = r0 = 1):
 *
 *   V(r) = D [ (1 - exp(-alpha (r - r0)))^2 - 1 ]
 *
 * `D` is the bond strength and `alpha` the inverse range of the bond. A short
 * range (large alpha) gives a sharp force peak: bonds snap and the crack runs
 * (brittle). A long range (small alpha) lets the tip blunt and atoms slip past
 * each other before bonds break (ductile).
 *
 * The plate is a triangular lattice with the close-packed rows along x. The top
 * and bottom two rows are rigid grips: the bottom grip is fixed and the top grip
 * pulls along y (mode I opening of an edge notch cut from the left side). The grips can
 * cover only the part of the edges nearest the notch mouth (`gripFraction`).
 */

import { forEachPair } from '../elastic-plastic/elasticPlastic';

export const DT = 0.005;
/** Pair-potential cutoff (r0) */
export const RC = 2.3;
const SKIN = 0.4;
/** Pairs closer than this (in units of the lattice spacing) are drawn as bonds */
export const BOND_CUT = 1.4;
/** A reference nearest-neighbour bond is counted as broken beyond this stretch */
const BROKEN = 1.4;
/** Langevin friction of the free atoms */
const GAMMA = 0.5;
const SMOOTH = 0.08;
/** The pulled grip is a light rigid body so that cyclic loading is quasi-static */
const GRIP_MASS_FACTOR = 0.1;
const GRIP_ROWS = 2;
/** Damage starts at this fraction of the stretch of maximum bond force (see Specimen.damageRate) */
const DAMAGE_ONSET = 0.5;
/** Bonds with at least this damage no longer hold the plate together */
const DEAD = 0.95;
/** Neighbours of an atom in the bulk of the triangular lattice */
const FULL_COORDINATION = 6;

export interface MorseParams {
  /** Bond strength */
  D: number;
  /** Inverse range (1 / r0) */
  alpha: number;
}

/** Radial force of the shifted-force Morse potential (> 0 = repulsive) */
export function morseForce(r: number, p: MorseParams): number {
  const raw = (x: number): number => {
    const e = Math.exp(-p.alpha * (x - 1));
    return -2 * p.D * p.alpha * e * (1 - e);
  };
  return raw(r) - raw(RC);
}

/** Nearest-neighbour spacing of the relaxed triangular crystal (zero pressure) */
export function latticeSpacing(p: MorseParams): number {
  // squared lengths of the triangular lattice in units of a^2: m^2 + mn + n^2
  const shells = new Map<number, number>();
  for (let m = -6; m <= 6; m++) {
    for (let n = -6; n <= 6; n++) {
      const s = m * m + m * n + n * n;
      if (s > 0) shells.set(s, (shells.get(s) ?? 0) + 1);
    }
  }
  const virial = (a: number): number => {
    let sum = 0;
    for (const [s, count] of shells) {
      const r = a * Math.sqrt(s);
      if (r < RC) sum += count * r * morseForce(r, p);
    }
    return sum;
  };
  let lo = 0.8;
  let hi = 1.3;
  for (let k = 0; k < 50; k++) {
    const mid = 0.5 * (lo + hi);
    // compressed lattice: repulsive net virial (> 0)
    if (virial(mid) > 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * - notch: edge notch cut from the left side at mid-height
 * - void: no notch, a round void in the middle of the plate
 */
export type Setup = 'notch' | 'void';

export interface SpecimenOptions {
  setup: Setup;
  /**
   * Fraction of the plate width, counted from the left edge (the notch side),
   * that is gripped on the top and bottom edges. Below 1 only the part of the
   * plate near the notch mouth is pulled apart.
   */
  gripFraction: number;
  /** Void radius in lattice spacings (void setup) */
  voidRadius: number;
  /** Plate size, 0 (small) to SIZE_COUNT - 1 */
  size: number;
  /** Bond range parameter alpha (larger = shorter range = more brittle) */
  alpha: number;
  /** Bond strength D */
  D: number;
  /** Notch depth as a fraction of the plate width */
  depth: number;
  /** 0 = atomically sharp slit, 1 = round notch */
  roundness: number;
  temperature: number;
  seed: number;
}

/** Plate size in lattice spacings (columns) and close-packed rows */
const PLATE_SIZES = [
  { nx: 24, ny: 26 },
  { nx: 32, ny: 36 },
  { nx: 44, ny: 50 },
];
export const SIZE_COUNT = PLATE_SIZES.length;

/** Largest notch root radius, in lattice spacings */
const MAX_ROOT_RADIUS = 5;

/** How the top grip is driven (see Specimen.advance) */
export type Command =
  | { mode: 'displacement'; uy: number; speed: number }
  | {
      mode: 'force';
      /** Mean force */
      force: number;
      /** Amplitude of a sinusoidal force around the mean (cyclic loading) */
      amp: number;
      period: number;
      /** Time at which the oscillation phase is zero */
      t0: number;
      maxUy: number;
    };

export type Role = 0 | 1 | 2; // free, bottom grip (fixed), top grip (pulled)

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CrackInfo {
  /** Length of the notch plus crack, measured from the left edge */
  length: number;
  /** Number of broken nearest-neighbour bonds */
  broken: number;
}

export class Specimen {
  /** Nearest-neighbour spacing (reference bond length) */
  readonly a: number;
  readonly morse: MorseParams;
  n = 0;
  pos!: Float64Array;
  vel!: Float64Array;
  frc!: Float64Array;
  /** Relaxed positions before loading */
  ref!: Float64Array;
  role!: Uint8Array;
  /** Plate width (x) and height (y) */
  lx = 0;
  ly = 0;
  /** Gauge length between the grips and load-bearing width (gross section) */
  gauge = 1;
  width = 1;
  /** Initial notch length */
  notchLength = 0;
  /** Top-grip displacement along y */
  uy = 0;
  /** Instantaneous and smoothed force on the top grip along y (tension > 0) */
  force = 0;
  forceSmooth = 0;
  /** Displacement filtered with the same lag as forceSmooth */
  uySmooth = 0;
  /** Applied force of the last step in force control */
  appliedForce = 0;
  /** Simulation time */
  time = 0;
  temperature: number;
  /**
   * Cumulative bond damage rate (0 = off). A nearest-neighbour bond stretched
   * beyond half the stretch of maximum force loses part of its attraction, and the loss is never
   * recovered, and faster the fewer intact neighbours the bond's atoms have (the
   * load is shared by fewer bonds): rate x 6 / neighbours. This stands in for the irreversible slip at a real crack tip,
   * which a pair potential lacks, and makes a crack grow cycle by cycle.
   */
  damageRate = 0;
  /** Damage (0 to 1) of each reference nearest-neighbour bond */
  damage = new Float32Array(0);

  /** Number of intact reference neighbours of each atom (refreshed while damage accumulates) */
  private alive = new Uint8Array(0);
  private aliveCountdown = 0;
  private refKey = new Map<number, number>();
  private pairBond = new Int32Array(0);
  private bottomY = 0;
  private gripMass = 1;
  private gripDamp = 1;
  private gripVy = 0;
  private gamma = GAMMA;
  private frac!: Float64Array;
  private rng: () => number;
  private gaussSpare: number | null = null;
  private pairI: number[] = [];
  private pairJ: number[] = [];
  private listPos!: Float64Array;
  private topIdx: number[] = [];
  private topBase: number[] = [];
  private refI: number[] = [];
  private refJ: number[] = [];
  private seeds: number[] = [];
  private yc = 0;

  constructor(private opts: SpecimenOptions) {
    this.morse = { D: opts.D, alpha: opts.alpha };
    this.a = latticeSpacing(this.morse);
    this.temperature = opts.temperature;
    this.rng = makeRng(opts.seed);
    this.build();
    this.relax();
  }

  private build(): void {
    const { opts } = this;
    const A0 = this.a;
    const h = (A0 * Math.sqrt(3)) / 2;
    const sz = PLATE_SIZES[Math.max(0, Math.min(SIZE_COUNT - 1, Math.round(opts.size)))]!;
    this.lx = sz.nx * A0;
    this.ly = (sz.ny - 1) * h;
    this.width = this.lx;
    // the notch lies in the middle row, which is removed by the slit
    const jc = Math.round(sz.ny / 2);
    this.yc = jc * h;
    const an = Math.max(2 * A0, opts.depth * this.lx);
    const rho = opts.roundness * MAX_ROOT_RADIUS * A0;
    const b = Math.max(0.35 * h, Math.sqrt(rho * an));
    const hasNotch = opts.setup !== 'void';
    const rv = opts.voidRadius * A0;
    this.notchLength = hasNotch ? an : 2 * rv;

    let atoms: number[][] = [];
    for (let j = 0; j < sz.ny; j++) {
      for (let i = 0; i < sz.nx; i++) {
        const x = i * A0 + (j % 2 === 1 ? 0.5 * A0 : 0);
        const y = j * h;
        const ex = x / an;
        const ey = (y - this.yc) / b;
        if (hasNotch && ex * ex + ey * ey < 1 && j >= GRIP_ROWS && j < sz.ny - GRIP_ROWS) continue;
        if (!hasNotch && Math.hypot(x - this.lx / 2, y - this.ly / 2) < rv) continue;
        atoms.push([x, y, 0]);
      }
    }
    // remove atoms left dangling by the cut
    for (let pass = 0; pass < 3; pass++) {
      const flat = new Float64Array(3 * atoms.length);
      atoms.forEach((p, k) => flat.set(p, 3 * k));
      const cn = new Uint8Array(atoms.length);
      forEachPair(flat, atoms.length, 1.2 * A0, (i, j) => {
        cn[i]!++;
        cn[j]!++;
      });
      const next = atoms.filter((_, k) => cn[k]! >= 2);
      if (next.length === atoms.length) break;
      atoms = next;
    }

    const n = atoms.length;
    this.n = n;
    this.pos = new Float64Array(3 * n);
    this.vel = new Float64Array(3 * n);
    this.frc = new Float64Array(3 * n);
    this.role = new Uint8Array(n);
    atoms.forEach((p, i) => this.pos.set(p, 3 * i));
    const yGrip = GRIP_ROWS * h - 0.5 * h;
    const yTop = (sz.ny - 1) * h - (GRIP_ROWS - 1) * h - 0.5 * h;
    const gripX = Math.max(opts.gripFraction, 0.05) * this.lx + 0.5 * A0;
    for (let i = 0; i < n; i++) {
      const x = this.pos[3 * i]!;
      const y = this.pos[3 * i + 1]!;
      if (x > gripX) continue;
      if (y < yGrip) this.role[i] = 1;
      else if (y > yTop) this.role[i] = 2;
    }
    this.topIdx = [];
    for (let i = 0; i < n; i++) if (this.role[i] === 2) this.topIdx.push(i);
    this.listPos = new Float64Array(3 * n);
    this.frac = new Float64Array(n);
    this.buildList();
    for (let i = 0; i < n; i++) {
      if (this.role[i] !== 0) continue;
      for (let d = 0; d < 2; d++) this.vel[3 * i + d] = this.gauss() * Math.sqrt(this.temperature);
    }
  }

  /**
   * Relaxes the plate and defines the stress-free reference: surface relaxation
   * at T = 0, then the top grip is released at the target temperature and its
   * mean position becomes the zero-strain reference.
   */
  private relax(): void {
    const t = this.temperature;
    this.temperature = 0;
    for (let s = 0; s < 400; s++) this.integrate(false);

    let by = 0;
    let ty = 0;
    let nb = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.role[i] === 1) {
        by += this.pos[3 * i + 1]!;
        nb++;
      } else if (this.role[i] === 2) ty += this.pos[3 * i + 1]!;
    }
    this.bottomY = by / nb;
    this.gauge = ty / this.topIdx.length - this.bottomY;
    this.topBase = this.topIdx.map((i) => this.pos[3 * i + 1]!);
    this.gripMass = GRIP_MASS_FACTOR * this.topIdx.length;
    const partial = this.opts.gripFraction < 0.99;
    // partial grips pull against a softer (bending) plate than the full edges
    const nominalE =
      (partial ? this.opts.gripFraction * 0.5 : 1) *
      2.3 *
      this.morse.D *
      this.morse.alpha *
      this.morse.alpha;
    this.gripDamp = 2 * 0.8 * Math.sqrt(((nominalE * this.width) / this.gauge) * this.gripMass);
    this.uy = 0;
    this.gripVy = 0;

    // quick-min quench with a free grip: velocities are zeroed whenever the atoms move uphill
    this.gamma = 0;
    for (let s = 0; s < 600; s++) {
      this.stepForceControlled(0, Infinity);
      let power = 0;
      for (let i = 0; i < this.n; i++) {
        if (this.role[i] !== 0) continue;
        power += this.frc[3 * i]! * this.vel[3 * i]! + this.frc[3 * i + 1]! * this.vel[3 * i + 1]!;
      }
      if (power < 0 || this.gripVy * (this.appliedForce - this.force) < 0) {
        this.vel.fill(0);
        this.gripVy = 0;
      }
    }
    // then moderate friction, near critical for the slowest (whole-plate) mode
    this.gamma = 0.8;
    for (let s = 0; s < 2600; s++) this.stepForceControlled(0, Infinity);
    this.gamma = GAMMA;
    this.temperature = t;
    for (let i = 0; i < this.n; i++) {
      if (this.role[i] !== 0) continue;
      for (let d = 0; d < 2; d++) this.vel[3 * i + d] = this.gauss() * Math.sqrt(t);
    }
    const settle = 1100;
    const avgFrom = 600;
    let sum = 0;
    for (let s = 0; s < settle; s++) {
      this.stepForceControlled(0, Infinity);
      if (s >= avgFrom) sum += this.uy;
    }
    const shift = sum / (settle - avgFrom);
    for (let k = 0; k < this.topBase.length; k++) this.topBase[k] = this.topBase[k]! + shift;
    this.gauge += shift;
    this.uy = 0;
    this.gripVy = 0;
    this.ref = Float64Array.from(this.pos);
    for (let i = 0; i < this.n; i++) {
      // no streaming profile when only part of the edges move
      this.frac[i] = partial ? 0 : clamp01((this.ref[3 * i + 1]! - this.bottomY) / this.gauge);
    }
    this.forceSmooth = 0;
    this.uySmooth = 0;
    this.force = 0;
    this.time = 0;

    // reference nearest-neighbour bonds and atoms along the notch surface
    this.refI = [];
    this.refJ = [];
    const cn = new Uint8Array(this.n);
    forEachPair(this.ref, this.n, 1.2 * this.a, (i, j) => {
      this.refI.push(i);
      this.refJ.push(j);
      cn[i]!++;
      cn[j]!++;
    });
    this.refKey.clear();
    for (let k = 0; k < this.refI.length; k++) {
      const i = this.refI[k]!;
      const j = this.refJ[k]!;
      this.refKey.set(i < j ? i * this.n + j : j * this.n + i, k);
    }
    this.damage = new Float32Array(this.refI.length);
    this.buildList();
    const { opts } = this;
    const an = this.notchLength;
    const rho = opts.roundness * MAX_ROOT_RADIUS * this.a;
    const b = Math.max(0.35 * ((this.a * Math.sqrt(3)) / 2), Math.sqrt(rho * an));
    this.seeds = [];
    const rv = opts.voidRadius * this.a;
    for (let i = 0; i < this.n; i++) {
      if (cn[i]! >= 6 || this.role[i] !== 0) continue;
      if (opts.setup === 'void') {
        if (
          Math.hypot(this.ref[3 * i]! - this.lx / 2, this.ref[3 * i + 1]! - this.ly / 2) <
          rv + 1.5 * this.a
        ) {
          this.seeds.push(i);
        }
        continue;
      }
      const ex = this.ref[3 * i]! / (an + 1.5 * this.a);
      const ey = (this.ref[3 * i + 1]! - this.yc) / (b + 1.5 * this.a);
      if (ex * ex + ey * ey < 1) this.seeds.push(i);
    }
  }

  private gauss(): number {
    if (this.gaussSpare !== null) {
      const g = this.gaussSpare;
      this.gaussSpare = null;
      return g;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = this.rng();
    while (v === 0) v = this.rng();
    const m = Math.sqrt(-2 * Math.log(u));
    this.gaussSpare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  }

  // --- neighbour list --------------------------------------------------
  private buildList(): void {
    const { n, pos } = this;
    this.pairI = [];
    this.pairJ = [];
    forEachPair(pos, n, RC + SKIN, (i, j) => {
      if (this.role[i] !== 0 && this.role[i] === this.role[j]) return;
      this.pairI.push(i);
      this.pairJ.push(j);
    });
    this.listPos.set(pos);
    this.pairBond = new Int32Array(this.pairI.length);
    for (let p = 0; p < this.pairI.length; p++) {
      const i = this.pairI[p]!;
      const j = this.pairJ[p]!;
      this.pairBond[p] = this.refKey.get(i < j ? i * this.n + j : j * this.n + i) ?? -1;
    }
  }

  private listNeedsRebuild(): boolean {
    const lim = (SKIN / 2) * (SKIN / 2);
    const { n, pos, listPos } = this;
    for (let i = 0; i < n; i++) {
      const dx = pos[3 * i]! - listPos[3 * i]!;
      const dy = pos[3 * i + 1]! - listPos[3 * i + 1]!;
      if (dx * dx + dy * dy > lim) return true;
    }
    return false;
  }

  get pairCount(): number {
    return this.pairI.length;
  }

  // --- dynamics --------------------------------------------------------
  private computeForces(): void {
    const { pos, frc, pairI, pairJ, morse, pairBond, damage } = this;
    const dmgStep = this.damageRate * DT;
    if (dmgStep > 0 && this.aliveCountdown-- <= 0) {
      this.updateAlive();
      this.aliveCountdown = 10;
    }
    const alive = this.alive;
    const a0 = this.a;
    const onset = (DAMAGE_ONSET * Math.LN2) / morse.alpha;
    frc.fill(0);
    const rc2 = RC * RC;
    const fc = morseForce(RC, morse);
    const D2a = 2 * morse.D * morse.alpha;
    for (let p = 0; p < pairI.length; p++) {
      const i = pairI[p]!;
      const j = pairJ[p]!;
      const dx = pos[3 * i]! - pos[3 * j]!;
      const dy = pos[3 * i + 1]! - pos[3 * j + 1]!;
      let r2 = dx * dx + dy * dy;
      if (r2 > rc2) continue;
      if (r2 < 0.36) r2 = 0.36;
      const r = Math.sqrt(r2);
      const e = Math.exp(-morse.alpha * (r - 1));
      let f = -D2a * e * (1 - e) - fc; // radial, > 0 = repulsive
      const bond = pairBond[p]!;
      if (bond >= 0) {
        if (dmgStep > 0) {
          const s = r / a0 - 1;
          if (s > onset) {
            // the load is shared by the neighbours: atoms with fewer of them damage faster
            const share = FULL_COORDINATION / Math.max(1, Math.min(alive[i]!, alive[j]!));
            damage[bond] = Math.min(1, damage[bond]! + (dmgStep * share * (s - onset)) / onset);
          }
        }
        if (f < 0) f *= 1 - damage[bond]!;
      }
      const g = f / r;
      const fx = g * dx;
      const fy = g * dy;
      frc[3 * i] = frc[3 * i]! + fx;
      frc[3 * i + 1] = frc[3 * i + 1]! + fy;
      frc[3 * j] = frc[3 * j]! - fx;
      frc[3 * j + 1] = frc[3 * j + 1]! - fy;
    }
  }

  /** Counts the intact reference neighbours of every atom */
  private updateAlive(): void {
    if (this.alive.length !== this.n) this.alive = new Uint8Array(this.n);
    const alive = this.alive;
    alive.fill(0);
    const lim2 = Math.pow(BROKEN * this.a, 2);
    const { pos } = this;
    for (let k = 0; k < this.refI.length; k++) {
      const i = this.refI[k]!;
      const j = this.refJ[k]!;
      const dx = pos[3 * i]! - pos[3 * j]!;
      const dy = pos[3 * i + 1]! - pos[3 * j + 1]!;
      if (dx * dx + dy * dy <= lim2 && this.damage[k]! < DEAD) {
        alive[i]!++;
        alive[j]!++;
      }
    }
  }

  private integrate(measure: boolean): void {
    const { n, pos, vel, frc, role } = this;
    const half = 0.5 * DT;
    for (let i = 0; i < n; i++) {
      if (role[i] !== 0) continue;
      for (let d = 0; d < 2; d++) {
        vel[3 * i + d] = vel[3 * i + d]! + half * frc[3 * i + d]!;
        pos[3 * i + d] = pos[3 * i + d]! + DT * vel[3 * i + d]!;
      }
    }
    if (this.listNeedsRebuild()) this.buildList();
    this.computeForces();
    const c1 = Math.exp(-this.gamma * DT);
    const c2 = Math.sqrt(Math.max(this.temperature, 0) * (1 - c1 * c1));
    for (let i = 0; i < n; i++) {
      if (role[i] !== 0) continue;
      const stream = this.frac[i]! * this.gripVy;
      for (let d = 0; d < 2; d++) {
        vel[3 * i + d] = vel[3 * i + d]! + half * frc[3 * i + d]!;
        const s = d === 1 ? stream : 0;
        vel[3 * i + d] = s + c1 * (vel[3 * i + d]! - s) + (c2 > 0 ? c2 * this.gauss() : 0);
      }
    }
    this.time += DT;
    if (measure) {
      let f = 0;
      for (const i of this.topIdx) f -= frc[3 * i + 1]!;
      this.force = f;
    }
  }

  private placeGrip(): void {
    this.topIdx.forEach((i, k) => {
      this.pos[3 * i + 1] = this.topBase[k]! + this.uy;
    });
  }

  /** One step with the top grip as a free rigid body pulled by `force` along y */
  private stepForceControlled(force: number, maxUy: number): void {
    this.appliedForce = force;
    const acc = (force - this.force - this.gripDamp * this.gripVy) / this.gripMass;
    this.gripVy += acc * DT;
    this.uy += this.gripVy * DT;
    if (this.uy > maxUy) {
      this.uy = maxUy;
      this.gripVy = Math.min(0, this.gripVy);
    }
    this.placeGrip();
    this.integrate(true);
  }

  /**
   * Advance `steps` time steps and return the mean force on the top grip.
   *
   * - displacement control: the grip moves towards `uy` at no more than `speed`
   *   and the force is measured. With the grip at zero the plate is unloaded,
   *   so the stress is reported as zero instead of thermal noise.
   * - force control: the force is `force + amp sin(2 pi (t - t0) / period)`
   *   and the elongation is the response.
   */
  advance(steps: number, cmd: Command): number {
    let sum = 0;
    const maxMove = cmd.mode === 'displacement' ? cmd.speed * DT : 0;
    let reading = 0;
    for (let s = 0; s < steps; s++) {
      if (cmd.mode === 'displacement') {
        const dy = clampStep(cmd.uy - this.uy, maxMove);
        this.uy += dy;
        this.gripVy = dy / DT;
        this.placeGrip();
        this.integrate(true);
      } else {
        const f = cmd.force + cmd.amp * Math.sin((2 * Math.PI * (this.time - cmd.t0)) / cmd.period);
        this.stepForceControlled(f, cmd.maxUy);
        reading = f;
      }
      sum += this.force;
    }
    const mean = sum / Math.max(steps, 1);
    if (cmd.mode === 'displacement') {
      const unloaded = cmd.uy <= 1e-9 && this.uy <= 1e-9;
      reading = unloaded ? 0 : mean;
    }
    this.forceSmooth += (reading - this.forceSmooth) * SMOOTH;
    this.uySmooth += (this.uy - this.uySmooth) * SMOOTH;
    return mean;
  }

  // --- diagnostics -----------------------------------------------------
  /** Number of bonded neighbours of each atom */
  coordination(): Uint8Array {
    const cn = new Uint8Array(this.n);
    const cut2 = Math.pow(BOND_CUT * this.a, 2);
    const { pos } = this;
    for (let p = 0; p < this.pairI.length; p++) {
      const i = this.pairI[p]!;
      const j = this.pairJ[p]!;
      const dx = pos[3 * i]! - pos[3 * j]!;
      const dy = pos[3 * i + 1]! - pos[3 * j + 1]!;
      const bond = this.pairBond[p]!;
      if (dx * dx + dy * dy < cut2 && !(bond >= 0 && this.damage[bond]! >= DEAD)) {
        cn[i]!++;
        cn[j]!++;
      }
    }
    return cn;
  }

  /** Bonded pairs (closer than BOND_CUT * a) with their relative stretch */
  bonds(): { i: number; j: number; strain: number; damage: number }[] {
    const out: { i: number; j: number; strain: number; damage: number }[] = [];
    const cut2 = Math.pow(BOND_CUT * this.a, 2);
    const { pos } = this;
    for (let p = 0; p < this.pairI.length; p++) {
      const i = this.pairI[p]!;
      const j = this.pairJ[p]!;
      const dx = pos[3 * i]! - pos[3 * j]!;
      const dy = pos[3 * i + 1]! - pos[3 * j + 1]!;
      const r2 = dx * dx + dy * dy;
      if (r2 >= cut2) continue;
      const bond = this.pairBond[p]!;
      const d = bond >= 0 ? this.damage[bond]! : 0;
      if (d >= DEAD) continue;
      out.push({ i, j, strain: Math.sqrt(r2) / this.a - 1, damage: d });
    }
    return out;
  }

  /** Distance of each atom from its relaxed position, in lattice spacings */
  displacements(): Float32Array {
    const out = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const dx = this.pos[3 * i]! - this.ref[3 * i]!;
      const dy = this.pos[3 * i + 1]! - this.ref[3 * i + 1]!;
      out[i] = Math.hypot(dx, dy) / this.a;
    }
    return out;
  }

  /**
   * Notch plus crack length. The crack is the set of broken reference bonds
   * that chain to the notch surface; its length is the largest distance of
   * those atoms from the left edge.
   */
  crack(): CrackInfo {
    const adj = new Map<number, number[]>();
    let broken = 0;
    const lim2 = Math.pow(BROKEN * this.a, 2);
    const { pos, ref } = this;
    for (let k = 0; k < this.refI.length; k++) {
      const i = this.refI[k]!;
      const j = this.refJ[k]!;
      const dx = pos[3 * i]! - pos[3 * j]!;
      const dy = pos[3 * i + 1]! - pos[3 * j + 1]!;
      if (dx * dx + dy * dy > lim2 || this.damage[k]! >= DEAD) {
        broken++;
        (adj.get(i) ?? adj.set(i, []).get(i)!).push(j);
        (adj.get(j) ?? adj.set(j, []).get(j)!).push(i);
      }
    }
    const isVoid = this.opts.setup === 'void';
    let length = this.notchLength;
    let xMin = this.lx / 2 - this.notchLength / 2;
    let xMax = this.lx / 2 + this.notchLength / 2;
    const seen = new Set<number>();
    const stack: number[] = [];
    for (const s of this.seeds) {
      if (adj.has(s)) {
        seen.add(s);
        stack.push(s);
      }
    }
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = ref[3 * i]!;
      if (isVoid) {
        xMin = Math.min(xMin, x);
        xMax = Math.max(xMax, x);
        length = xMax - xMin;
      } else length = Math.max(length, x);
      for (const j of adj.get(i) ?? []) {
        if (!seen.has(j)) {
          seen.add(j);
          stack.push(j);
        }
      }
    }
    return { length, broken };
  }

  /** True if the two grips are still connected through bonds */
  isConnected(): boolean {
    const n = this.n;
    const adj: number[][] = Array.from({ length: n }, () => []);
    const cut2 = Math.pow(BROKEN * this.a, 2);
    const { pos } = this;
    for (let p = 0; p < this.pairI.length; p++) {
      const i = this.pairI[p]!;
      const j = this.pairJ[p]!;
      const dx = pos[3 * i]! - pos[3 * j]!;
      const dy = pos[3 * i + 1]! - pos[3 * j + 1]!;
      const bond = this.pairBond[p]!;
      if (dx * dx + dy * dy < cut2 && !(bond >= 0 && this.damage[bond]! >= DEAD)) {
        adj[i]!.push(j);
        adj[j]!.push(i);
      }
    }
    const seen = new Uint8Array(n);
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      if (this.role[i] === 1) {
        seen[i] = 1;
        stack.push(i);
      }
    }
    while (stack.length > 0) {
      const i = stack.pop()!;
      if (this.role[i] === 2) return true;
      for (const j of adj[i]!) {
        if (!seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    return false;
  }

  /** Positions of the top (pulled) and bottom grips: centre x and the edge facing the plate */
  gripPoints(): { top: { x: number; y: number }; bottom: { x: number; y: number } } {
    const out = { top: { x: 0, y: -Infinity }, bottom: { x: 0, y: Infinity } };
    let nt = 0;
    let nb = 0;
    for (let i = 0; i < this.n; i++) {
      const x = this.pos[3 * i]!;
      const y = this.pos[3 * i + 1]!;
      if (this.role[i] === 2) {
        out.top.x += x;
        out.top.y = Math.max(out.top.y, y);
        nt++;
      } else if (this.role[i] === 1) {
        out.bottom.x += x;
        out.bottom.y = Math.min(out.bottom.y, y);
        nb++;
      }
    }
    out.top.x /= Math.max(nt, 1);
    out.bottom.x /= Math.max(nb, 1);
    return out;
  }

  /** Nominal stress (force over the gross cross-section) paired with `strainSmooth` */
  get stress(): number {
    return this.forceSmooth / this.width;
  }
  get strainSmooth(): number {
    return this.uySmooth / this.gauge;
  }
  get strain(): number {
    return this.uy / this.gauge;
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function clampStep(delta: number, max: number): number {
  return Math.abs(delta) <= max ? delta : Math.sign(delta) * max;
}
