/**
 * Minimal 2D discrete-dislocation-dynamics model of strengthening mechanisms.
 * Pure model: no DOM, no three.js.
 *
 * Reduced units: shear modulus G = 1, Burgers vector b = 1. Edge dislocations
 * glide (no climb) on one of three slip systems at 0, 60 and 120 degrees, the
 * close-packed directions of a triangular (hexagonal) lattice. They interact
 * through the isotropic elastic stress field of an edge dislocation.
 *
 * Mechanisms:
 *  - cold work: initial dislocation density (elastic interactions harden)
 *  - grain boundaries: hexagonal grains that block glide until the force on the
 *    leading dislocation (applied + pile-up) exceeds a barrier
 *  - solid solution: misfit solutes interact with the dislocation pressure field
 *  - precipitates: hard discs that must be cut or bypassed above a threshold
 */

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const LX = 80;
export const LY = 60;
export const NSYS = 3;
export const SYS_ANGLE = [0, Math.PI / 3, (2 * Math.PI) / 3];
export const SCHMID = SYS_ANGLE.map((t) => Math.cos(2 * t)); // 1, -1/2, -1/2

const COS = SYS_ANGLE.map((t) => Math.cos(t));
const SIN = SYS_ANGLE.map((t) => Math.sin(t));

// Elastic and kinetic constants
const NU = 0.3;
const D = 1 / (2 * Math.PI * (1 - NU));
const RC2 = 1.0; // core cutoff squared
const R_CUT2 = 30 * 30; // interaction cutoff squared
const MOBILITY = 80;
const TAU0 = 0.008; // lattice friction
const MAX_STEP = 0.5;
const ANNIHILATE_X = 2.0;
const ANNIHILATE_Y = 1.5;
const G_EFF = 1;
const PLASTIC_FACTOR = 1 / 20000; // effective area factor (3D density) in the Orowan relation
export const SIM_DT = 0.04;
export const GAMMA_END = 0.2;
const MAX_DISL = 500;

// Source parameters
const L_FR = 6;
const TAU_FR = 0.01;
const COOLDOWN = 5;
const AREA_PER_SOURCE = 240;
const MAX_SOURCES = 400;

// Mechanism constants
export const GRAIN_MAX = 80; // slider value meaning "no grain boundaries"
const F_GB = 0.4;
// A blocked dislocation can still cross a boundary: attempt rate = F_ATTEMPT * exp(-(F_GB - |f|) / F_WIDTH)
const F_ATTEMPT = 2;
const F_WIDTH = 0.05;
// Forest junctions: a glide dislocation is stopped near a dislocation of another system
const R_JUNCTION2 = 3 * 3;
const F_JUNCTION = 0.2;
const SOLUTE_K = 1.0;
export const MISFIT_REF = 0.1; // misfit at which SOLUTE_K was calibrated
const SOLUTE_R2 = 2.0;
const SOLUTE_CUT2 = 8 * 8;
const PREC_K1 = 0.35;
const PREC_K2 = 2.8;

export interface Settings {
  rate: number;
  /** Hexagonal grain size (flat-to-flat); >= GRAIN_MAX means single crystal. */
  grainSize: number;
  /** Number of active slip systems for the dislocation sources: 1 (0 deg only) or 3. */
  systems: number;
  /** Solute number density per b^2. */
  solute: number;
  /** Size misfit of every solute relative to the host atom (negative = undersized). */
  misfit: number;
  /** Precipitate area fraction. */
  precFrac: number;
  precRadius: number;
  /** Initial dislocation density per b^2. */
  density: number;
  seed: number;
}

export interface Dislocation {
  id: number;
  x: number;
  y: number;
  sys: number;
  sign: number;
  moving: boolean;
  blocked: boolean;
  /** Latest net glide force (signed along the Burgers direction). */
  force: number;
}

export interface Source {
  x: number;
  y: number;
  sys: number;
  tau: number;
  cool: number;
}

export interface Solute {
  x: number;
  y: number;
  /** Size misfit relative to the host atom (same for all solutes). */
  misfit: number;
}

