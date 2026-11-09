/**
 * Pure 2D Kob-Andersen binary Lennard-Jones engine (no DOM, no three.js).
 *
 * Reduced units: sigma_AA = epsilon_AA = m = kB = 1. Two species A and B with
 *   sigma_AB = 0.8, sigma_BB = 0.88, eps_AB = 1.5, eps_BB = 0.5.
 * The strong, non-additive A-B attraction frustrates crystallisation, so a
 * quenched mixture is trapped in a disordered (glassy) state.
 *
 * Pair potential: shifted-force LJ truncated at 2.5 sigma_ij, so energy and force
 * vanish smoothly at the cutoff. Dynamics: BAOAB Langevin integrator with a
 * Verlet neighbour list in a periodic square box.
 */

export const SIGMA = [
  [1.0, 0.8],
  [0.8, 0.88],
];
export const EPS = [
  [1.0, 1.5],
  [1.5, 0.5],
];
export const CUTOFF_FACTOR = 2.5;
const SKIN = 0.35;
const GAMMA = 1.0; // Langevin friction
const FORCE_CAP = 2000;

/** Box-Muller normal deviate. */
function randNormal(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface PairTable {
  sig: number;
  eps: number;
  rc: number;
  rc2: number;
  vrc: number; // V(rc)
  frc: number; // V'(rc)
  listR2: number; // (rc + skin)^2
}

function ljV(sig: number, eps: number, r: number): number {
  const s6 = Math.pow(sig / r, 6);
  return 4 * eps * (s6 * s6 - s6);
}
function ljDV(sig: number, eps: number, r: number): number {
  const s6 = Math.pow(sig / r, 6);
  return (4 * eps * (-12 * s6 * s6 + 6 * s6)) / r;
}

/** Pair tables for a cutoff (in units of sigma_ij) and an energy scale */
export function buildPairTable(cutoffFactor: number, epsScale: number): PairTable[][] {
  return [0, 1].map((a) =>
    [0, 1].map((b) => {
      const sig = SIGMA[a]![b]!;
      const eps = EPS[a]![b]! * epsScale;
      const rc = cutoffFactor * sig;
      return {
        sig,
        eps,
        rc,
        rc2: rc * rc,
        vrc: ljV(sig, eps, rc),
        frc: ljDV(sig, eps, rc),
        listR2: (rc + SKIN) * (rc + SKIN),
      };
    })
  );
}

export interface StepResult {
  pe: number;
  ke: number;
}

export interface OrderResult {
  /** |psi6| per atom (sixfold bond-orientational order, 6 nearest neighbours). */
  psi6: Float64Array;
  /** Global orientational order |<psi6>| (1 = single perfect crystal). */
  global: number;
  /** Fraction of atoms with psi6 above the crystalline threshold. */
  crystalFraction: number;
}

/** psi6 above this counts an atom as crystal-like. */
export const CRYSTAL_THRESHOLD = 0.85;

export class KobAndersen2D {
  /** Pair interactions; change with `setInteraction` (default: standard KA, cutoff 2.5 sigma) */
  pairTable: PairTable[][] = buildPairTable(CUTOFF_FACTOR, 1);
  n = 0;
  /** Box edges (a square box when aspect = 1). */
  Lx = 1;
  Ly = 1;
  time = 0;
  type = new Uint8Array(0);
  x = new Float64Array(0);
  y = new Float64Array(0);
  /** Unwrapped positions (for displacements). */
  ux = new Float64Array(0);
  uy = new Float64Array(0);
  vx = new Float64Array(0);
  vy = new Float64Array(0);
  fx = new Float64Array(0);
  fy = new Float64Array(0);
  pe = 0;

  private xb = new Float64Array(0);
  private yb = new Float64Array(0);
  private pi = new Int32Array(0);
  private pj = new Int32Array(0);
  private nPairs = 0;

  /** Stiffer and/or shorter-ranged interaction (call before `reset`) */
  setInteraction(cutoffFactor: number, epsScale: number): void {
    this.pairTable = buildPairTable(cutoffFactor, epsScale);
  }

  /** Edge length of the (square) box; same as Lx. */
  get L(): number {
    return this.Lx;
  }

  /** Number of B atoms for a given total and B fraction. */
  static countB(n: number, fractionB: number): number {
    return Math.round(n * fractionB);
  }

  reset(n: number, density: number, fractionB: number, temperature: number, aspect = 1): void {
    this.n = n;
    this.Lx = Math.sqrt((n * aspect) / density);
    this.Ly = this.Lx / aspect;
    this.time = 0;
    this.type = new Uint8Array(n);
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.fx = new Float64Array(n);
    this.fy = new Float64Array(n);
    this.xb = new Float64Array(n);
    this.yb = new Float64Array(n);

    const nB = KobAndersen2D.countB(n, fractionB);
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (let k = 0; k < nB; k++) this.type[order[k]!] = 1;

    // Jittered square lattice; the hot Langevin bath melts it within a few time units.
    const nCols = Math.ceil(Math.sqrt(n * aspect));
    const nRows = Math.ceil(n / nCols);
    const sx = this.Lx / nCols;
    const sy = this.Ly / nRows;
    for (let i = 0; i < n; i++) {
      this.x[i] = (i % nCols) * sx + sx / 2 + (Math.random() - 0.5) * 0.1 * sx;
      this.y[i] = Math.floor(i / nCols) * sy + sy / 2 + (Math.random() - 0.5) * 0.1 * sy;
      this.vx[i] = randNormal() * Math.sqrt(temperature);
      this.vy[i] = randNormal() * Math.sqrt(temperature);
    }
    this.ux = this.x.slice();
    this.uy = this.y.slice();

    this.buildList();
    this.computeForces();
  }

  /** Rebuild the Verlet neighbour list (O(N^2); fine for N <= ~1000). */
  private buildList(): void {
    const { n, Lx, Ly, x, y, type } = this;
    let cap = Math.max(this.pi.length, n * 24);
    let pi = this.pi.length >= cap ? this.pi : new Int32Array(cap);
    let pj = this.pj.length >= cap ? this.pj : new Int32Array(cap);
    let m = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = x[i]! - x[j]!;
        let dy = y[i]! - y[j]!;
        dx -= Lx * Math.round(dx / Lx);
        dy -= Ly * Math.round(dy / Ly);
        if (dx * dx + dy * dy < this.pairTable[type[i]!]![type[j]!]!.listR2) {
          if (m >= cap) {
            cap *= 2;
            const ni = new Int32Array(cap);
            const nj = new Int32Array(cap);
            ni.set(pi);
            nj.set(pj);
            pi = ni;
            pj = nj;
          }
          pi[m] = i;
          pj[m] = j;
          m++;
        }
      }
    }
    this.pi = pi;
    this.pj = pj;
    this.nPairs = m;
    this.xb.set(x);
    this.yb.set(y);
  }

  private needsRebuild(): boolean {
    const { n, Lx, Ly, x, y, xb, yb } = this;
    const lim = (SKIN / 2) * (SKIN / 2);
    for (let i = 0; i < n; i++) {
      let dx = x[i]! - xb[i]!;
      let dy = y[i]! - yb[i]!;
      dx -= Lx * Math.round(dx / Lx);
      dy -= Ly * Math.round(dy / Ly);
      if (dx * dx + dy * dy > lim) return true;
    }
    return false;
  }

  /** Shifted-force LJ forces; sets this.pe (total potential energy). */
  computeForces(): number {
    const { Lx, Ly, x, y, fx, fy, type, pi, pj, nPairs } = this;
    fx.fill(0);
    fy.fill(0);
    let pe = 0;
    for (let k = 0; k < nPairs; k++) {
      const i = pi[k]!;
      const j = pj[k]!;
      let dx = x[i]! - x[j]!;
      let dy = y[i]! - y[j]!;
      dx -= Lx * Math.round(dx / Lx);
      dy -= Ly * Math.round(dy / Ly);
      const r2 = dx * dx + dy * dy;
      const p = this.pairTable[type[i]!]![type[j]!]!;
      if (r2 >= p.rc2) continue;
      const r = Math.sqrt(Math.max(r2, 0.04));
      const s2 = (p.sig * p.sig) / (r * r);
      const s6 = s2 * s2 * s2;
      const v = 4 * p.eps * (s6 * s6 - s6);
      const dv = (4 * p.eps * (-12 * s6 * s6 + 6 * s6)) / r;
      pe += v - p.vrc - (r - p.rc) * p.frc;
      const fOverR = -(dv - p.frc) / r;
      fx[i]! += fOverR * dx;
      fy[i]! += fOverR * dy;
      fx[j]! -= fOverR * dx;
      fy[j]! -= fOverR * dy;
    }
    for (let i = 0; i < this.n; i++) {
      const m = Math.hypot(fx[i]!, fy[i]!);
      if (m > FORCE_CAP) {
        fx[i]! *= FORCE_CAP / m;
        fy[i]! *= FORCE_CAP / m;
      }
    }
    this.pe = pe;
    return pe;
  }

  /** One BAOAB Langevin step at bath temperature `temperature`. */
  step(dt: number, temperature: number): StepResult {
    const { n, Lx, Ly, x, y, ux, uy, vx, vy, fx, fy } = this;
    const c1 = Math.exp(-GAMMA * dt);
    const c2 = Math.sqrt(Math.max(0, temperature) * (1 - c1 * c1));
    let mvx = 0;
    let mvy = 0;
    for (let i = 0; i < n; i++) {
      vx[i]! += 0.5 * dt * fx[i]!;
      vy[i]! += 0.5 * dt * fy[i]!;
      let dx = 0.5 * dt * vx[i]!;
      let dy = 0.5 * dt * vy[i]!;
      vx[i] = c1 * vx[i]! + c2 * randNormal();
      vy[i] = c1 * vy[i]! + c2 * randNormal();
      mvx += vx[i]!;
      mvy += vy[i]!;
      dx += 0.5 * dt * vx[i]!;
      dy += 0.5 * dt * vy[i]!;
      // (the drift above uses the pre- and post-noise velocity halves)
      x[i]! += dx;
      y[i]! += dy;
      ux[i]! += dx;
      uy[i]! += dy;
      x[i] = ((x[i]! % Lx) + Lx) % Lx;
      y[i] = ((y[i]! % Ly) + Ly) % Ly;
    }
    mvx /= n;
    mvy /= n;

    if (this.needsRebuild()) this.buildList();
    this.computeForces();

    let ke = 0;
    for (let i = 0; i < n; i++) {
      vx[i] = vx[i]! - mvx + 0.5 * dt * fx[i]!;
      vy[i] = vy[i]! - mvy + 0.5 * dt * fy[i]!;
      ke += vx[i]! * vx[i]! + vy[i]! * vy[i]!;
    }
    this.time += dt;
    return { pe: this.pe, ke: 0.5 * ke };
  }

  /**
   * Sixfold bond-orientational order from each atom's 6 nearest neighbours
   * (found in the Verlet list, which always has more than 6 within 2.5 sigma).
   */
  orderParameters(): OrderResult {
    const { n, Lx, Ly, x, y, pi, pj, nPairs } = this;
    const nbr: { r2: number; c: number; s: number }[][] = Array.from({ length: n }, () => []);
    for (let k = 0; k < nPairs; k++) {
      const i = pi[k]!;
      const j = pj[k]!;
      let dx = x[j]! - x[i]!;
      let dy = y[j]! - y[i]!;
      dx -= Lx * Math.round(dx / Lx);
      dy -= Ly * Math.round(dy / Ly);
      const r2 = dx * dx + dy * dy;
      if (r2 > 2.25 * 2.25) continue;
      const th = Math.atan2(dy, dx);
      nbr[i]!.push({ r2, c: Math.cos(6 * th), s: Math.sin(6 * th) });
      // reverse bond: angle + pi, and 6*(th+pi) = 6*th + 6*pi: same phase
      nbr[j]!.push({ r2, c: Math.cos(6 * th), s: Math.sin(6 * th) });
    }
    const psi6 = new Float64Array(n);
    let gRe = 0;
    let gIm = 0;
    let nCryst = 0;
    for (let i = 0; i < n; i++) {
      const list = nbr[i]!;
      list.sort((a, b) => a.r2 - b.r2);
      const m = Math.min(6, list.length);
      let re = 0;
      let im = 0;
      for (let q = 0; q < m; q++) {
        re += list[q]!.c;
        im += list[q]!.s;
      }
      // Always divide by 6 so atoms with a missing neighbour cannot look ordered.
      re /= 6;
      im /= 6;
      psi6[i] = Math.hypot(re, im);
      gRe += re;
      gIm += im;
      if (psi6[i]! > CRYSTAL_THRESHOLD) nCryst++;
    }
    return { psi6, global: Math.hypot(gRe, gIm) / n, crystalFraction: nCryst / n };
  }

  /** Radial distribution function g(r) of all atoms, rMax <= L/2. */
  rdf(nBins: number, rMax: number): Float64Array {
    const { n, Lx, Ly, x, y } = this;
    const hist = new Float64Array(nBins);
    const dr = rMax / nBins;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = x[i]! - x[j]!;
        let dy = y[i]! - y[j]!;
        dx -= Lx * Math.round(dx / Lx);
        dy -= Ly * Math.round(dy / Ly);
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r < rMax) hist[Math.floor(r / dr)]! += 2;
      }
    }
    const rho = n / (Lx * Ly);
    for (let b = 0; b < nBins; b++) {
      const r0 = b * dr;
      const area = Math.PI * ((r0 + dr) * (r0 + dr) - r0 * r0);
      hist[b] = hist[b]! / (n * rho * area);
    }
    return hist;
  }

  /** Displacement of every atom from a reference set of unwrapped positions. */
  displacementFrom(refX: Float64Array, refY: Float64Array, out: Float64Array): void {
    for (let i = 0; i < this.n; i++) {
      out[i] = Math.hypot(this.ux[i]! - refX[i]!, this.uy[i]! - refY[i]!);
    }
  }
}
