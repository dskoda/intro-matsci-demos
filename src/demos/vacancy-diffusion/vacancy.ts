/**
 * Vacancy diffusion on a 2D square lattice (pure logic, no DOM).
 *
 * Sites hold species 0 (vacancy), 1 (A) or 2 (B). One Monte Carlo sweep lets every
 * vacancy pick a random nearest neighbour and swap with it (if it is an atom) with
 * probability pHop = exp(-Ea / kT). Periodic in y, closed walls in x.
 */

export const K_B_EV = 8.617333e-5; // eV/K

export type InitMode = 'interface' | 'crystal';

export const VACANCY = 0;
export const SPECIES_A = 1;
export const SPECIES_B = 2;

/** Hop probability per attempt. */
export function hopProbability(eaEv: number, tempK: number): number {
  return Math.exp(-eaEv / (K_B_EV * tempK));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

export class VacancyLattice {
  readonly n: number;
  readonly sites: number;
  /** Species per site. */
  readonly grid: Uint8Array;
  /** Atom id per site (-1 for vacancy). */
  readonly ids: Int32Array;
  /** Site index of each atom id. */
  siteOf: Int32Array;
  /** Original column of each atom id. */
  originX: Int32Array;
  /** Unwrapped displacement of each atom id (lattice units). */
  dispX: Float64Array;
  dispY: Float64Array;
  /** Site index of each vacancy. */
  vacancies: Int32Array;
  /** 1 if the vacancy hopped during the last sweep. */
  hopped: Uint8Array;
  atomCount = 0;
  sweeps = 0;
  hops = 0;
  mode: InitMode = 'interface';
  private rand: () => number = Math.random;

  constructor(n: number) {
    this.n = n;
    this.sites = n * n;
    this.grid = new Uint8Array(this.sites);
    this.ids = new Int32Array(this.sites);
    this.siteOf = new Int32Array(0);
    this.originX = new Int32Array(0);
    this.dispX = new Float64Array(0);
    this.dispY = new Float64Array(0);
    this.vacancies = new Int32Array(0);
    this.hopped = new Uint8Array(0);
  }

  get vacancyCount(): number {
    return this.vacancies.length;
  }

  reset(mode: InitMode, vacancyFraction: number, seed: number): void {
    const n = this.n;
    this.mode = mode;
    this.rand = mulberry32(seed);
    this.sweeps = 0;
    this.hops = 0;

    // Choose vacancy sites by partial Fisher-Yates shuffle
    const nVac = Math.max(1, Math.min(this.sites - 1, Math.round(vacancyFraction * this.sites)));
    const order = new Int32Array(this.sites);
    for (let i = 0; i < this.sites; i++) order[i] = i;
    for (let i = 0; i < nVac; i++) {
      const j = i + Math.floor(this.rand() * (this.sites - i));
      const tmp = order[i]!;
      order[i] = order[j]!;
      order[j] = tmp;
    }
    this.vacancies = order.slice(0, nVac);
    this.hopped = new Uint8Array(nVac);

    const isVac = new Uint8Array(this.sites);
    for (let i = 0; i < nVac; i++) isVac[this.vacancies[i]!] = 1;

    this.atomCount = this.sites - nVac;
    this.siteOf = new Int32Array(this.atomCount);
    this.originX = new Int32Array(this.atomCount);
    this.dispX = new Float64Array(this.atomCount);
    this.dispY = new Float64Array(this.atomCount);

    let id = 0;
    for (let s = 0; s < this.sites; s++) {
      if (isVac[s]) {
        this.grid[s] = VACANCY;
        this.ids[s] = -1;
        continue;
      }
      const x = s % n;
      this.grid[s] = mode === 'interface' && x >= n / 2 ? SPECIES_B : SPECIES_A;
      this.ids[s] = id;
      this.siteOf[id] = s;
      this.originX[id] = x;
      id++;
    }
  }

  /** One Monte Carlo sweep: every vacancy attempts one hop. Returns successful hops. */
  step(pHop: number): number {
    const n = this.n;
    let done = 0;
    this.hopped.fill(0);
    for (let k = 0; k < this.vacancies.length; k++) {
      const v = this.vacancies[k]!;
      const d = Math.floor(this.rand() * 4);
      const x = v % n;
      const y = (v - x) / n;
      const nx = x + DX[d]!;
      if (nx < 0 || nx >= n) continue;
      const ny = (y + DY[d]! + n) % n;
      const t = ny * n + nx;
      if (this.grid[t] === VACANCY) continue;
      if (this.rand() >= pHop) continue;

      // atom at t moves into v
      const a = this.ids[t]!;
      this.grid[v] = this.grid[t]!;
      this.ids[v] = a;
      this.grid[t] = VACANCY;
      this.ids[t] = -1;
      this.siteOf[a] = v;
      this.dispX[a]! -= DX[d]!;
      this.dispY[a]! -= DY[d]!;
      this.vacancies[k] = t;
      this.hopped[k] = 1;
      done++;
    }
    this.sweeps++;
    this.hops += done;
    return done;
  }

  /** Mean squared displacement of all atoms (lattice units squared). */
  msd(): number {
    let sum = 0;
    for (let a = 0; a < this.atomCount; a++) {
      sum += this.dispX[a]! * this.dispX[a]! + this.dispY[a]! * this.dispY[a]!;
    }
    return this.atomCount > 0 ? sum / this.atomCount : 0;
  }

  /** Fraction of A among atoms per column. */
  profile(): Float64Array {
    const n = this.n;
    const a = new Float64Array(n);
    const tot = new Float64Array(n);
    for (let s = 0; s < this.sites; s++) {
      const g = this.grid[s]!;
      if (g === VACANCY) continue;
      const x = s % n;
      tot[x]! += 1;
      if (g === SPECIES_A) a[x]! += 1;
    }
    for (let x = 0; x < n; x++) a[x] = tot[x]! > 0 ? a[x]! / tot[x]! : 0;
    return a;
  }

  /** 10-90 % width of the A profile (lattice spacings), interface mode. */
  mixingWidth(): number {
    const p = this.profile();
    // Smooth over the two columns around the crossing is unnecessary; interpolate crossings.
    const cross = (level: number): number => {
      for (let x = 0; x < p.length - 1; x++) {
        const p0 = p[x]!;
        const p1 = p[x + 1]!;
        if (p0 >= level && p1 < level) return x + (p0 - level) / (p0 - p1);
      }
      return p[0]! < level ? 0 : p.length - 1;
    };
    return Math.max(0, cross(0.1) - cross(0.9));
  }
}