export interface Precipitate {
  x: number;
  y: number;
  r: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Glide force on a unit-sign dislocation of system `sysI` at (x, y) from one dislocation. */
function pairForce(
  sysI: number,
  x: number,
  y: number,
  sysJ: number,
  signJ: number,
  xj: number,
  yj: number
): number {
  const dx = x - xj;
  const dy = y - yj;
  if (dx * dx + dy * dy > R_CUT2) return 0;
  const cj = COS[sysJ]!;
  const sj = SIN[sysJ]!;
  const xp = dx * cj + dy * sj;
  const yp = -dx * sj + dy * cj;
  const r2 = xp * xp + yp * yp + RC2;
  const phi = SYS_ANGLE[sysI]! - SYS_ANGLE[sysJ]!;
  const tau = (D * signJ * (2 * Math.sin(2 * phi) * xp * xp * yp + Math.cos(2 * phi) * xp * (xp * xp - yp * yp))) / (r2 * r2);
  return tau;
}

export class Crystal {
  readonly settings: Settings;
  readonly rng: () => number;
  disl: Dislocation[] = [];
  sources: Source[] = [];
  solutes: Solute[] = [];
  precs: Precipitate[] = [];
  gamma = 0;
  gammaP = 0;
  sigma = 0;
  time = 0;
  private nextId = 1;
  private gox = 0;
  private goy = 0;

  constructor(settings: Settings) {
    this.settings = { ...settings };
    this.rng = mulberry32(settings.seed);
    // Random shift of the (periodic) grain pattern within one repeat unit
    this.gox = this.rng() * settings.grainSize;
    this.goy = this.rng() * settings.grainSize;
    this.buildSolutes();
    this.buildPrecipitates();
    this.buildDislocations();
    this.buildSources();
    for (let k = 0; k < 150; k++) this.relax(0.05);
  }

  get hasGrains(): boolean {
    return this.settings.grainSize < GRAIN_MAX;
  }

  private get hexR(): number {
    return this.settings.grainSize / Math.sqrt(3);
  }

  /** Grain id of a point (hexagonal cells). */
  grainId(x: number, y: number): number {
    if (!this.hasGrains) return 0;
    const R = this.hexR;
    const px = x - this.gox;
    const py = y - this.goy;
    const q = ((Math.sqrt(3) / 3) * px - py / 3) / R;
    const r = ((2 / 3) * py) / R;
    const cx = q;
    const cz = r;
    const cy = -cx - cz;
    let rx = Math.round(cx);
    let ry = Math.round(cy);
    let rz = Math.round(cz);
    const ex = Math.abs(rx - cx);
    const ey = Math.abs(ry - cy);
    const ez = Math.abs(rz - cz);
    if (ex > ey && ex > ez) rx = -ry - rz;
    else if (ey > ez) ry = -rx - rz;
    else rz = -rx - ry;
    return (rx + 512) * 1024 + (rz + 512);
  }

  /** Hexagon centres that touch the box (for drawing and source placement). */
  grainCenters(): { x: number; y: number; R: number }[] {
    if (!this.hasGrains) return [];
    const R = this.hexR;
    const out: { x: number; y: number; R: number }[] = [];
    const w = Math.sqrt(3) * R;
    const rMin = Math.floor((-R - this.goy) / (1.5 * R)) - 1;
    const rMax = Math.ceil((LY + R - this.goy) / (1.5 * R)) + 1;
    for (let r = rMin; r <= rMax; r++) {
      const qMin = Math.floor((-w - this.gox) / w - r / 2) - 1;
      const qMax = Math.ceil((LX + w - this.gox) / w - r / 2) + 1;
      for (let q = qMin; q <= qMax; q++) {
        const x = w * (q + r / 2) + this.gox;
        const y = R * 1.5 * r + this.goy;
        if (x > -R && x < LX + R && y > -R && y < LY + R) out.push({ x, y, R });
      }
    }
    return out;
  }

  private buildSolutes() {
    const n = Math.round(this.settings.solute * LX * LY);
    for (let i = 0; i < n; i++) {
      this.solutes.push({
        x: this.rng() * LX,
        y: this.rng() * LY,
        misfit: this.settings.misfit,
      });
    }
  }

  /** Random sequential placement: discs never overlap (and keep a small gap). */
  private buildPrecipitates() {
    const { precFrac, precRadius: r } = this.settings;
    const n = Math.round((precFrac * LX * LY) / (Math.PI * r * r));
    const minD2 = (2 * r + 0.5) ** 2;
    for (let i = 0; i < n; i++) {
      for (let attempt = 0; attempt < 400; attempt++) {
        const x = r + this.rng() * (LX - 2 * r);
        const y = r + this.rng() * (LY - 2 * r);
        if (this.precs.every((p) => (p.x - x) ** 2 + (p.y - y) ** 2 >= minD2)) {
          this.precs.push({ x, y, r });
          break;
        }
      }
    }
  }

