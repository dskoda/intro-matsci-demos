/**
 * Free electrons drifting in a 2D crystal with scatterers (pure engine, no DOM).
 *
 * Lengths are in units of the lattice spacing a = 1, time and speed in reduced units
 * (thermal speed 1 at T = 1). The solid is a square lattice of NX x NY sites, periodic
 * in both directions. Electrons are independent point particles that feel a uniform
 * force along +x (an electric field pointing in -x acts on negative charges this way)
 * and are scattered by:
 *
 *  - lattice vibrations ("phonons"): with rate T / TAU_PHONON the electron forgets its
 *    velocity and takes a new thermal one. This is the only process that dissipates
 *    the energy the field pumps in, so it also sets the resistivity of the pure crystal;
 *  - point defects: substitutional atoms and vacancies sit on lattice sites and act as
 *    hard disks (elastic collisions), with radius R_SUB or R_VAC;
 *  - grain boundaries: a periodic Voronoi tessellation of the box; an electron that
 *    crosses a boundary is reflected with probability `reflectivity`.
 *
 * Defects and grains are derived from fixed random numbers (`siteU`, the seed list), so
 * moving a slider adds or removes defects without reshuffling the ones already there.
 */

export const NX = 48;
export const NY = 28;
export const W = NX;
export const H = NY;
export const MAX_N = 800;
export const MAX_GRAINS = 60;
/** Electrons 0..MAX_TAGGED-1 can be followed individually. */
export const MAX_TAGGED = 3;
export const R_SUB = 0.5;
export const R_VAC = 0.4;
/** Mean time between phonon collisions at T = 1. */
export const TAU_PHONON = 10;
/** Grain label resolution, cells per lattice spacing. */
export const GRID = 6;
export const GW = NX * GRID;
export const GH = NY * GRID;

const MAX_SPEED = 8;

export type SiteType = 0 | 1 | 2; // host, substitution, vacancy
export type ScatterKind = 0 | 1 | 2; // phonon, point defect, grain boundary

export interface ScatterEvent {
  x: number;
  y: number;
  t: number;
  kind: ScatterKind;
  /** Index of the electron that scattered. */
  id: number;
}

