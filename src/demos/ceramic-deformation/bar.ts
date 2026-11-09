/**
 * Tensile bar of an ionic crystal or of a glass (2D, pure engine, no DOM).
 *
 * Same set-up as the Lennard-Jones bar of the elastic/plastic demo: free
 * surfaces, a fixed left grip and a right grip that is displaced, with a
 * Langevin thermostat that relaxes the atoms towards the linear velocity profile
 * of the pulled grip. Reduced units (m = 1, sigma_AA = epsilon_AA = 1).
 *
 * - `ionic`: an AB ionic layer on a honeycomb (hexagonal) lattice, like hexagonal BN:
 *   cations +1 and anions -1 with a screened Coulomb term.
 * - `glass`: a Kob-Andersen glass quenched from the melt, then turned into a network of
 *   stiff bonds that snap for good when over-stretched (see glassParams).
 *   in a periodic box (see ../amorphous-glass/kobAndersen.ts) and then cut
 *   into a bar with free surfaces.
 *
 * All pair interactions use shifted-force tables in r^2, so both materials run
 * through the same fast force loop.
 */

import { forEachPair } from '../elastic-plastic/elasticPlastic';
import { KobAndersen2D, SIGMA, EPS } from '../amorphous-glass/kobAndersen';

export type Material = 'ionic' | 'glass';

export const DT = 0.005;
const SKIN = 0.45;
const GAMMA = 1.0;
const SMOOTH = 0.08;
const GRIP_WIDTH = 1.6;
const R2_MIN = 0.25;
const TABLE_N = 6000;
const NOMINAL_E = 250;

// ---- ionic pair potential ----------------------------------------------------------------
/**
 * An AB ionic layer on a honeycomb (hexagonal) lattice, like a layer of hexagonal BN:
 * cations (+1) and anions (-1) alternate, so every ion has three unlike neighbours at
 * distance d and six like neighbours at sqrt(3) d. Pair potential: core
 * B (sigma_pq / r)^12 plus screened Coulomb q_p q_q Q exp(-r / lambda) / r (attractive
 * for unlike, repulsive for like ions).
 */
export const ionicParams = {
  B: 1.0,
  sigCC: 1.0,
  sigCA: 1.0,
  sigAA: 1.0,
  Q: 150,
  lambda: 0.8,
  qCation: 1,
  qAnion: -1,
  /** Extra short-range repulsion between like ions: likeB (likeSigma / r)^12 */
  likeB: 5,
  likeSigma: 1.4,
  rc: 3.6,
  /** Langevin friction of the ions */
  gamma: 0.03,
};

/** Override the ionic potential (for tests); clears the cached tables */
export function setIonicParams(p: Partial<typeof ionicParams>): void {
  Object.assign(ionicParams, p);
  delete tableCache.ionic;
}

/** Species pair index: 0 = cation-cation, 1 = cation-anion, 2 = anion-anion */
function ionicV(r: number, pair: number): number {
  const P = ionicParams;
  const sig = pair === 0 ? P.sigCC : pair === 1 ? P.sigCA : P.sigAA;
  const qq = pair === 0 ? P.qCation ** 2 : pair === 1 ? P.qCation * P.qAnion : P.qAnion ** 2;
  const extra = pair === 1 ? 0 : P.likeB * Math.pow(P.likeSigma / r, 12);
  return P.B * Math.pow(sig / r, 12) + extra + (qq * P.Q * Math.exp(-r / P.lambda)) / r;
}
function ionicDV(r: number, pair: number): number {
  const P = ionicParams;
  const sig = pair === 0 ? P.sigCC : pair === 1 ? P.sigCA : P.sigAA;
  const qq = pair === 0 ? P.qCation ** 2 : pair === 1 ? P.qCation * P.qAnion : P.qAnion ** 2;
  const extra = pair === 1 ? 0 : (-12 * P.likeB * Math.pow(P.likeSigma / r, 12)) / r;
  return (
    (-12 * P.B * Math.pow(sig / r, 12)) / r +
    extra -
    qq * P.Q * Math.exp(-r / P.lambda) * (1 / (P.lambda * r) + 1 / (r * r))
  );
}