  private buildDislocations() {
    const n = Math.round(this.settings.density * LX * LY);
    if (n <= 0) return;
    // Jittered triangular grid, balanced signs
    const a = Math.sqrt((2 * LX * LY) / (Math.sqrt(3) * n));
    const pts: [number, number][] = [];
    const rowH = (a * Math.sqrt(3)) / 2;
    for (let j = 0; j * rowH < LY; j++) {
      for (let i = 0; i * a < LX; i++) {
        const x = (i + (j % 2) * 0.5) * a + (this.rng() - 0.5) * 0.5 * a;
        const y = (j + 0.5) * rowH + (this.rng() - 0.5) * 0.5 * a;
        if (x > 0 && x < LX && y > 0 && y < LY) pts.push([x, y]);
      }
    }
    for (let i = pts.length - 1; i > 0; i--) {
      const k = Math.floor(this.rng() * (i + 1));
      [pts[i], pts[k]] = [pts[k]!, pts[i]!];
    }
    pts
      .filter(([x, y]) => !this.insidePrecipitate(x, y))
      .forEach(([x, y], i) => this.addDislocation(x, y, Math.floor(this.rng() * NSYS), i % 2 === 0 ? 1 : -1));
  }

  /** Sources sit on a jittered regular grid (and at the grain centres), not at random. */
  private buildSources() {
    const single = this.settings.systems === 1;
    const add = (x0: number, y0: number, sys: number) => {
      // Sources never sit inside (or right next to) a precipitate: nudge them out, or drop them
      let x = x0;
      let y = y0;
      for (let k = 0; this.insidePrecipitate(x, y, 1.5); k++) {
        if (k >= 80) return;
        const r = 2 + k * 0.15;
        x = clamp(x0 + (this.rng() - 0.5) * 2 * r, 2, LX - 2);
        y = clamp(y0 + (this.rng() - 0.5) * 2 * r, 2, LY - 2);
      }
      this.sources.push({ x, y, sys: single ? 0 : sys, tau: TAU_FR * (0.8 + 0.4 * this.rng()), cool: 0 });
    };
    const target = Math.min(MAX_SOURCES, Math.round((LX * LY) / AREA_PER_SOURCE));
    if (this.hasGrains) {
      let k = 0;
      for (const c of this.grainCenters()) {
        if (c.x < 2 || c.x > LX - 2 || c.y < 2 || c.y > LY - 2) continue;
        // Two sources per grain, stacked so their slip lines differ
        add(c.x, c.y - 0.3 * c.R, k % NSYS);
        add(c.x, c.y + 0.3 * c.R, (k + 1) % NSYS);
        k++;
      }
    }
    if (this.sources.length >= target) return;
    const cols = Math.max(1, Math.round(Math.sqrt((target * LX) / LY)));
    const rows = Math.ceil(target / cols);
    const cw = (LX - 12) / cols;
    const ch = (LY - 12) / rows;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = 6 + (i + 0.5 + (this.rng() - 0.5) * 0.5) * cw;
        const y = 6 + (j + 0.5 + (this.rng() - 0.5) * 0.5) * ch;
        add(x, y, (i + 2 * j) % NSYS);
      }
    }
    if (this.sources.length > MAX_SOURCES) this.sources.length = MAX_SOURCES;
  }

  addDislocation(x: number, y: number, sys: number, sign: number): void {
    this.disl.push({ id: this.nextId++, x, y, sys, sign, moving: false, blocked: false, force: 0 });
  }

  /** True if (x, y) lies inside a precipitate (grown by `margin`). */
  insidePrecipitate(x: number, y: number, margin = 0): boolean {
    for (const p of this.precs) {
      const r = p.r + margin;
      if ((x - p.x) ** 2 + (y - p.y) ** 2 < r * r) return true;
    }
    return false;
  }

  precipitateThreshold(): number {
    const { precRadius: r, precFrac: f } = this.settings;
    return Math.min(PREC_K1 * Math.sqrt(r * f), (PREC_K2 * Math.sqrt(f)) / r);
  }

  /** Resolved glide force on a +sign dislocation of system `sys` at (x, y) (no applied stress). */
  private interactionForce(x: number, y: number, sys: number, skip: number): number {
    let f = 0;
    for (let j = 0; j < this.disl.length; j++) {
      if (j === skip) continue;
      const d = this.disl[j]!;
      f += pairForce(sys, x, y, d.sys, d.sign, d.x, d.y);
    }
    return f;
  }

  private soluteForce(x: number, y: number, sys: number, sign: number): number {
    let f = 0;
    const c = COS[sys]!;
    const s = SIN[sys]!;
    for (const sol of this.solutes) {
      const dx = sol.x - x;
      const dy = sol.y - y;
      if (dx * dx + dy * dy > SOLUTE_CUT2) continue;
      const xp = dx * c + dy * s;
      const yp = -dx * s + dy * c;
      const r2 = xp * xp + yp * yp + SOLUTE_R2;
      f += (-2 * SOLUTE_K * (sol.misfit / MISFIT_REF) * sign * yp * xp) / (r2 * r2);
    }
    return f;
  }

  /** One relaxation step at zero applied stress (used to equilibrate the initial structure). */
  private relax(dt: number) {
    this.advance(dt, 0, false);
  }

  step(dt: number): void {
    if (this.gamma < GAMMA_END) this.gamma += this.settings.rate * dt;
    this.sigma = G_EFF * (this.gamma - this.gammaP);
    this.advance(dt, this.sigma, true);
    this.sigma = G_EFF * (this.gamma - this.gammaP);
    this.time += dt;
  }

  private advance(dt: number, sigma: number, live: boolean) {
    const n = this.disl.length;
    const fs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const d = this.disl[i]!;
      let f = this.interactionForce(d.x, d.y, d.sys, i) + this.soluteForce(d.x, d.y, d.sys, 1);
      f = d.sign * (f + SCHMID[d.sys]! * sigma);
      fs[i] = f;
    }

    const precThr = this.precipitateThreshold();
    for (let i = 0; i < n; i++) {
      const d = this.disl[i]!;
      const f = fs[i]!;
      d.force = f;
      const net = Math.abs(f) - TAU0;
      d.moving = false;
      d.blocked = false;
      if (net <= 0) continue;
      const dir = Math.sign(f);
      const dist = Math.min(MOBILITY * net * dt, MAX_STEP);
      const c = COS[d.sys]!;
      const s = SIN[d.sys]!;
      let t = 1;
      const x1 = d.x + dir * c * dist;
      const y1 = d.y + dir * s * dist;
      if (
        this.hasGrains &&
        Math.abs(f) < F_GB &&
        this.grainId(d.x, d.y) !== this.grainId(x1, y1) &&
        this.rng() >= F_ATTEMPT * dt * Math.exp((Math.abs(f) - F_GB) / F_WIDTH)
      ) {
        const g0 = this.grainId(d.x, d.y);
        let lo = 0;
        let hi = 1;
        for (let k = 0; k < 4; k++) {
          const m = (lo + hi) / 2;
          if (this.grainId(d.x + (x1 - d.x) * m, d.y + (y1 - d.y) * m) === g0) lo = m;
          else hi = m;
        }
        t = Math.min(t, lo);
        d.blocked = true;
      }
      if (Math.abs(f) < F_JUNCTION) {
        for (let j = 0; j < n; j++) {
          const o = this.disl[j]!;
          if (o.sys === d.sys) continue;
          const dn = (x1 - o.x) ** 2 + (y1 - o.y) ** 2;
          if (dn < R_JUNCTION2 && dn < (d.x - o.x) ** 2 + (d.y - o.y) ** 2) {
            t = 0;
            d.blocked = true;
            break;
          }
        }
      }
      if (this.precs.length > 0 && Math.abs(f) < precThr) {
        for (const p of this.precs) {
          const in1 = (x1 - p.x) ** 2 + (y1 - p.y) ** 2 < p.r * p.r;
          const in0 = (d.x - p.x) ** 2 + (d.y - p.y) ** 2 < p.r * p.r;
          if (in1 && !in0) {
            // Entry point of the segment into the disc
            const ux = x1 - d.x;
            const uy = y1 - d.y;
            const fx = d.x - p.x;
            const fy = d.y - p.y;
            const A = ux * ux + uy * uy;
            const Bq = 2 * (fx * ux + fy * uy);
            const C = fx * fx + fy * fy - p.r * p.r;
            const disc = Bq * Bq - 4 * A * C;
            const te = disc >= 0 && A > 0 ? (-Bq - Math.sqrt(disc)) / (2 * A) : 0;
            t = Math.min(t, Math.max(0, te - 1e-3));
            d.blocked = true;
          }
        }
      }
      const move = dist * t;
      d.x += dir * c * move;
      d.y += dir * s * move;
      d.moving = move > 1e-4;
      if (live) this.gammaP += PLASTIC_FACTOR * d.sign * SCHMID[d.sys]! * dir * move;
    }

    this.removeEscaped();
    this.annihilate();
    if (live) this.emit(dt, sigma);
    else this.cool(dt);
  }

  private removeEscaped() {
    this.disl = this.disl.filter((d) => d.x >= 0 && d.x <= LX && d.y >= 0 && d.y <= LY);
  }

  private annihilate() {
    const dead = new Set<number>();
    const n = this.disl.length;
    for (let i = 0; i < n; i++) {
      const a = this.disl[i]!;
      if (dead.has(i)) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.disl[j]!;
        if (dead.has(j) || b.sys !== a.sys || b.sign === a.sign) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const xp = dx * COS[a.sys]! + dy * SIN[a.sys]!;
        const yp = -dx * SIN[a.sys]! + dy * COS[a.sys]!;
        if (Math.abs(xp) < ANNIHILATE_X && Math.abs(yp) < ANNIHILATE_Y) {
          dead.add(i);
          dead.add(j);
          break;
        }
      }
    }
    if (dead.size > 0) this.disl = this.disl.filter((_, i) => !dead.has(i));
  }

  private cool(dt: number) {
    for (const s of this.sources) s.cool -= dt;
  }

  private emit(dt: number, sigma: number) {
    this.cool(dt);
    for (const s of this.sources) {
      if (s.cool > 0 || this.disl.length >= MAX_DISL) continue;
      const f = this.interactionForce(s.x, s.y, s.sys, -1) + SCHMID[s.sys]! * sigma;
      const dir = Math.sign(f);
      const c = COS[s.sys]!;
      const sn = SIN[s.sys]!;
      // Pair separation shrinks if the source sits close to a grain boundary
      const g0 = this.grainId(s.x, s.y);
      let L = L_FR;
      while (
        L >= 2 &&
        (this.grainId(s.x + c * L, s.y + sn * L) !== g0 || this.grainId(s.x - c * L, s.y - sn * L) !== g0)
      ) {
        L -= 1;
      }
      // Both new dislocations must start outside the precipitates
      while (
        L >= 2 &&
        (this.insidePrecipitate(s.x + c * L, s.y + sn * L) || this.insidePrecipitate(s.x - c * L, s.y - sn * L))
      ) {
        L -= 1;
      }
      if (L < 2) continue;
      if (Math.abs(f) < s.tau + D / (2 * L)) continue;
      this.addDislocation(s.x + dir * c * L, s.y + dir * sn * L, s.sys, 1);
      this.addDislocation(s.x - dir * c * L, s.y - dir * sn * L, s.sys, -1);
      s.cool = COOLDOWN;
    }
  }

  /** Dislocation density per b^2. */
  get density(): number {
    return this.disl.length / (LX * LY);
  }
}

/** Flow stress: mean stress over the last quarter of the test. */
export function flowStress(gamma: ArrayLike<number>, sig: ArrayLike<number>): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < gamma.length; i++) {
    if (gamma[i]! >= 0.75 * GAMMA_END) {
      sum += sig[i]!;
      n++;
    }
  }
  return n > 0 ? sum / n : NaN;
}

/** Run a full test at fixed dt; returns the curve and yield stress. */
export function runCurve(
  settings: Settings,
  dt = SIM_DT,
  sample = 5
): { gamma: number[]; sigma: number[]; gammaP: number[]; flow: number } {
  const c = new Crystal(settings);
  const gamma: number[] = [];
  const sigma: number[] = [];
  const gammaP: number[] = [];
  let k = 0;
  while (c.gamma < GAMMA_END) {
    c.step(dt);
    if (k++ % sample === 0) {
      gamma.push(c.gamma);
      sigma.push(c.sigma);
      gammaP.push(c.gammaP);
    }
  }
  return { gamma, sigma, gammaP, flow: flowStress(gamma, sigma) };
}
