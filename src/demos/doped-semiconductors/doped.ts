/**
 * Doped semiconductor lattice (Lecture 14), pure engine, no DOM.
 *
 * It extends the electron-hole pair lattice of Lecture 13 (`semiconductor-pairs/pairs.ts`):
 * a periodic NX x NY square lattice of atoms, each with one valence electron (the full
 * valence band), conduction electrons in the plaquettes between four atoms, holes on atoms.
 *
 * Dopants replace atoms at fixed sites (best-candidate order, so the slider adds or removes
 * them without reshuffling):
 *  - Donor (N-type, like P in Si): one electron more than the lattice needs. Neutral, it is
 *    bound to the donor in a level `binding` eV below the conduction band. It is ionised
 *    with rate NU exp(-binding / kT) into a neighbouring plaquette and the donor stays as
 *    a fixed +. A conduction electron next to an ionised donor is recaptured at CAP_RATE.
 *  - Acceptor (P-type, like B in Si): one electron too few, so a hole is bound to it in a
 *    level `binding` eV above the valence band. Ionised with the same rate: a neighbouring
 *    valence electron jumps into the acceptor (a fixed -) and leaves a free hole. A free
 *    hole next to an ionised acceptor is filled again at CAP_RATE.
 *  - Intrinsic pairs across the gap are generated as in Lecture 13.
 * So donors freeze out at low T, ionise fully at moderate T, and above that the intrinsic
 * pairs eventually dominate again. Nothing of this is put in by hand: it follows from the rates.
 */

import {
  Carrier,
  NX,
  NY,
  KB,
  HOP_RATE,
  REC_RATE,
  SLIDE_TIME,
  MAX_PAIRS,
  generationRate,
  type Slide,
  type Fall,
} from '../semiconductor-pairs/pairs';

export { NX, NY, KB, SLIDE_TIME, MAX_PAIRS };
export type { Slide, Fall };

export type DopantType = 'n' | 'p';

/** Attempt frequency of dopant ionisation (per dopant per time unit). */
export const NU = 60;
/** Rate at which a free carrier next to an ionised dopant of the right kind is captured. */
export const CAP_RATE = 1.5;
export const MAX_DOPANTS = 10;

export interface BandEvent {
  /** gen/rec: across the gap; ion/cap: between the band and the dopant level. */
  kind: 'gen' | 'rec' | 'ion' | 'cap';
  t: number;
  u: number;
}

function wrap(i: number, n: number): number {
  return ((i % n) + n) % n;
}

function minImage(d: number, L: number): number {
  return d - L * Math.round(d / L);
}

export class DopedLattice {
  electrons: Carrier[] = [];
  holes: Carrier[] = [];
  readonly eOcc = new Uint8Array(NX * NY);
  readonly hOcc = new Uint8Array(NX * NY);
  readonly hiddenUntil = new Float64Array(NX * NY);
  /** 1 on dopant atoms. */
  readonly dop = new Uint8Array(NX * NY);
  /** 1 when the dopant is ionised (donor: + and its electron is free; acceptor: - and full). */
  readonly ion = new Uint8Array(NX * NY);

  temperature = 300;
  gap = 1.12;
  binding = 0.05;
  field = 0;
  dopantType: DopantType = 'n';

  time = 0;
  dopList: number[] = [];
  /** Fixed order of dopant sites (well spread). */
  readonly order: number[];

  slides: Slide[] = [];
  falls: Fall[] = [];
  bandEvents: BandEvent[] = [];

  constructor() {
    this.order = DopedLattice.bestCandidateOrder();
  }

  private static bestCandidateOrder(): number[] {
    const n = NX * NY;
    const chosen: number[] = [];
    const left = new Set<number>();
    for (let i = 0; i < n; i++) left.add(i);
    const dist2 = (a: number, b: number): number => {
      const dx = minImage((a % NX) - (b % NX), NX);
      const dy = minImage(Math.floor(a / NX) - Math.floor(b / NX), NY);
      return dx * dx + dy * dy;
    };
    const pool = Array.from(left);
    while (chosen.length < n) {
      let best = -1;
      let bestD = -1;
      for (let k = 0; k < 14; k++) {
        const c = pool[Math.floor(Math.random() * pool.length)]!;
        let d = Infinity;
        for (const o of chosen) d = Math.min(d, dist2(c, o));
        if (chosen.length === 0) d = 1;
        if (d > bestD) {
          bestD = d;
          best = c;
        }
      }
      chosen.push(best);
      pool.splice(pool.indexOf(best), 1);
    }
    return chosen;
  }