/**
 * Covalent-like glass: the amorphous topology comes from a Kob-Andersen quench, but
 * the interactions are a fixed network of stiff bonds (Lennard-Jones springs scaled
 * by `epsScale`) that break for good when stretched past `breakStretch` times their
 * rest length, plus repulsion only between atoms that are not bonded. Broken bonds
 * never re-form, so the glass cannot flow: it can only fracture.
 */
export const glassParams = {
  epsScale: 10,
  /** Pairs closer than this many rest lengths in the quenched glass become bonds */
  bondCut: 1.2,
  /** A bond breaks when stretched past this many rest lengths */
  breakStretch: 1.2,
  /** Density of the quench */
  density: 1.2,
  gamma: 0.01,
};

/** Override the glass interaction (for tests); clears the cached tables */
export function setGlassParams(p: Partial<typeof glassParams>): void {
  Object.assign(glassParams, p);
  delete tableCache.glass;
  glassRepulsion = null;
}

function kaV(sig: number, eps: number, r: number): number {
  const s6 = Math.pow(sig / r, 6);
  return 4 * eps * (s6 * s6 - s6);
}
function kaDV(sig: number, eps: number, r: number): number {
  const s6 = Math.pow(sig / r, 6);
  return (4 * eps * (-12 * s6 * s6 + 6 * s6)) / r;
}

interface PairTable {
  rc2: number;
  invH: number;
  /** f / r (radial force over distance), shifted-force */
  g: Float64Array;
  /** potential energy, shifted-force */
  v: Float64Array;
}

function makeTable(
  rc: number,
  V: (r: number) => number,
  DV: (r: number) => number,
  shift = true
): PairTable {
  const rc2 = rc * rc;
  const h = (rc2 - R2_MIN) / TABLE_N;
  const g = new Float64Array(TABLE_N + 2);
  const v = new Float64Array(TABLE_N + 2);
  const vrc = shift ? V(rc) : 0;
  const frc = shift ? DV(rc) : 0;
  for (let k = 0; k <= TABLE_N + 1; k++) {
    const r = Math.sqrt(R2_MIN + k * h);
    g[k] = -(DV(r) - frc) / r;
    v[k] = V(r) - vrc - (r - rc) * frc;
  }
  return { rc2, invH: 1 / h, g, v };
}

/** Repulsion between non-bonded glass atoms: Lennard-Jones cut at its minimum (WCA) */
let glassRepulsion: PairTable[] | null = null;
function glassRepulsionTables(): PairTable[] {
  if (glassRepulsion) return glassRepulsion;
  glassRepulsion = [
    [0, 0],
    [0, 1],
    [1, 1],
  ].map(([a, b]) => {
    const sig = SIGMA[a!]![b!]!;
    const eps = EPS[a!]![b!]! * glassParams.epsScale;
    return makeTable(
      Math.pow(2, 1 / 6) * sig,
      (r) => kaV(sig, eps, r),
      (r) => kaDV(sig, eps, r)
    );
  });
  return glassRepulsion;
}

/** Tables indexed by type_i + type_j (0 = AA, 1 = AB, 2 = BB) */
const tableCache: Partial<Record<Material, PairTable[]>> = {};
function tablesFor(material: Material): PairTable[] {
  const cached = tableCache[material];
  if (cached) return cached;
  let tables: PairTable[];
  if (material === 'ionic') {
    // type 0 = cation, 1 = anion; table index = type_i + type_j
    tables = [0, 1, 2].map((pair) =>
      makeTable(
        ionicParams.rc,
        (r) => ionicV(r, pair),
        (r) => ionicDV(r, pair)
      )
    );
  } else {
    tables = [
      [0, 0],
      [0, 1],
      [1, 1],
    ].map(([a, b]) => {
      const sig = SIGMA[a!]![b!]!;
      const eps = EPS[a!]![b!]! * glassParams.epsScale;
      const r0 = Math.pow(2, 1 / 6) * sig;
      // bond: full Lennard-Jones spring up to a little past the breaking length
      return makeTable(
        glassParams.breakStretch * r0 + 0.1,
        (r) => kaV(sig, eps, r),
        (r) => kaDV(sig, eps, r),
        false
      );
    });
  }
  tableCache[material] = tables;
  return tables;
}