function gauss(): number {
  const u = Math.random() || 1e-12;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

/** Shortest signed separation on a periodic axis of length L. */
function minImage(d: number, L: number): number {
  return d - L * Math.round(d / L);
}

export class ElectronGas {
  n = 0;
  readonly x = new Float64Array(MAX_N);
  readonly y = new Float64Array(MAX_N);
  readonly vx = new Float64Array(MAX_N);
  readonly vy = new Float64Array(MAX_N);

  /** Acceleration along +x produced by the field. */
  accel = 0;
  temperature = 1;
  reflectivity = 0.6;
  time = 0;

  /** Cumulative collision counts: phonon, point defect, grain boundary. */
  readonly counts = [0, 0, 0];
  /** Recent scattering events of the highlighted electrons (indices below MAX_TAGGED). */
  events: ScatterEvent[] = [];

  // microstructure
  readonly siteU = new Float64Array(NX * NY);
  readonly siteType = new Uint8Array(NX * NY);
  impFraction = 0;
  vacFraction = 0;
  readonly seedX = new Float64Array(MAX_GRAINS);
  readonly seedY = new Float64Array(MAX_GRAINS);
  grains = 1;
  readonly grainMap = new Uint16Array(GW * GH);

  constructor() {
    this.reshuffle();
  }

  /** New random defect positions and grain layout. */
  reshuffle(): void {
    for (let i = 0; i < this.siteU.length; i++) this.siteU[i] = Math.random();
    // Best-candidate sampling gives evenly sized grains and stays valid as the count grows.
    for (let g = 0; g < MAX_GRAINS; g++) {
      let bx = Math.random() * W;
      let by = Math.random() * H;
      if (g > 0) {
        let best = -1;
        for (let c = 0; c < 12; c++) {
          const cx = Math.random() * W;
          const cy = Math.random() * H;
          let dMin = Infinity;
          for (let k = 0; k < g; k++) {
            const dx = minImage(cx - this.seedX[k]!, W);
            const dy = minImage(cy - this.seedY[k]!, H);
            dMin = Math.min(dMin, dx * dx + dy * dy);
          }
          if (dMin > best) {
            best = dMin;
            bx = cx;
            by = cy;
          }
        }
      }
      this.seedX[g] = bx;
      this.seedY[g] = by;
    }
    this.rebuildDefects();
    this.rebuildGrains();
  }

  setDefects(imp: number, vac: number): void {
    this.impFraction = imp;
    this.vacFraction = vac;
    this.rebuildDefects();
  }

  setGrains(g: number): void {
    const next = Math.max(1, Math.min(MAX_GRAINS, Math.round(g)));
    if (next === this.grains) return;
    this.grains = next;
    this.rebuildGrains();
  }

  private rebuildDefects(): void {
    for (let i = 0; i < this.siteU.length; i++) {
      const u = this.siteU[i]!;
      this.siteType[i] = u < this.impFraction ? 1 : u > 1 - this.vacFraction ? 2 : 0;
    }
  }

  private rebuildGrains(): void {
    const g = this.grains;
    if (g <= 1) {
      this.grainMap.fill(0);
      return;
    }
    for (let j = 0; j < GH; j++) {
      const py = (j + 0.5) / GRID;
      for (let i = 0; i < GW; i++) {
        const px = (i + 0.5) / GRID;
        let best = 0;
        let dBest = Infinity;
        for (let k = 0; k < g; k++) {
          const dx = minImage(px - this.seedX[k]!, W);
          const dy = minImage(py - this.seedY[k]!, H);
          const d = dx * dx + dy * dy;
          if (d < dBest) {
            dBest = d;
            best = k;
          }
        }
        this.grainMap[j * GW + i] = best;
      }
    }
  }

  grainAt(x: number, y: number): number {
    const i = Math.min(GW - 1, Math.floor(x * GRID));
    const j = Math.min(GH - 1, Math.floor(y * GRID));
    return this.grainMap[j * GW + i]!;
  }

  /** Number of defects of a given type currently on the lattice. */
  countSites(type: SiteType): number {
    let c = 0;
    for (let i = 0; i < this.siteType.length; i++) if (this.siteType[i] === type) c++;
    return c;
  }

  private thermalSigma(): number {
    return 0.7 * Math.sqrt(this.temperature);
  }

  private placeElectron(i: number): void {
    for (let attempt = 0; attempt < 20; attempt++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const site = Math.floor(y) * NX + Math.floor(x);
      const t = this.siteType[site]!;
      const r = t === 1 ? R_SUB : t === 2 ? R_VAC : 0;
      const dx = x - (Math.floor(x) + 0.5);
      const dy = y - (Math.floor(y) + 0.5);
      this.x[i] = x;
      this.y[i] = y;
      if (r === 0 || dx * dx + dy * dy >= r * r) break;
    }
    this.vx[i] = gauss() * this.thermalSigma();
    this.vy[i] = gauss() * this.thermalSigma();
  }

  setN(n: number): void {
    const target = Math.max(1, Math.min(MAX_N, Math.round(n)));
    for (let i = this.n; i < target; i++) this.placeElectron(i);
    this.n = target;
  }

  /** Re-randomise all electrons and clear the statistics. */
  restart(): void {
    for (let i = 0; i < this.n; i++) this.placeElectron(i);
    this.counts[0] = this.counts[1] = this.counts[2] = 0;
    this.events = [];
    this.time = 0;
  }

  meanVx(): number {
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.vx[i]!;
    return this.n ? s / this.n : 0;
  }

  step(dt: number): void {
    const pPhonon = (dt * this.temperature) / TAU_PHONON;
    const sigma = this.thermalSigma();
    const gb = this.grains > 1;

    for (let i = 0; i < this.n; i++) {
      // lattice vibrations: forget the old velocity
      if (Math.random() < pPhonon) {
        this.vx[i] = gauss() * sigma;
        this.vy[i] = gauss() * sigma;
        this.counts[0]!++;
        if (i < MAX_TAGGED) this.logEvent(i, this.x[i]!, this.y[i]!, 0);
      }

      // field
      let vx = this.vx[i]! + this.accel * dt;
      let vy = this.vy[i]!;
      const sp = Math.hypot(vx, vy);
      if (sp > MAX_SPEED) {
        vx *= MAX_SPEED / sp;
        vy *= MAX_SPEED / sp;
      }

      // drift
      const ox = this.x[i]!;
      const oy = this.y[i]!;
      let x = ox + vx * dt;
      let y = oy + vy * dt;
      x -= W * Math.floor(x / W);
      y -= H * Math.floor(y / H);

      // grain boundary: partial reflection on the Voronoi bisector
      if (gb) {
        const g0 = this.grainAt(ox, oy);
        const g1 = this.grainAt(x, y);
        if (g0 !== g1 && Math.random() < this.reflectivity) {
          let nx = minImage(this.seedX[g1]! - this.seedX[g0]!, W);
          let ny = minImage(this.seedY[g1]! - this.seedY[g0]!, H);
          const len = Math.hypot(nx, ny) || 1;
          nx /= len;
          ny /= len;
          const vn = vx * nx + vy * ny;
          vx -= 2 * vn * nx;
          vy -= 2 * vn * ny;
          x = ox;
          y = oy;
          this.counts[2]!++;
          if (i < MAX_TAGGED) this.logEvent(i, x, y, 2);
        }
      }

      // point defects: elastic hard-disk collision with the disk on this site
      const ix = Math.min(NX - 1, Math.floor(x));
      const iy = Math.min(NY - 1, Math.floor(y));
      const type = this.siteType[iy * NX + ix]!;
      if (type !== 0) {
        const r = type === 1 ? R_SUB : R_VAC;
        let dx = x - (ix + 0.5);
        let dy = y - (iy + 0.5);
        const d2 = dx * dx + dy * dy;
        if (d2 < r * r) {
          let d = Math.sqrt(d2);
          if (d < 1e-6) {
            const a = Math.random() * 2 * Math.PI;
            dx = Math.cos(a);
            dy = Math.sin(a);
            d = 1;
          }
          const nx = dx / d;
          const ny = dy / d;
          const vn = vx * nx + vy * ny;
          if (vn < 0) {
            vx -= 2 * vn * nx;
            vy -= 2 * vn * ny;
          }
          x = ix + 0.5 + nx * (r + 1e-3);
          y = iy + 0.5 + ny * (r + 1e-3);
          this.counts[1]!++;
          if (i < MAX_TAGGED) this.logEvent(i, x, y, 1);
        }
      }

      this.x[i] = x;
      this.y[i] = y;
      this.vx[i] = vx;
      this.vy[i] = vy;
    }
    this.time += dt;
  }

  private logEvent(id: number, x: number, y: number, kind: ScatterKind): void {
    this.events.push({ x, y, t: this.time, kind, id });
    if (this.events.length > 120) this.events.shift();
  }
}