  get nElectrons(): number {
    return this.electrons.length;
  }
  get nHoles(): number {
    return this.holes.length;
  }
  get nIonised(): number {
    let n = 0;
    for (const s of this.dopList) n += this.ion[s]!;
    return n;
  }

  /** Remove all carriers and ions, and place `count` dopants. */
  setDopants(type: DopantType, count: number): void {
    this.dopantType = type;
    this.dop.fill(0);
    this.ion.fill(0);
    this.dopList = this.order.slice(0, Math.max(0, Math.min(count, this.order.length)));
    for (const s of this.dopList) this.dop[s] = 1;
    this.clear();
  }

  clear(): void {
    this.electrons = [];
    this.holes = [];
    this.eOcc.fill(0);
    this.hOcc.fill(0);
    this.hiddenUntil.fill(0);
    this.ion.fill(0);
    this.slides = [];
    this.falls = [];
    this.bandEvents = [];
  }

  private static idx(i: number, j: number): number {
    return j * NX + i;
  }

  /** The four plaquettes that have atom (ai, aj) as a corner, shuffled. */
  private plaquettesOf(ai: number, aj: number): Array<[number, number]> {
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
    return cand;
  }

  private event(kind: BandEvent['kind']): void {
    this.bandEvents.push({ kind, t: this.time, u: Math.random() });
  }

  private generate(): boolean {
    for (let attempt = 0; attempt < 6; attempt++) {
      const ai = Math.floor(Math.random() * NX);
      const aj = Math.floor(Math.random() * NY);
      const a = DopedLattice.idx(ai, aj);
      if (this.hOcc[a] || this.dop[a]) continue;
      for (const [pi, pj] of this.plaquettesOf(ai, aj)) {
        if (this.eOcc[DopedLattice.idx(pi, pj)]) continue;
        this.hOcc[a] = 1;
        this.eOcc[DopedLattice.idx(pi, pj)] = 1;
        this.holes.push(new Carrier(ai, aj, ai + 0.5, aj + 0.5));
        this.electrons.push(new Carrier(pi, pj, ai + 0.5, aj + 0.5));
        this.event('gen');
        return true;
      }
    }
    return false;
  }

  private ionise(site: number): void {
    const ai = site % NX;
    const aj = Math.floor(site / NX);
    if (this.dopantType === 'n') {
      for (const [pi, pj] of this.plaquettesOf(ai, aj)) {
        if (this.eOcc[DopedLattice.idx(pi, pj)]) continue;
        this.eOcc[DopedLattice.idx(pi, pj)] = 1;
        this.electrons.push(new Carrier(pi, pj, ai + 0.5, aj + 0.5));
        this.ion[site] = 1;
        this.event('ion');
        return;
      }
    } else {
      const nb: Array<[number, number]> = [
        [wrap(ai + 1, NX), aj],
        [wrap(ai - 1, NX), aj],
        [ai, wrap(aj + 1, NY)],
        [ai, wrap(aj - 1, NY)],
      ].filter(([i, j]) => {
        const k = DopedLattice.idx(i!, j!);
        return !this.hOcc[k] && !this.dop[k];
      }) as Array<[number, number]>;
      if (nb.length === 0) return;
      const [ni, nj] = nb[Math.floor(Math.random() * nb.length)]!;
      this.hOcc[DopedLattice.idx(ni, nj)] = 1;
      this.holes.push(new Carrier(ni, nj, ni + 0.5, nj + 0.5));
      this.slides.push({ x0: ni + 0.5, y0: nj + 0.5, x1: ai + 0.5, y1: aj + 0.5, t: this.time });
      this.hiddenUntil[site] = this.time + SLIDE_TIME;
      this.ion[site] = 1;
      this.event('ion');
    }
  }

  private pickDirection(sign: number): [number, number] {
    const f = this.field * sign;
    const wp = Math.exp(f);
    const wm = Math.exp(-f);
    const r = Math.random() * (wp + wm + 2);
    if (r < wp) return [1, 0];
    if (r < wp + wm) return [-1, 0];
    return r < wp + wm + 1 ? [0, 1] : [0, -1];
  }