/**
 * Honeycomb sites relative to an A site at the origin, for nearest-neighbour distance d:
 * lattice vectors a1 = (sqrt3 d, 0), a2 = (sqrt3 d / 2, 3d / 2); B sits at A + (0, d).
 * Returns the offsets of all other ions within `rc` of an ion of the given species
 * (0 = cation on the A sublattice, 1 = anion on the B sublattice), with their species.
 */
function honeycombNeighbours(d: number, species: number, rc: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const L = Math.sqrt(3) * d;
  const m = Math.ceil(rc / (1.5 * d)) + 2;
  // offset of the other sublattice relative to this site
  const shift = species === 0 ? d : -d;
  for (let i = -m; i <= m; i++) {
    for (let j = -m; j <= m; j++) {
      const cx = i * L + (j * L) / 2;
      const cy = 1.5 * d * j;
      if (i !== 0 || j !== 0) {
        if (Math.hypot(cx, cy) < rc) out.push([cx, cy, species]); // same sublattice
      }
      if (Math.hypot(cx, cy + shift) < rc) out.push([cx, cy + shift, 1 - species]);
    }
  }
  return out;
}

/**
 * Nearest-neighbour distance of the honeycomb layer at zero pressure: the minimum of the
 * lattice-sum energy per ion with the same shifted-force potential.
 */
export function ionicSpacing(): number {
  const rc = ionicParams.rc;
  const energy = (d: number): number => {
    let e = 0;
    for (const sp of [0, 1]) {
      for (const [x, y, other] of honeycombNeighbours(d, sp, rc)) {
        const r = Math.hypot(x, y);
        const pair = sp + other;
        e += 0.5 * (ionicV(r, pair) - ionicV(rc, pair) - (r - rc) * ionicDV(rc, pair));
      }
    }
    return e / 2;
  };
  let lo = 0.5;
  let hi = 2.0;
  const phi = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 70; it++) {
    const x1 = hi - phi * (hi - lo);
    const x2 = lo + phi * (hi - lo);
    if (energy(x1) < energy(x2)) hi = x2;
    else lo = x1;
  }
  return 0.5 * (lo + hi);
}

/** A periodic glass sample from the quench, cut into a bar by `Bar`. */
export interface GlassSample {
  x: Float64Array;
  y: Float64Array;
  type: Uint8Array;
  lx: number;
  ly: number;
}

/** Quenches a Kob-Andersen melt in small time slices so the page stays responsive. */
export class GlassPreparer {
  private sim = new KobAndersen2D();
  private steps = 0;
  private readonly total: number;
  readonly lx: number;
  readonly ly: number;
  private readonly T_HOT = 1.5;
  private readonly T_COLD = 0.05;
  private static readonly HOLD = 5;
  private static readonly COOL = 25;
  private static readonly SETTLE = 4;

  constructor(
    readonly n: number,
    aspect: number,
    fractionB = 0.35,
    density = glassParams.density
  ) {
    this.sim.reset(n, density, fractionB, this.T_HOT, aspect);
    this.lx = this.sim.Lx;
    this.ly = this.sim.Ly;
    this.total = Math.round((GlassPreparer.HOLD + GlassPreparer.COOL + GlassPreparer.SETTLE) / DT);
  }

  get progress(): number {
    return Math.min(1, this.steps / this.total);
  }
  get done(): boolean {
    return this.steps >= this.total;
  }

  /** Run for about `ms` milliseconds; returns true when finished. */
  advance(ms: number): boolean {
    const t0 = performance.now();
    const { HOLD, COOL } = GlassPreparer;
    const { T_HOT, T_COLD } = this;
    while (!this.done && performance.now() - t0 < ms) {
      for (let k = 0; k < 20 && !this.done; k++) {
        const t = this.steps * DT;
        const f = Math.min(1, Math.max(0, (t - HOLD) / COOL));
        this.sim.step(DT, T_HOT + (T_COLD - T_HOT) * f);
        this.steps++;
      }
    }
    return this.done;
  }

  sample(): GlassSample {
    const s = this.sim;
    return { x: s.x.slice(), y: s.y.slice(), type: s.type.slice(), lx: s.Lx, ly: s.Ly };
  }
}

