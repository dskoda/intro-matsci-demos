/**
 * Electron-hole pairs in an ordered 2D crystal (pure engine, no DOM).
 *
 * Geometry (lattice spacing 1, periodic in x and y):
 *  - Atoms sit at (i + 0.5, j + 0.5). Each atom holds one valence electron, which is the
 *    filled valence band. A HOLE is an atom whose valence electron is missing.
 *  - Conduction electrons live in the open squares between four atoms, at (i + 1, j + 1)
 *    for plaquette (i, j) (corner atoms (i,j), (i+1,j), (i,j+1), (i+1,j+1)).
 *
 * Processes (a small kinetic Monte Carlo with a fixed time step):
 *  - Generation: with rate G0 exp(-Eg / kT) per atom, a valence electron is thermally
 *    excited out of an atom into a neighbouring plaquette. This leaves a hole behind.
 *  - Hopping: a conduction electron hops between plaquettes; a hole hops between atoms
 *    (a neighbouring valence electron slides into it, so the electron moves the other
 *    way). A field F biases the hops: electrons towards -x and holes towards +x.
 *  - Recombination: an electron next to a hole (one of the plaquette's corner atoms)
 *    falls into it with rate REC_RATE; both disappear.
 *
 * The equilibrium pair number then follows exp(-Eg / 2kT), which is not put in by hand.
 */

export const NX = 22;
export const NY = 14;
export const KB = 8.617e-5; // eV / K
export const MAX_PAIRS = 90;
export const HOP_RATE = 2;
export const REC_RATE = 1.5;
/** Attempt-frequency prefactor of the generation rate (per atom per time unit). */
export const G0 = 600;
export const SLIDE_TIME = 0.3;

export class Carrier {
  /** Lattice index (atom index for holes, plaquette index for electrons). */
  ix: number;
  iy: number;
  /** Drawn position (eased towards the site, unwrapped periodically). */
  px: number;
  py: number;
  constructor(ix: number, iy: number, px: number, py: number) {
    this.ix = ix;
    this.iy = iy;
    this.px = px;
    this.py = py;
  }
}

export interface Slide {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t: number;
}

/** A recombination: the electron falls into the hole, then a flash expands. */
export interface Fall {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t: number;
}

export interface BandEvent {
  kind: 'gen' | 'rec';
  t: number;
  /** Random 0..1, used to place the arrow in the band diagram. */
  u: number;
}

function wrap(i: number, n: number): number {
  return ((i % n) + n) % n;
}

function minImage(d: number, L: number): number {
  return d - L * Math.round(d / L);
}

export function generationRate(T: number, Eg: number): number {
  if (T <= 0) return 0;
  return G0 * Math.exp(-Eg / (KB * T));
}

export class PairLattice {
  electrons: Carrier[] = [];
  holes: Carrier[] = [];
  readonly eOcc = new Uint8Array(NX * NY);
  readonly hOcc = new Uint8Array(NX * NY);
  /** Sim time until which the static valence dot of an atom is hidden (a slide is arriving). */
  readonly hiddenUntil = new Float64Array(NX * NY);

  temperature = 900;
  gap = 1.12;
  /** Field strength (dimensionless bias per hop), pushing electrons to -x and holes to +x. */
  field = 0;

  time = 0;
  generated = 0;
  recombined = 0;
  /** Cumulative hops in x: electrons to the right minus left, holes likewise. */
  netHopE = 0;
  netHopH = 0;

  slides: Slide[] = [];
  falls: Fall[] = [];
  bandEvents: BandEvent[] = [];

  get pairs(): number {
    return this.holes.length;
  }

  clear(): void {
    this.electrons = [];
    this.holes = [];
    this.eOcc.fill(0);
    this.hOcc.fill(0);
    this.hiddenUntil.fill(0);
    this.slides = [];
    this.falls = [];
    this.bandEvents = [];
    this.generated = 0;
    this.recombined = 0;
    this.netHopE = 0;
    this.netHopH = 0;
  }

  private static idx(i: number, j: number): number {
    return j * NX + i;
  }

  private generate(): boolean {
    for (let attempt = 0; attempt < 6; attempt++) {
      const ai = Math.floor(Math.random() * NX);
      const aj = Math.floor(Math.random() * NY);
      if (this.hOcc[PairLattice.idx(ai, aj)]) continue;
      // plaquettes sharing this atom as a corner
      const cand: Array<[number, number]> = [
        [wrap(ai - 1, NX), wrap(aj - 1, NY)],
        [ai, wrap(aj - 1, NY)],
        [wrap(ai - 1, NX), aj],
        [ai, aj],
      ];
      for (let k = cand.length - 1; k > 0; k--) {
        const r = Math.floor(Math.random() * (k + 1));
        [cand[k], cand[r]] = [cand[r]!, cand[k]!];
      }
      for (const [pi, pj] of cand) {
        if (this.eOcc[PairLattice.idx(pi, pj)]) continue;
        this.hOcc[PairLattice.idx(ai, aj)] = 1;
        this.eOcc[PairLattice.idx(pi, pj)] = 1;
        this.holes.push(new Carrier(ai, aj, ai + 0.5, aj + 0.5));
        this.electrons.push(new Carrier(pi, pj, ai + 0.5, aj + 0.5));
        this.generated++;
        this.bandEvents.push({ kind: 'gen', t: this.time, u: Math.random() });
        return true;
      }
    }
    return false;
  }