  step(dt: number): void {
    const idx = (i: number, j: number): number => DopedLattice.idx(i, j);

    // intrinsic generation across the gap
    const free = NX * NY - this.holes.length - this.dopList.length;
    const lambda = generationRate(this.temperature, this.gap) * free * dt;
    let count = Math.floor(lambda) + (Math.random() < lambda - Math.floor(lambda) ? 1 : 0);
    while (count-- > 0 && this.holes.length < MAX_PAIRS) this.generate();

    // dopant ionisation
    if (this.temperature > 0) {
      const p = NU * Math.exp(-this.binding / (KB * this.temperature)) * dt;
      for (const s of this.dopList) {
        if (!this.ion[s] && Math.random() < p) this.ionise(s);
      }
    }

    const pHop = HOP_RATE * dt;
    for (const e of this.electrons) {
      if (Math.random() >= pHop) continue;
      const [dx, dy] = this.pickDirection(-1);
      const ni = wrap(e.ix + dx, NX);
      const nj = wrap(e.iy + dy, NY);
      if (this.eOcc[idx(ni, nj)]) continue;
      this.eOcc[idx(e.ix, e.iy)] = 0;
      this.eOcc[idx(ni, nj)] = 1;
      e.ix = ni;
      e.iy = nj;
    }

    for (const h of this.holes) {
      if (Math.random() >= pHop) continue;
      const [dx, dy] = this.pickDirection(1);
      const ni = wrap(h.ix + dx, NX);
      const nj = wrap(h.iy + dy, NY);
      const to = idx(ni, nj);
      if (this.hOcc[to] || this.dop[to]) continue;
      const from = idx(h.ix, h.iy);
      this.hOcc[from] = 0;
      this.hOcc[to] = 1;
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
    }

    // electrons: recombine with a hole, or fall into an ionised donor
    for (let a = this.electrons.length - 1; a >= 0; a--) {
      const e = this.electrons[a]!;
      const corners: Array<[number, number]> = [
        [e.ix, e.iy],
        [wrap(e.ix + 1, NX), e.iy],
        [e.ix, wrap(e.iy + 1, NY)],
        [wrap(e.ix + 1, NX), wrap(e.iy + 1, NY)],
      ];
      for (const [ci, cj] of corners) {
        const k = idx(ci, cj);
        const donor = this.dopantType === 'n' && this.dop[k] && this.ion[k];
        if (!this.hOcc[k] && !donor) continue;
        if (Math.random() >= (donor ? CAP_RATE : REC_RATE) * dt) continue;
        let b = -1;
        if (!donor) {
          b = this.holes.findIndex((h) => h.ix === ci && h.iy === cj);
          if (b < 0) continue;
        }
        this.falls.push({ x0: e.px, y0: e.py, x1: ci + 0.5, y1: cj + 0.5, t: this.time });
        this.eOcc[idx(e.ix, e.iy)] = 0;
        this.electrons.splice(a, 1);
        if (donor) {
          this.ion[k] = 0;
          this.event('cap');
        } else {
          this.hOcc[k] = 0;
          this.holes.splice(b, 1);
          this.event('rec');
        }
        break;
      }
    }

    // holes: an ionised acceptor next to a hole gives its electron back
    if (this.dopantType === 'p') {
      for (let b = this.holes.length - 1; b >= 0; b--) {
        const h = this.holes[b]!;
        const nbs: Array<[number, number]> = [
          [wrap(h.ix + 1, NX), h.iy],
          [wrap(h.ix - 1, NX), h.iy],
          [h.ix, wrap(h.iy + 1, NY)],
          [h.ix, wrap(h.iy - 1, NY)],
        ];
        for (const [ai, aj] of nbs) {
          const k = idx(ai, aj);
          if (!this.dop[k] || !this.ion[k]) continue;
          if (Math.random() >= CAP_RATE * dt) continue;
          this.slides.push({
            x0: ai + 0.5,
            y0: aj + 0.5,
            x1: h.ix + 0.5,
            y1: h.iy + 0.5,
            t: this.time,
          });
          this.hiddenUntil[idx(h.ix, h.iy)] = this.time + SLIDE_TIME;
          this.hOcc[idx(h.ix, h.iy)] = 0;
          this.ion[k] = 0;
          this.holes.splice(b, 1);
          this.event('cap');
          break;
        }
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

  equilibrate(duration: number, dt = 0.05): void {
    const steps = Math.round(duration / dt);
    for (let s = 0; s < steps; s++) this.step(dt);
    this.animate(1);
    this.slides = [];
    this.falls = [];
    this.bandEvents = [];
  }
}