export interface BarOptions {
  material: Material;
  /** Ionic: angle between the pulling axis and the [10] lattice direction (deg) */
  angle: number;
  notch: boolean;
  /** Ionic: ions along the bar (nx) and across (ny) */
  nx: number;
  ny: number;
  temperature: number;
  seed: number;
  glass?: GlassSample;
}

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

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function clampStep(delta: number, max: number): number {
  return Math.abs(delta) <= max ? delta : Math.sign(delta) * max;
}

export class Bar {
  readonly material: Material;
  /** Typical nearest-neighbour distance (for scaling drawings) */
  readonly a: number;
  /** Bonds are pairs closer than `bondFactor[type_i + type_j]` times their `bondRef` */
  private bondRef: number[];
  private readonly bondCut: number;
  private readonly tables: PairTable[];
  n = 0;
  pos!: Float64Array; // stride 3 (z = 0), as forEachPair expects
  vel!: Float64Array;
  frc!: Float64Array;
  ref!: Float64Array;
  role!: Uint8Array;
  type!: Uint8Array;
  lx = 0;
  ly = 0;
  area = 1;
  gauge = 1;
  ux = 0;
  force = 0;
  forceSmooth = 0;
  uxSmooth = 0;
  temperature: number;
  /** Langevin friction */
  private gamma = GAMMA;

  private gripMass = 1;
  private gripDamp = 1;
  private gripVx = 0;
  private leftX = 0;
  private frac!: Float64Array;
  private rng: () => number;
  private gaussSpare: number | null = null;
  private pairI: number[] = [];
  private pairJ: number[] = [];
  private listPos!: Float64Array;
  private rightBase: number[] = [];
  private rightIdx: number[] = [];
  /** Reference neighbour lists (CSR) for the non-affine measure */
  private nbrStart!: Int32Array;
  private nbrList!: Int32Array;
  private refCrossMin = 1;
  /** Glass: bonded[i * n + j] (i < j) = 1 while the bond is intact */
  private bonded: Uint8Array | null = null;
  private repulsion: PairTable[] | null = null;
  private breakR2: number[] = [];

  constructor(opts: BarOptions) {
    this.material = opts.material;
    this.temperature = opts.temperature;
    this.rng = makeRng(opts.seed);
    this.tables = tablesFor(opts.material);
    this.gamma = opts.material === 'ionic' ? ionicParams.gamma : glassParams.gamma;
    if (opts.material === 'ionic') {
      this.a = ionicSpacing();
      this.bondRef = [this.a, this.a, this.a];
      this.bondCut = 1.2;
    } else {
      this.a = 1.05;
      this.bondRef = [
        Math.pow(2, 1 / 6) * SIGMA[0]![0]!,
        Math.pow(2, 1 / 6) * SIGMA[0]![1]!,
        Math.pow(2, 1 / 6) * SIGMA[1]![1]!,
      ];
      this.bondCut = glassParams.bondCut;
      this.repulsion = glassRepulsionTables();
      this.breakR2 = this.bondRef.map((r0) => Math.pow(glassParams.breakStretch * r0, 2));
    }
    this.build(opts);
    this.relax();
  }

