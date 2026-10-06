/**
 * Elastic / plastic deformation of a bar of close-packed atoms.
 *
 * Pure engine (no DOM, no three.js). Atoms interact through a Lennard-Jones
 * pair potential (shifted-force at the cutoff) in reduced units
 * (epsilon = sigma = mass = k_B = 1). The bar has free surfaces. Its two ends
 * are rigid "grips" of atoms: the left grip is fixed and the right grip is
 * displaced to load the bar.
 *
 * - 2D: a triangular lattice (one close-packed layer, the basal plane of hcp)
 * - 3D: an hcp crystal with ABAB stacking along the lattice z axis
 *
 * The crystal is rotated with respect to the bar axes before the bar is cut
 * out, so "pulling in direction phi" means a rotated lattice and a fixed bar.
 */

export type Dim = 2 | 3;

/** Nearest-neighbour spacing of the relaxed LJ crystal (sigma) */
export function latticeSpacing(dim: Dim): number {
  return dim === 2 ? 1.117 : 1.105;
}
/** Pair-potential cutoff (sigma) */
export const RC = 2.5;
const SKIN = 0.45;
/** Pairs closer than this (in units of A0) count as bonded */
export const BOND_CUT = 1.3;
const GRIP_WIDTH_FACTOR = 1.5;
export const DT = 0.005;
/** Langevin friction of the free atoms */
const GAMMA = 1.0;
/** Per-frame weight of the exponential filter on the measured force */
const SMOOTH = 0.12;

const RC2 = RC * RC;
const FC = 24 * (2 * Math.pow(RC, -13) - Math.pow(RC, -7));

export interface BarOptions {
  dim: Dim;
  /** Angle of the close-packed rows to the pulling axis x (degrees) */
  angle: number;
  /** hcp c-axis tilt out of the bar plane (degrees, 3D only) */
  tilt: number;
  /** V-notch in the top edge */
  notch: boolean;
  /** Bar size, 0 (smallest) to SIZES - 1 */
  size: number;
  temperature: number;
  seed: number;
}

/** Bar dimensions per size: length in lattice spacings, rows (2D) or rows and layers-height (3D) */
const BAR_SIZES: Record<Dim, { nx: number; ny: number; nz: number }[]> = {
  2: [
    { nx: 22, ny: 10, nz: 0 },
    { nx: 36, ny: 16, nz: 0 },
    { nx: 50, ny: 22, nz: 0 },
    { nx: 70, ny: 30, nz: 0 },
  ],
  3: [
    { nx: 12, ny: 6, nz: 2.9 },
    { nx: 16, ny: 8, nz: 3.6 },
    { nx: 20, ny: 10, nz: 4.4 },
    { nx: 24, ny: 12, nz: 5.2 },
  ],
};
export const SIZE_COUNT = 4;

/** Calls fn(i, j, r2) for every pair of points closer than `cutoff` (cell grid) */
function forEachPair(
  pos: ArrayLike<number>,
  n: number,
  cutoff: number,
  fn: (i: number, j: number, r2: number) => void
): void {
  if (n === 0) return;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < 3; d++) {
      const v = pos[3 * i + d]!;
      if (v < lo[d]!) lo[d] = v;
      if (v > hi[d]!) hi[d] = v;
    }
  }
  const dims = [0, 1, 2].map((d) => Math.max(1, Math.floor((hi[d]! - lo[d]!) / cutoff) + 1));
  const cellOf = (i: number): number => {
    const c = [0, 1, 2].map((d) =>
      Math.min(dims[d]! - 1, Math.floor((pos[3 * i + d]! - lo[d]!) / cutoff))
    );
    return c[0]! + dims[0]! * (c[1]! + dims[1]! * c[2]!);
  };
  const head = new Int32Array(dims[0]! * dims[1]! * dims[2]!).fill(-1);
  const next = new Int32Array(n);
  const cell = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    cell[i] = cellOf(i);
    next[i] = head[cell[i]!]!;
    head[cell[i]!] = i;
  }
  const c2 = cutoff * cutoff;
  for (let i = 0; i < n; i++) {
    const ci = cell[i]!;
    const cx = ci % dims[0]!;
    const cy = Math.floor(ci / dims[0]!) % dims[1]!;
    const cz = Math.floor(ci / (dims[0]! * dims[1]!));
    for (let z = Math.max(0, cz - 1); z <= Math.min(dims[2]! - 1, cz + 1); z++) {
      for (let y = Math.max(0, cy - 1); y <= Math.min(dims[1]! - 1, cy + 1); y++) {
        for (let x = Math.max(0, cx - 1); x <= Math.min(dims[0]! - 1, cx + 1); x++) {
          for (let j = head[x + dims[0]! * (y + dims[1]! * z)]!; j >= 0; j = next[j]!) {
            if (j <= i) continue;
            const dx = pos[3 * i]! - pos[3 * j]!;
            const dy = pos[3 * i + 1]! - pos[3 * j + 1]!;
            const dz = pos[3 * i + 2]! - pos[3 * j + 2]!;
            const r2 = dx * dx + dy * dy + dz * dz;
            if (r2 < c2) fn(i, j, r2);
          }
        }
      }
    }
  }
}