  /** Pick a neighbour direction with the field bias; returns [dx, dy]. */
  private pickDirection(sign: number): [number, number] {
    const f = this.field * sign; // sign = -1 for electrons (towards -x), +1 for holes
    const wp = Math.exp(f);
    const wm = Math.exp(-f);
    const r = Math.random() * (wp + wm + 2);
    if (r < wp) return [1, 0];
    if (r < wp + wm) return [-1, 0];
    return r < wp + wm + 1 ? [0, 1] : [0, -1];
  }

  step(dt: number): void {
    // generation (Poisson count; the rate is per atom without a hole)
    const lambda = generationRate(this.temperature, this.gap) * (NX * NY - this.holes.length) * dt;
    let count = Math.floor(lambda) + (Math.random() < lambda - Math.floor(lambda) ? 1 : 0);
    while (count-- > 0 && this.holes.length < MAX_PAIRS) this.generate();

    const pHop = HOP_RATE * dt;

    for (const e of this.electrons) {
      if (Math.random() >= pHop) continue;
      const [dx, dy] = this.pickDirection(-1);
      const ni = wrap(e.ix + dx, NX);
      const nj = wrap(e.iy + dy, NY);
      if (this.eOcc[PairLattice.idx(ni, nj)]) continue;
      this.eOcc[PairLattice.idx(e.ix, e.iy)] = 0;
      this.eOcc[PairLattice.idx(ni, nj)] = 1;
      e.ix = ni;
      e.iy = nj;
      this.netHopE += dx;
    }

    for (const h of this.holes) {
      if (Math.random() >= pHop) continue;
      const [dx, dy] = this.pickDirection(1);
      const ni = wrap(h.ix + dx, NX);
      const nj = wrap(h.iy + dy, NY);
      const to = PairLattice.idx(ni, nj);
      if (this.hOcc[to]) continue;
      const from = PairLattice.idx(h.ix, h.iy);
      this.hOcc[from] = 0;
      this.hOcc[to] = 1;
      // the neighbour's valence electron slides into the old hole position
      this.slides.push({
        x0: h.ix + dx + 0.5,
        y0: h.iy + dy + 0.5,
        x1: h.ix + 0.5,
        y1: h.iy + 0.5,
        t: this.time,
      });
      this.hiddenUntil[from] = this.time + SLIDE_TIME;
      h.ix = ni;
      h.iy = nj;
      this.netHopH += dx;
    }

    // recombination: an electron next to a hole falls in
    for (let a = this.electrons.length - 1; a >= 0; a--) {
      const e = this.electrons[a]!;
      const corners: Array<[number, number]> = [
        [e.ix, e.iy],
        [wrap(e.ix + 1, NX), e.iy],
        [e.ix, wrap(e.iy + 1, NY)],
        [wrap(e.ix + 1, NX), wrap(e.iy + 1, NY)],
      ];
      for (const [ci, cj] of corners) {
        if (!this.hOcc[PairLattice.idx(ci, cj)]) continue;
        if (Math.random() >= REC_RATE * dt) continue;
        const b = this.holes.findIndex((h) => h.ix === ci && h.iy === cj);
        if (b < 0) continue;
        this.falls.push({ x0: e.px, y0: e.py, x1: ci + 0.5, y1: cj + 0.5, t: this.time });
        this.eOcc[PairLattice.idx(e.ix, e.iy)] = 0;
        this.hOcc[PairLattice.idx(ci, cj)] = 0;
        this.electrons.splice(a, 1);
        this.holes.splice(b, 1);
        this.recombined++;
        this.bandEvents.push({ kind: 'rec', t: this.time, u: Math.random() });
        break;
      }
    }

    this.time += dt;
    this.slides = this.slides.filter((s) => this.time - s.t < SLIDE_TIME);
    this.falls = this.falls.filter((f) => this.time - f.t < 1);
    this.bandEvents = this.bandEvents.filter((e) => this.time - e.t < 1.2);
  }

  /** Ease the drawn positions towards the lattice sites (call once per frame). */
  animate(alpha: number): void {
    const ease = (c: Carrier, tx: number, ty: number): void => {
      c.px += minImage(tx - c.px, NX) * alpha;
      c.py += minImage(ty - c.py, NY) * alpha;
      c.px = wrap(c.px, NX);
      c.py = wrap(c.py, NY);
    };
    for (const e of this.electrons) ease(e, e.ix + 1, e.iy + 1);
    for (const h of this.holes) ease(h, h.ix + 0.5, h.iy + 0.5);
  }

  /** Run the dynamics without drawing, to reach the steady state quickly. */
  equilibrate(duration: number, dt = 0.05): void {
    const steps = Math.round(duration / dt);
    for (let s = 0; s < steps; s++) this.step(dt);
    this.animate(1);
    this.slides = [];
    this.falls = [];
    this.bandEvents = [];
  }
}