  // --- construction ---------------------------------------------------------------------
  private build(opts: BarOptions): void {
    const atoms: { x: number; y: number; t: number }[] = [];
    let lx: number;
    let ly: number;
    if (opts.material === 'ionic') {
      const d = this.a;
      const L = Math.sqrt(3) * d;
      lx = opts.nx * L;
      ly = opts.ny * 1.5 * d;
      const th = (opts.angle * Math.PI) / 180;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const m = Math.ceil(Math.hypot(lx, ly) / (1.5 * d)) + 3;
      const eps = 1e-3;
      for (let i = -m; i <= m; i++) {
        for (let j = -m; j <= m; j++) {
          for (const t of [0, 1]) {
            const px = i * L + (j * L) / 2;
            const py = 1.5 * d * j + (t === 1 ? d : 0);
            const x = c * px - s * py + lx / 2;
            const y = s * px + c * py + ly / 2;
            if (x < -eps || x > lx - 0.3 * L || y < -eps || y > ly - 0.2 * d) continue;
            atoms.push({ x, y, t });
          }
        }
      }
    } else {
      const g = opts.glass!;
      lx = g.lx;
      ly = g.ly;
      for (let i = 0; i < g.type.length; i++) atoms.push({ x: g.x[i]!, y: g.y[i]!, t: g.type[i]! });
    }

    let kept = atoms;
    if (opts.notch) {
      const depth = ly * 0.3;
      const cx = lx / 2;
      kept = kept.filter((p) => {
        const dd = p.y - (ly - depth);
        return !(
          dd > -0.5 * this.a && Math.abs(p.x - cx) < Math.max(0, dd + 0.5 * this.a) * 0.3 + 0.05
        );
      });
    }

    // Remove dangling atoms left by the cut (iteratively)
    for (let pass = 0; pass < 3; pass++) {
      const flat = new Float64Array(3 * kept.length);
      kept.forEach((p, i) => {
        flat[3 * i] = p.x;
        flat[3 * i + 1] = p.y;
      });
      const cn = new Uint8Array(kept.length);
      const cut = this.bondCut * Math.max(...this.bondRef);
      forEachPair(flat, kept.length, cut, (i, j, r2) => {
        const p = kept[i]!.t + kept[j]!.t;
        if (r2 < Math.pow(this.bondCut * this.bondRef[p]!, 2)) {
          // ionic: only unlike neighbours hold an ion in place
          if (this.material === 'ionic' && p !== 1) return;
          cn[i]!++;
          cn[j]!++;
        }
      });
      const next = kept.filter((_, i) => cn[i]! >= 2);
      if (next.length === kept.length) break;
      kept = next;
    }

    const n = kept.length;
    this.n = n;
    this.pos = new Float64Array(3 * n);
    this.vel = new Float64Array(3 * n);
    this.frc = new Float64Array(3 * n);
    this.role = new Uint8Array(n);
    this.type = new Uint8Array(n);
    let xmin = Infinity;
    let xmax = -Infinity;
    kept.forEach((p, i) => {
      this.pos[3 * i] = p.x;
      this.pos[3 * i + 1] = p.y;
      this.type[i] = p.t;
      xmin = Math.min(xmin, p.x);
      xmax = Math.max(xmax, p.x);
    });
    for (let i = 0; i < n; i++) {
      const x = this.pos[3 * i]!;
      if (x < xmin + GRIP_WIDTH) this.role[i] = 1;
      else if (x > xmax - GRIP_WIDTH) this.role[i] = 2;
    }
    this.lx = xmax - xmin;
    this.ly = ly;
    this.area = ly;
    this.rightIdx = [];
    for (let i = 0; i < n; i++) if (this.role[i] === 2) this.rightIdx.push(i);
    this.listPos = new Float64Array(3 * n);
    this.frac = new Float64Array(n);
    if (this.material === 'glass') this.assignBonds();
    this.buildList();
    for (let i = 0; i < n; i++) {
      if (this.role[i] !== 0) continue;
      for (let d = 0; d < 2; d++) this.vel[3 * i + d] = this.gauss() * Math.sqrt(this.temperature);
    }
  }

  /** Glass: every close pair of the quenched structure becomes a bond (fixed topology) */
  private assignBonds(): void {
    const n = this.n;
    this.bonded = new Uint8Array(n * n);
    const cut = this.bondCut * Math.max(...this.bondRef);
    forEachPair(this.pos, n, cut, (i, j, r2) => {
      if (this.role[i] !== 0 && this.role[i] === this.role[j]) return;
      const r0 = this.bondRef[this.type[i]! + this.type[j]!]!;
      if (r2 < Math.pow(this.bondCut * r0, 2)) this.bonded![i * n + j] = 1;
    });
  }

  /** Whether atoms i < j at squared distance r2 are bonded (ionic: close; glass: intact bond) */
  private isBonded(i: number, j: number, r2: number): boolean {
    if (this.bonded) return this.bonded[i * this.n + j] === 1;
    const cut = this.bondCut * this.bondRef[this.type[i]! + this.type[j]!]!;
    return r2 < cut * cut;
  }