export type Role = 0 | 1 | 2; // free, left grip, right grip

/** Small seeded RNG (mulberry32) */
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

function rotationMatrix(angleDeg: number, tiltDeg: number): number[] {
  // R = Ry(tilt) * Rz(angle), row-major 3x3
  const a = (angleDeg * Math.PI) / 180;
  const b = (tiltDeg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  return [cb * ca, -cb * sa, sb, sa, ca, 0, -sb * ca, sb * sa, cb];
}

/** Raw lattice points (unrotated) around the origin within a given radius */
function latticePoints(dim: Dim, radius: number, a: number): number[][] {
  const pts: number[][] = [];
  const h = (a * Math.sqrt(3)) / 2;
  const c = a * Math.sqrt(8 / 3);
  const n = Math.ceil(radius / h) + 2;
  if (dim === 2) {
    for (let j = -n; j <= n; j++) {
      for (let i = -n - Math.ceil(n / 2); i <= n; i++) {
        pts.push([i * a + j * 0.5 * a, j * h, 0]);
      }
    }
  } else {
    const nk = Math.ceil(radius / (c / 2)) + 1;
    for (let k = -nk; k <= nk; k++) {
      const off = Math.abs(k) % 2 === 1 ? [a / 2, a / (2 * Math.sqrt(3))] : [0, 0];
      for (let j = -n; j <= n; j++) {
        for (let i = -n - Math.ceil(n / 2); i <= n; i++) {
          pts.push([i * a + j * 0.5 * a + off[0]!, j * h + off[1]!, (k * c) / 2]);
        }
      }
    }
  }
  return pts;
}

export class Bar {
  readonly dim: Dim;
  /** Nearest-neighbour spacing (reference bond length) */
  readonly a: number;
  n = 0;
  pos!: Float64Array;
  vel!: Float64Array;
  frc!: Float64Array;
  /** Positions at the start (undeformed, relaxed) */
  ref!: Float64Array;
  role!: Uint8Array;
  /** Bar size */
  lx = 0;
  ly = 0;
  lz = 0;
  /** Cross-section carrying the load (per unit width in 2D) */
  area = 1;
  /** Gauge length between the grips */
  gauge = 1;
  /** Right-grip displacement (x = pull, y = shear) */
  ux = 0;
  uy = 0;
  /** Instantaneous and smoothed force on the right grip along x (tension > 0) */
  force = 0;
  forceSmooth = 0;
  /** Displacement filtered with the same lag as forceSmooth, for pairing force and displacement */
  uxSmooth = 0;
  /** Residual force of the relaxed, unloaded bar (subtracted from readings) */
  private force0 = 0;
  /** Velocity of the pulled grip; the thermostat relaxes atoms towards a linear profile of it */
  private gripVx = 0;
  private gripVy = 0;
  private frac!: Float64Array;
  temperature: number;

  private rng: () => number;
  private gaussSpare: number | null = null;
  private pairI: number[] = [];
  private pairJ: number[] = [];
  private listPos!: Float64Array;
  private rightBase: number[] = [];
  private rightIdx: number[] = [];

  constructor(opts: BarOptions) {
    this.dim = opts.dim;
    this.a = latticeSpacing(opts.dim);
    this.temperature = opts.temperature;
    this.rng = makeRng(opts.seed);
    this.build(opts);
    this.relax();
  }

  // --- construction ----------------------------------------------------
  private build(opts: BarOptions): void {
    const dim = this.dim;
    const A0 = this.a;
    const h = (A0 * Math.sqrt(3)) / 2;
    const sz = BAR_SIZES[dim][Math.max(0, Math.min(SIZE_COUNT - 1, Math.round(opts.size)))]!;
    this.lx = sz.nx * A0;
    this.ly = sz.ny * h;
    this.lz = dim === 2 ? 0 : sz.nz * A0 * Math.sqrt(8 / 3);
    const R = rotationMatrix(opts.angle, dim === 3 ? opts.tilt : 0);
    const cx = this.lx / 2;
    const cy = this.ly / 2;
    const cz = this.lz / 2;
    const radius = Math.hypot(this.lx, this.ly, this.lz) / 2 + 2 * A0;
    const eps = 1e-3;
    const kept: number[][] = [];
    for (const p of latticePoints(dim, radius, this.a)) {
      const x = R[0]! * p[0]! + R[1]! * p[1]! + R[2]! * p[2]! + cx;
      const y = R[3]! * p[0]! + R[4]! * p[1]! + R[5]! * p[2]! + cy;
      const z = R[6]! * p[0]! + R[7]! * p[1]! + R[8]! * p[2]! + cz;
      if (x < -eps || x > this.lx + eps || y < -eps || y > this.ly + eps) continue;
      if (dim === 3 && (z < -eps || z > this.lz + eps)) continue;
      if (opts.notch) {
        const depth = this.ly * 0.3;
        const d = y - (this.ly - depth);
        if (d > -0.5 * A0 && Math.abs(x - cx) < Math.max(0, d + 0.5 * A0) * 0.45 + 0.05) continue;
      }
      kept.push([x, y, dim === 3 ? z : 0]);
    }

    // Remove dangling atoms left by the cut (iteratively)
    const minCn = dim === 2 ? 2 : 4;
    let atoms = kept;
    for (let pass = 0; pass < 3; pass++) {
      const flat = new Float64Array(3 * atoms.length);
      atoms.forEach((p, i) => flat.set(p, 3 * i));
      const cn = new Uint8Array(atoms.length);
      forEachPair(flat, atoms.length, BOND_CUT * this.a, (i, j) => {
        cn[i]!++;
        cn[j]!++;
      });
      const next = atoms.filter((_, i) => cn[i]! >= minCn);
      if (next.length === atoms.length) break;
      atoms = next;
    }

    const n = atoms.length;
    this.n = n;
    this.pos = new Float64Array(3 * n);
    this.vel = new Float64Array(3 * n);
    this.frc = new Float64Array(3 * n);
    this.role = new Uint8Array(n);
    let xmin = Infinity;
    let xmax = -Infinity;
    atoms.forEach((p, i) => {
      this.pos.set(p, 3 * i);
      xmin = Math.min(xmin, p[0]!);
      xmax = Math.max(xmax, p[0]!);
    });
    for (let i = 0; i < n; i++) {
      const x = this.pos[3 * i]!;
      if (x < xmin + GRIP_WIDTH_FACTOR * this.a) this.role[i] = 1;
      else if (x > xmax - GRIP_WIDTH_FACTOR * this.a) this.role[i] = 2;
    }
    this.lx = xmax - xmin;
    this.area = dim === 2 ? this.ly : this.ly * this.lz;
    this.rightIdx = [];
    for (let i = 0; i < n; i++) if (this.role[i] === 2) this.rightIdx.push(i);
    this.listPos = new Float64Array(3 * n);
    this.frac = new Float64Array(n);
    this.buildList();
    // random thermal velocities for the free atoms
    for (let i = 0; i < n; i++) {
      if (this.role[i] !== 0) continue;
      for (let d = 0; d < dim; d++)
        this.vel[3 * i + d] = this.gauss() * Math.sqrt(this.temperature);
    }
  }

  /** Short relaxation at low temperature; defines the reference state */
  private relax(): void {
    const t = this.temperature;
    this.temperature = 0;
    for (let s = 0; s < 500; s++) this.integrate(false);
    this.temperature = t;
    for (let s = 0; s < 300; s++) this.integrate(false);
    let f0 = 0;
    const nAvg = 400;
    for (let s = 0; s < nAvg; s++) {
      this.integrate(true);
      f0 += this.force;
    }
    this.force0 = f0 / nAvg;
    this.ref = Float64Array.from(this.pos);
    let lx = 0;
    let rx = 0;
    let nl = 0;
    let nr = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.role[i] === 1) {
        lx += this.pos[3 * i]!;
        nl++;
      } else if (this.role[i] === 2) {
        rx += this.pos[3 * i]!;
        nr++;
      }
    }
    this.gauge = rx / nr - lx / nl;
    for (let i = 0; i < this.n; i++) {
      this.frac[i] = clamp01((this.ref[3 * i]! - lx / nl) / this.gauge);
    }
    this.rightBase = this.rightIdx.map((i) => this.pos[3 * i]!);
    this.rightBaseY = this.rightIdx.map((i) => this.pos[3 * i + 1]!);
    this.ux = 0;
    this.uy = 0;
    this.forceSmooth = 0;
    this.uxSmooth = 0;
    this.force = 0;
  }
  private rightBaseY: number[] = [];

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
  }

  private listNeedsRebuild(): boolean {
    const lim = (SKIN / 2) * (SKIN / 2);
    const { n, pos, listPos } = this;
    for (let i = 0; i < n; i++) {
      const dx = pos[3 * i]! - listPos[3 * i]!;
      const dy = pos[3 * i + 1]! - listPos[3 * i + 1]!;
      const dz = pos[3 * i + 2]! - listPos[3 * i + 2]!;
      if (dx * dx + dy * dy + dz * dz > lim) return true;
    }
    return false;
  }

  /** Pairs within the neighbour list, for diagnostics (i, j arrays) */
  get pairs(): { i: number[]; j: number[] } {
    return { i: this.pairI, j: this.pairJ };
  }

  // --- dynamics --------------------------------------------------------
  private computeForces(): void {
    const { pos, frc, pairI, pairJ } = this;
    frc.fill(0);
    for (let p = 0; p < pairI.length; p++) {
      const i = pairI[p]!;
      const j = pairJ[p]!;
      const dx = pos[3 * i]! - pos[3 * j]!;
      const dy = pos[3 * i + 1]! - pos[3 * j + 1]!;
      const dz = pos[3 * i + 2]! - pos[3 * j + 2]!;
      let r2 = dx * dx + dy * dy + dz * dz;
      if (r2 > RC2) continue;
      if (r2 < 0.36) r2 = 0.36;
      const r = Math.sqrt(r2);
      const inv2 = 1 / r2;
      const s6 = inv2 * inv2 * inv2;
      const f = (24 * (2 * s6 * s6 - s6)) / r - FC; // radial, > 0 = repulsive
      const g = f / r;
      const fx = g * dx;
      const fy = g * dy;
      const fz = g * dz;
      frc[3 * i] = frc[3 * i]! + fx;
      frc[3 * i + 1] = frc[3 * i + 1]! + fy;
      frc[3 * i + 2] = frc[3 * i + 2]! + fz;
      frc[3 * j] = frc[3 * j]! - fx;
      frc[3 * j + 1] = frc[3 * j + 1]! - fy;
      frc[3 * j + 2] = frc[3 * j + 2]! - fz;
    }
  }

  private integrate(measure: boolean): void {
    const { n, pos, vel, frc, role, dim } = this;
    const half = 0.5 * DT;
    for (let i = 0; i < n; i++) {
      if (role[i] !== 0) continue;
      for (let d = 0; d < dim; d++) {
        vel[3 * i + d] = vel[3 * i + d]! + half * frc[3 * i + d]!;
        pos[3 * i + d] = pos[3 * i + d]! + DT * vel[3 * i + d]!;
      }
    }
    if (this.listNeedsRebuild()) this.buildList();
    this.computeForces();
    const c1 = Math.exp(-GAMMA * DT);
    const c2 = Math.sqrt(Math.max(this.temperature, 0) * (1 - c1 * c1));
    for (let i = 0; i < n; i++) {
      if (role[i] !== 0) continue;
      const f = this.frac[i]!;
      for (let d = 0; d < dim; d++) {
        vel[3 * i + d] = vel[3 * i + d]! + half * frc[3 * i + d]!;
        const stream = d === 0 ? f * this.gripVx : d === 1 ? f * this.gripVy : 0;
        vel[3 * i + d] =
          stream + c1 * (vel[3 * i + d]! - stream) + (c2 > 0 ? c2 * this.gauss() : 0);
      }
    }
    if (measure) {
      let f = 0;
      for (const i of this.rightIdx) f -= frc[3 * i]!;
      this.force = f - this.force0;
    }
  }

  /** Move the right grip to (ux, uy) displacement */
  private placeGrip(): void {
    this.rightIdx.forEach((i, k) => {
      this.pos[3 * i] = this.rightBase[k]! + this.ux;
      this.pos[3 * i + 1] = this.rightBaseY[k]! + this.uy;
    });
  }

  /**
   * Advance `steps` time steps while the right grip moves towards the target
   * displacement at no more than `speed` (sigma per unit time). Returns the
   * mean force on the right grip during the steps.
   */
  advance(steps: number, targetUx: number, targetUy: number, speed: number): number {
    let sum = 0;
    const maxMove = speed * DT;
    for (let s = 0; s < steps; s++) {
      const dx = clampStep(targetUx - this.ux, maxMove);
      const dy = clampStep(targetUy - this.uy, maxMove);
      this.ux += dx;
      this.uy += dy;
      this.gripVx = dx / DT;
      this.gripVy = dy / DT;
      this.placeGrip();
      this.integrate(true);
      sum += this.force;
    }
    const mean = sum / Math.max(steps, 1);
    this.forceSmooth += (mean - this.forceSmooth) * SMOOTH;
    this.uxSmooth += (this.ux - this.uxSmooth) * SMOOTH;
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
      const dz = pos[3 * i + 2]! - pos[3 * j + 2]!;
      if (dx * dx + dy * dy + dz * dz < cut2) {
        cn[i]!++;
        cn[j]!++;
      }
    }
    return cn;
  }

  /** Bonded pairs (closer than BOND_CUT * A0) with their relative stretch */
  bonds(): { i: number; j: number; strain: number }[] {
    const out: { i: number; j: number; strain: number }[] = [];
    const cut2 = Math.pow(BOND_CUT * this.a, 2);
    const { pos } = this;
    for (let p = 0; p < this.pairI.length; p++) {
      const i = this.pairI[p]!;
      const j = this.pairJ[p]!;
      const dx = pos[3 * i]! - pos[3 * j]!;
      const dy = pos[3 * i + 1]! - pos[3 * j + 1]!;
      const dz = pos[3 * i + 2]! - pos[3 * j + 2]!;
      const r2 = dx * dx + dy * dy + dz * dz;
      if (r2 < cut2) out.push({ i, j, strain: Math.sqrt(r2) / this.a - 1 });
    }
    return out;
  }

  /** True if the two grips are still connected through bonds */
  isConnected(): boolean {
    const n = this.n;
    const adj: number[][] = Array.from({ length: n }, () => []);
    const cut2 = Math.pow(1.5 * this.a, 2);
    const { pos } = this;
    for (let p = 0; p < this.pairI.length; p++) {
      const i = this.pairI[p]!;
      const j = this.pairJ[p]!;
      const dx = pos[3 * i]! - pos[3 * j]!;
      const dy = pos[3 * i + 1]! - pos[3 * j + 1]!;
      const dz = pos[3 * i + 2]! - pos[3 * j + 2]!;
      if (dx * dx + dy * dy + dz * dz < cut2) {
        adj[i]!.push(j);
        adj[j]!.push(i);
      }
    }
    // grips are rigid, so treat each grip as one node
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

  /** Stress (force per cross-section) and strain for the current state */
  get stress(): number {
    return this.forceSmooth / this.area;
  }
  /** Strain paired with `stress` (same filter lag) */
  get strainSmooth(): number {
    return this.uxSmooth / this.gauge;
  }
  get strain(): number {
    return this.ux / this.gauge;
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function clampStep(delta: number, max: number): number {
  return Math.abs(delta) <= max ? delta : Math.sign(delta) * max;
}