  private relax(): void {
    const t = this.temperature;
    this.temperature = 0;
    // steepest-descent-like surface relaxation: damped dynamics with fixed grips
    for (let s = 0; s < 900; s++) {
      this.integrate(false);
      if (s % 3 === 0) this.vel.fill(0);
    }
    this.temperature = t;

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
    this.leftX = lx / nl;
    this.gauge = rx / nr - this.leftX;
    this.rightBase = this.rightIdx.map((i) => this.pos[3 * i]!);
    this.gripMass = nr;
    this.gripDamp = 2 * 0.8 * Math.sqrt(((NOMINAL_E * this.area) / this.gauge) * this.gripMass);
    this.ux = 0;
    this.gripVx = 0;

    // thermal settling with a free grip: this defines the stress-free reference
    const settle = 2400;
    const avgFrom = 1200;
    let sum = 0;
    for (let s = 0; s < settle; s++) {
      this.stepForceControlled(0);
      if (s >= avgFrom) sum += this.ux;
    }
    const shift = sum / (settle - avgFrom);
    for (let k = 0; k < this.rightBase.length; k++) this.rightBase[k] = this.rightBase[k]! + shift;
    this.gauge += shift;
    this.ux = 0;
    this.gripVx = 0;
    this.ref = Float64Array.from(this.pos);
    for (let i = 0; i < this.n; i++) {
      this.frac[i] = clamp01((this.ref[3 * i]! - this.leftX) / this.gauge);
    }
    this.forceSmooth = 0;
    this.uxSmooth = 0;
    this.force = 0;
    this.buildReferenceNeighbours();
    this.refCrossMin = Math.max(1, this.minCrossing());
  }

  private buildReferenceNeighbours(): void {
    const n = this.n;
    const cut = this.material === 'ionic' ? 1.5 * this.a : 1.55;
    const lists: number[][] = Array.from({ length: n }, () => []);
    forEachPair(this.ref, n, cut, (i, j) => {
      lists[i]!.push(j);
      lists[j]!.push(i);
    });
    this.nbrStart = new Int32Array(n + 1);
    let total = 0;
    for (let i = 0; i < n; i++) {
      this.nbrStart[i] = total;
      total += lists[i]!.length;
    }
    this.nbrStart[n] = total;
    this.nbrList = new Int32Array(total);
    for (let i = 0; i < n; i++) this.nbrList.set(lists[i]!, this.nbrStart[i] ?? 0);
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

  // --- neighbour list ---------------------------------------------------------------------
  private buildList(): void {
    const { n, pos } = this;
    this.pairI = [];
    this.pairJ = [];
    const cutoff =
      (this.material === 'ionic'
        ? ionicParams.rc
        : glassParams.breakStretch * Math.max(...this.bondRef) + 0.1) + SKIN;
    forEachPair(pos, n, cutoff, (i, j) => {
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
      if (dx * dx + dy * dy > lim) return true;
    }
    return false;
  }

  get pairCount(): number {
    return this.pairI.length;
  }

  // --- dynamics ---------------------------------------------------------------------------
  private computeForces(): void {
    const { pos, frc, pairI, pairJ, type, bonded, n } = this;
    frc.fill(0);
    for (let p = 0; p < pairI.length; p++) {
      const i = pairI[p]!;
      const j = pairJ[p]!;
      const dx = pos[3 * i]! - pos[3 * j]!;
      const dy = pos[3 * i + 1]! - pos[3 * j + 1]!;
      let r2 = dx * dx + dy * dy;
      const tp = type[i]! + type[j]!;
      let tab = this.tables[tp]!;
      if (bonded) {
        const key = i * n + j;
        if (bonded[key] === 1) {
          if (r2 > this.breakR2[tp]!) {
            bonded[key] = 0; // the bond snaps and never re-forms
            tab = this.repulsion![tp]!;
          }
        } else {
          tab = this.repulsion![tp]!;
        }
      }
      if (r2 >= tab.rc2) continue;
      if (r2 < R2_MIN) r2 = R2_MIN;
      const t = (r2 - R2_MIN) * tab.invH;
      const k = Math.floor(t);
      const w = t - k;
      const g = tab.g[k]! + (tab.g[k + 1]! - tab.g[k]!) * w;
      const fx = g * dx;
      const fy = g * dy;
      frc[3 * i] = frc[3 * i]! + fx;
      frc[3 * i + 1] = frc[3 * i + 1]! + fy;
      frc[3 * j] = frc[3 * j]! - fx;
      frc[3 * j + 1] = frc[3 * j + 1]! - fy;
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
      const f = this.frac ? this.frac[i]! : 0;
      for (let d = 0; d < 2; d++) {
        vel[3 * i + d] = vel[3 * i + d]! + half * frc[3 * i + d]!;
        const stream = d === 0 ? f * this.gripVx : 0;
        vel[3 * i + d] =
          stream + c1 * (vel[3 * i + d]! - stream) + (c2 > 0 ? c2 * this.gauss() : 0);
      }
    }
    if (measure) {
      let f = 0;
      for (const i of this.rightIdx) f -= frc[3 * i]!;
      this.force = f;
    }
  }

  private placeGrip(): void {
    this.rightIdx.forEach((i, k) => {
      this.pos[3 * i] = this.rightBase[k]! + this.ux;
    });
  }

  /** Right grip as a free rigid body pulled by `force` along x */
  private stepForceControlled(force: number): void {
    const acc = (force - this.force - this.gripDamp * this.gripVx) / this.gripMass;
    this.gripVx += acc * DT;
    this.ux += this.gripVx * DT;
    this.placeGrip();
    this.integrate(true);
  }

  /**
   * Advance `steps` time steps with the right grip moving towards displacement
   * `targetUx` at no more than `speed` (sigma per unit time). With `free` the
   * grip is released (zero applied force) and the bar relaxes.
   */
  advance(steps: number, targetUx: number, speed: number, free: boolean): void {
    let sum = 0;
    const maxMove = speed * DT;
    for (let s = 0; s < steps; s++) {
      if (free) {
        this.stepForceControlled(0);
      } else {
        const dx = clampStep(targetUx - this.ux, maxMove);
        this.ux += dx;
        this.gripVx = dx / DT;
        this.placeGrip();
        this.integrate(true);
      }
      sum += this.force;
    }
    const mean = sum / Math.max(steps, 1);
    const unloaded = free || (targetUx <= 1e-9 && this.ux <= 1e-9);
    this.forceSmooth += ((unloaded ? 0 : mean) - this.forceSmooth) * SMOOTH;
    this.uxSmooth += (this.ux - this.uxSmooth) * SMOOTH;
  }

  // --- diagnostics ------------------------------------------------------------------------
  /** Bonded pairs with their relative stretch (r / bondRef - 1) */
  bonds(): { i: number; j: number; strain: number }[] {
    const out: { i: number; j: number; strain: number }[] = [];
    const { pos, type } = this;
    for (let p = 0; p < this.pairI.length; p++) {
      const i = this.pairI[p]!;
      const j = this.pairJ[p]!;
      const dx = pos[3 * i]! - pos[3 * j]!;
      const dy = pos[3 * i + 1]! - pos[3 * j + 1]!;
      const r = Math.sqrt(dx * dx + dy * dy);
      const ref = this.bondRef[type[i]! + type[j]!]!;
      if (this.isBonded(i, j, dx * dx + dy * dy)) out.push({ i, j, strain: r / ref - 1 });
    }
    return out;
  }

  /** Bonded neighbours of each atom */
  coordination(): Uint8Array {
    const cn = new Uint8Array(this.n);
    for (const b of this.bonds()) {
      cn[b.i]!++;
      cn[b.j]!++;
    }
    return cn;
  }

  /**
   * Non-affine squared displacement D2min per atom (Falk & Langer): the residual
   * after fitting the best homogeneous deformation to the neighbours' motion
   * since the reference state. Zero for elastic (affine) strain; large where
   * atoms have slipped or rearranged.
   */
  nonAffine(out: Float64Array): void {
    const { pos, ref, nbrStart, nbrList, role } = this;
    for (let i = 0; i < this.n; i++) {
      out[i] = 0;
      if (role[i] !== 0) continue;
      const a = nbrStart[i]!;
      const b = nbrStart[i + 1]!;
      const m = b - a;
      if (m < 2) continue;
      // X = sum r0 r0^T, Y = sum rt r0^T  (2x2)
      let xxx = 0,
        xxy = 0,
        xyy = 0,
        yxx = 0,
        yxy = 0,
        yyx = 0,
        yyy = 0;
      for (let q = a; q < b; q++) {
        const j = nbrList[q]!;
        const r0x = ref[3 * j]! - ref[3 * i]!;
        const r0y = ref[3 * j + 1]! - ref[3 * i + 1]!;
        const rtx = pos[3 * j]! - pos[3 * i]!;
        const rty = pos[3 * j + 1]! - pos[3 * i + 1]!;
        xxx += r0x * r0x;
        xxy += r0x * r0y;
        xyy += r0y * r0y;
        yxx += rtx * r0x;
        yxy += rtx * r0y;
        yyx += rty * r0x;
        yyy += rty * r0y;
      }
      const det = xxx * xyy - xxy * xxy;
      if (Math.abs(det) < 1e-9) continue;
      // F = Y X^-1
      const f00 = (yxx * xyy - yxy * xxy) / det;
      const f01 = (-yxx * xxy + yxy * xxx) / det;
      const f10 = (yyx * xyy - yyy * xxy) / det;
      const f11 = (-yyx * xxy + yyy * xxx) / det;
      let d2 = 0;
      for (let q = a; q < b; q++) {
        const j = nbrList[q]!;
        const r0x = ref[3 * j]! - ref[3 * i]!;
        const r0y = ref[3 * j + 1]! - ref[3 * i + 1]!;
        const rtx = pos[3 * j]! - pos[3 * i]!;
        const rty = pos[3 * j + 1]! - pos[3 * i + 1]!;
        const ex = rtx - (f00 * r0x + f01 * r0y);
        const ey = rty - (f10 * r0x + f11 * r0y);
        d2 += ex * ex + ey * ey;
      }
      out[i] = d2 / m;
    }
  }

  /** Fewest bonds crossing any vertical plane between the grips */
  private minCrossing(): number {
    const { pos } = this;
    const step = 0.5;
    let xl = Infinity;
    let xr = -Infinity;
    for (let i = 0; i < this.n; i++) {
      if (this.role[i] === 1) xl = Math.min(xl, pos[3 * i]!);
      xr = this.role[i] === 2 ? Math.max(xr, pos[3 * i]!) : xr;
    }
    // interior planes only: skip one grip width at each end
    let right = Infinity;
    for (const i of this.rightIdx) right = Math.min(right, pos[3 * i]!);
    const x0 = xl + GRIP_WIDTH + 0.25;
    const x1 = right - 0.25;
    const nb = Math.floor((x1 - x0) / step);
    if (nb < 2) return Infinity;
    const diff = new Int32Array(nb + 2);
    for (let p = 0; p < this.pairI.length; p++) {
      const i = this.pairI[p]!;
      const j = this.pairJ[p]!;
      const dx = pos[3 * i]! - pos[3 * j]!;
      const dy = pos[3 * i + 1]! - pos[3 * j + 1]!;
      if (!this.isBonded(i, j, dx * dx + dy * dy)) continue;
      const a = Math.min(pos[3 * i]!, pos[3 * j]!);
      const b = Math.max(pos[3 * i]!, pos[3 * j]!);
      const k0 = Math.max(0, Math.ceil((a - x0) / step));
      const k1 = Math.min(nb - 1, Math.floor((b - x0) / step));
      if (k1 >= k0) {
        diff[k0] = diff[k0]! + 1;
        diff[k1 + 1] = diff[k1 + 1]! - 1;
      }
    }
    let run = 0;
    let min = Infinity;
    for (let k = 0; k < nb; k++) {
      run += diff[k]!;
      if (run < min) min = run;
    }
    return min;
  }

  /** Load-bearing cross-section left, as a fraction of the intact bar (1 = intact, 0 = severed) */
  intactFraction(): number {
    return Math.min(1, this.minCrossing() / this.refCrossMin);
  }

  /** True if the two grips are still connected through bonds */
  isConnected(): boolean {
    const n = this.n;
    const adj: number[][] = Array.from({ length: n }, () => []);
    const { pos } = this;
    for (let p = 0; p < this.pairI.length; p++) {
      const i = this.pairI[p]!;
      const j = this.pairJ[p]!;
      const dx = pos[3 * i]! - pos[3 * j]!;
      const dy = pos[3 * i + 1]! - pos[3 * j + 1]!;
      if (this.isBonded(i, j, dx * dx + dy * dy)) {
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

  get stress(): number {
    return this.forceSmooth / this.area;
  }
  get strainSmooth(): number {
    return this.uxSmooth / this.gauge;
  }
  get strain(): number {
    return this.ux / this.gauge;
  }
}
