/**
 * PN junction as a dense 2D gas of electrons and holes (Lecture 14), pure engine, no DOM.
 *
 * World: a box LX x LY (periodic in y). The P side is x in [0, XJ], the N side [XJ, LX].
 * Each side holds a uniform background of fixed ions (acceptors, charge -1 each, on the P
 * side; donors, +1, on the N side), as many as it has majority carriers, so each side is
 * neutral on its own. Free carriers (unit charge) are point particles with Langevin
 * dynamics (thermal speed VTH, friction GAMMA).
 *
 * Fields and charge:
 *  - The internal field is found from the 1D charge density along x (carriers plus fixed
 *    ions, summed over y and lightly smoothed): E(x) = KFIELD * integral of rho. So the
 *    depletion zone and the built-in field are not put in; they appear once the wall
 *    between the sides is removed and electrons diffuse into the P side and holes into
 *    the N side.
 *  - With contacts connected, the circuit fixes the potential drop across the device (the
 *    unbiased drop minus the applied voltage) through a uniform correction field, so the
 *    depletion charge has to adjust to the bias, as in a real diode.
 * Carrier processes:
 *  - Recombination: an electron and a hole closer than R_REC annihilate with rate K_REC.
 *  - Thermal generation of pairs at a uniform rate chosen so that n p = NI^2 in neutral
 *    material, which keeps a few minority carriers around.
 *  - Contacts (step 3 only): carriers that reach x = 0 or x = LX leave; the majority
 *    carrier density in a thin strip at each end is topped up by injection, so current
 *    can flow. Without contacts the box is closed.
 */

export const LX = 2;
export const LY = 0.8;
export const XJ = 1;
export const VTH = 0.5;
export const GAMMA = 5;
export const R_REC = 0.012;
export const K_REC = 60;
/** Intrinsic density (carriers per unit area). */
export const NI = 25;
export const KFIELD = 0.031;
export const NB = 100;
export const DXB = LX / NB;
/** Typical built-in field (for scaling arrows). */
export const E_REF = 7.75;
export const CAP = 4200;
const CONTACT_W = 0.05;

export interface Flash {
  x: number;
  y: number;
  t: number;
  kind: 'gen' | 'rec';
}

class Species {
  x = new Float32Array(CAP);
  y = new Float32Array(CAP);
  vx = new Float32Array(CAP);
  vy = new Float32Array(CAP);
  n = 0;

  add(x: number, y: number, vx: number, vy: number): void {
    if (this.n >= CAP) return;
    this.x[this.n] = x;
    this.y[this.n] = y;
    this.vx[this.n] = vx;
    this.vy[this.n] = vy;
    this.n++;
  }

  removeAt(i: number): void {
    const l = this.n - 1;
    this.x[i] = this.x[l]!;
    this.y[i] = this.y[l]!;
    this.vx[i] = this.vx[l]!;
    this.vy[i] = this.vy[l]!;
    this.n = l;
  }
}

function gauss(): number {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

export class PNJunction {
  readonly electrons = new Species();
  readonly holes = new Species();

  /** Fixed ions: donors on the N side and acceptors on the P side (counts). */
  nDonors = 1000;
  nAcceptors = 1000;
  /** True while the sides are separated (a reflecting wall at XJ). */
  wall = true;
  /** True when the ends are ohmic contacts (carriers leave, majority carriers are injected). */
  contacts = false;
  /** Applied potential in energy units; positive = forward (positive terminal on the P side). */
  voltage = 0;
  /** Potential drop across the unbiased junction (set when the contacts are connected). */
  dropRef = 0;
  /**
   * Multiplies the recombination rate (and the matching thermal pair creation). Under high
   * forward bias electrons and holes sit in different energy ranges and hardly recombine
   * while crossing, so the demo lowers it with the bias.
   */
  recFactor = 1;
  private ec = 0;

  time = 0;
  generatedTotal = 0;
  recombinedTotal = 0;
  /** Net signed carrier crossings of x = XJ (conventional current direction +x). */
  crossings = 0;
  flashes: Flash[] = [];

  // Per-bin data (smoothed).
  readonly rho = new Float32Array(NB);
  readonly nS = new Float32Array(NB);
  readonly pS = new Float32Array(NB);
  readonly eInt = new Float32Array(NB);
  readonly eExt = new Float32Array(NB);
  readonly eTot = new Float32Array(NB);
  private readonly raw = new Float32Array(NB);
  private readonly nC = new Float32Array(NB);
  private readonly pC = new Float32Array(NB);

  // Recombination grid.
  private readonly cx = Math.ceil(LX / R_REC);
  private readonly cy = Math.ceil(LY / R_REC);
  private readonly head: Int32Array;
  private readonly nextE = new Int32Array(CAP);
  private readonly deadE = new Uint8Array(CAP);
  private readonly deadH = new Uint8Array(CAP);

  constructor() {
    this.head = new Int32Array(this.cx * this.cy);
    this.reset(1000, 1000);
  }

  /** Thermal energy. */
  get kT(): number {
    return VTH * VTH;
  }

  /** Built-in potential, in energy units (measured once the contacts are connected). */
  get phiBi(): number {
    if (this.dropRef > 0) return this.dropRef;
    const dn = this.nDonors / (LY * (LX - XJ));
    const dp = this.nAcceptors / (LY * XJ);
    return this.kT * Math.log((dn * dp) / (NI * NI));
  }

  /** Back to two separate, neutral sides. */
  reset(nDonors: number, nAcceptors: number): void {
    this.nDonors = nDonors;
    this.nAcceptors = nAcceptors;
    this.electrons.n = 0;
    this.holes.n = 0;
    this.wall = true;
    this.contacts = false;
    this.voltage = 0;
    this.dropRef = 0;
    this.recFactor = 1;
    this.ec = 0;
    this.time = 0;
    this.generatedTotal = 0;
    this.recombinedTotal = 0;
    this.crossings = 0;
    this.flashes = [];
    this.rho.fill(0);
    this.eInt.fill(0);
    this.eExt.fill(0);
    this.eTot.fill(0);
    for (let i = 0; i < nDonors; i++) {
      this.electrons.add(
        XJ + Math.random() * (LX - XJ),
        Math.random() * LY,
        VTH * gauss(),
        VTH * gauss()
      );
    }
    for (let i = 0; i < nAcceptors; i++) {
      this.holes.add(Math.random() * XJ, Math.random() * LY, VTH * gauss(), VTH * gauss());
    }
    this.countBins(true);
  }

  /** Background charge of the fixed ions in bin b (counts). */
  private ionCharge(b: number): number {
    return b >= NB / 2 ? this.nDonors / (NB / 2) : -this.nAcceptors / (NB / 2);
  }

  private countBins(snap: boolean): void {
    this.nC.fill(0);
    this.pC.fill(0);
    const e = this.electrons;
    const h = this.holes;
    for (let i = 0; i < e.n; i++) this.nC[Math.min(NB - 1, Math.floor(e.x[i]! / DXB))]!++;
    for (let i = 0; i < h.n; i++) this.pC[Math.min(NB - 1, Math.floor(h.x[i]! / DXB))]!++;
    const a = snap ? 1 : 0.25;
    for (let b = 0; b < NB; b++) {
      this.raw[b] = this.pC[b]! - this.nC[b]! + this.ionCharge(b);
    }
    for (let b = 0; b < NB; b++) {
      let s = 0;
      let sn = 0;
      let sp = 0;
      let c = 0;
      for (let k = -2; k <= 2; k++) {
        const j = b + k;
        if (j < 0 || j >= NB) continue;
        s += this.raw[j]!;
        sn += this.nC[j]!;
        sp += this.pC[j]!;
        c++;
      }
      this.rho[b]! += (s / c - this.rho[b]!) * a;
      this.nS[b]! += (sn / c - this.nS[b]!) * a;
      this.pS[b]! += (sp / c - this.pS[b]!) * a;
    }
  }

  private computeField(): void {
    this.countBins(false);
    let acc = 0;
    for (let b = 0; b < NB; b++) {
      this.eInt[b] = KFIELD * (acc + 0.5 * this.rho[b]!);
      acc += this.rho[b]!;
    }
    const end = KFIELD * acc;
    for (let b = 0; b < NB; b++) this.eInt[b]! -= end * ((b + 0.5) / NB);

    // The circuit fixes the potential drop between the contacts: the equilibrium drop
    // minus the applied voltage. A uniform correction field, with feedback, enforces it;
    // it vanishes once the depletion charge has adjusted (apart from the ohmic drop).
    if (this.contacts) {
      let integral = 0;
      for (let b = 0; b < NB; b++) integral += this.eInt[b]! * DXB;
      const target = -this.dropRef + this.voltage;
      this.ec += ((target - integral) / LX - this.ec) * 0.3;
    } else this.ec = 0;
    this.eExt.fill(this.ec);
    for (let b = 0; b < NB; b++) this.eTot[b] = this.eInt[b]! + this.eExt[b]!;
  }

  /** Connect the contacts, remembering the potential drop of the unbiased junction. */
  connectContacts(): void {
    this.computeField();
    let drop = 0;
    for (let b = 0; b < NB; b++) drop -= this.eInt[b]! * DXB;
    this.dropRef = Math.max(drop, 0.2);
    this.ec = 0;
    this.contacts = true;
  }

  disconnectContacts(): void {
    this.contacts = false;
    this.voltage = 0;
    this.recFactor = 1;
    this.ec = 0;
  }

  /** Width of the depletion zone: bins near the junction whose net charge is not screened. */
  get depletionWidth(): number {
    let n = 0;
    for (let b = NB / 4; b < (3 * NB) / 4; b++) {
      if (Math.abs(this.rho[b]!) > 0.3 * Math.abs(this.ionCharge(b))) n++;
    }
    return n * DXB;
  }

  private move(sp: Species, sign: number, dt: number, isElectron: boolean): void {
    const a = Math.exp(-GAMMA * dt);
    const s = VTH * Math.sqrt(1 - a * a);
    const field = this.wall ? null : this.eTot;
    for (let i = sp.n - 1; i >= 0; i--) {
      const x0 = sp.x[i]!;
      let vx = sp.vx[i]! * a + s * gauss();
      const vy = sp.vy[i]! * a + s * gauss();
      if (field) vx += sign * field[Math.min(NB - 1, Math.max(0, Math.floor(x0 / DXB)))]! * dt;
      let x = x0 + vx * dt;
      let y = sp.y[i]! + vy * dt;
      if (y < 0) y += LY;
      else if (y >= LY) y -= LY;

      let removed = false;
      if (this.wall) {
        const side = x0 < XJ ? 0 : 1;
        const lo = side === 0 ? 0 : XJ;
        const hi = side === 0 ? XJ : LX;
        if (x < lo) {
          x = 2 * lo - x;
          vx = -vx;
        } else if (x > hi) {
          x = 2 * hi - x;
          vx = -vx;
        }
      } else {
        if (this.contacts) {
          if (x < 0 || x >= LX) removed = true;
        } else if (x < 0) {
          x = -x;
          vx = -vx;
        } else if (x >= LX) {
          x = 2 * LX - x;
          vx = -vx;
        }
        if (!removed) {
          // Conventional current: holes moving +x count +1, electrons moving +x count -1.
          if (x0 < XJ && x >= XJ) this.crossings += isElectron ? -1 : 1;
          else if (x0 >= XJ && x < XJ) this.crossings += isElectron ? 1 : -1;
        }
      }
      if (removed) {
        sp.removeAt(i);
        continue;
      }
      sp.x[i] = Math.min(LX - 1e-6, Math.max(0, x));
      sp.y[i] = y;
      sp.vx[i] = vx;
      sp.vy[i] = vy;
    }
  }

  private inject(dt: number): void {
    const target = this.nAcceptors * CONTACT_W;
    let count = 0;
    const h = this.holes;
    for (let i = 0; i < h.n; i++) if (h.x[i]! < CONTACT_W) count++;
    let k = (target - count) * Math.min(1, 100 * dt);
    k = k > 0 ? Math.floor(k) + (Math.random() < k - Math.floor(k) ? 1 : 0) : 0;
    while (k-- > 0) {
      h.add(Math.random() * CONTACT_W, Math.random() * LY, VTH * gauss(), VTH * gauss());
    }
    const targetE = this.nDonors * CONTACT_W;
    let countE = 0;
    const e = this.electrons;
    for (let i = 0; i < e.n; i++) if (e.x[i]! > LX - CONTACT_W) countE++;
    let ke = (targetE - countE) * Math.min(1, 100 * dt);
    ke = ke > 0 ? Math.floor(ke) + (Math.random() < ke - Math.floor(ke) ? 1 : 0) : 0;
    while (ke-- > 0) {
      e.add(LX - Math.random() * CONTACT_W, Math.random() * LY, VTH * gauss(), VTH * gauss());
    }
  }

  private recombine(dt: number): void {
    const e = this.electrons;
    const h = this.holes;
    this.head.fill(-1);
    const cell = (x: number, y: number): number =>
      Math.min(this.cy - 1, Math.floor(y / R_REC)) * this.cx +
      Math.min(this.cx - 1, Math.floor(x / R_REC));
    for (let i = 0; i < e.n; i++) {
      const c = cell(e.x[i]!, e.y[i]!);
      this.nextE[i] = this.head[c]!;
      this.head[c] = i;
      this.deadE[i] = 0;
    }
    for (let j = 0; j < h.n; j++) this.deadH[j] = 0;
    const p = Math.min(1, K_REC * this.recFactor * dt);
    const r2 = R_REC * R_REC;
    let any = false;
    for (let j = 0; j < h.n; j++) {
      const hx = h.x[j]!;
      const hy = h.y[j]!;
      const ci = Math.min(this.cx - 1, Math.floor(hx / R_REC));
      const cj = Math.min(this.cy - 1, Math.floor(hy / R_REC));
      let done = false;
      for (let dj = -1; dj <= 1 && !done; dj++) {
        const jj = (cj + dj + this.cy) % this.cy;
        for (let di = -1; di <= 1 && !done; di++) {
          const ii = ci + di;
          if (ii < 0 || ii >= this.cx) continue;
          for (let i = this.head[jj * this.cx + ii]!; i >= 0; i = this.nextE[i]!) {
            if (this.deadE[i]) continue;
            const dx = e.x[i]! - hx;
            let dy = e.y[i]! - hy;
            if (dy > LY / 2) dy -= LY;
            else if (dy < -LY / 2) dy += LY;
            if (dx * dx + dy * dy > r2) continue;
            if (this.wall && e.x[i]! < XJ !== hx < XJ) continue;
            if (Math.random() >= p) continue;
            this.deadE[i] = 1;
            this.deadH[j] = 1;
            this.recombinedTotal++;
            this.flashes.push({ x: hx, y: hy, t: this.time, kind: 'rec' });
            any = true;
            done = true;
            break;
          }
        }
      }
    }
    if (!any) return;
    for (let i = e.n - 1; i >= 0; i--) if (this.deadE[i]) e.removeAt(i);
    // Holes: removeAt swaps the last into place, so go from the top and carry the flags.
    for (let j = h.n - 1; j >= 0; j--) {
      if (!this.deadH[j]) continue;
      const l = h.n - 1;
      this.deadH[j] = this.deadH[l]!;
      h.removeAt(j);
    }
  }

  private generate(dt: number): void {
    const rate = K_REC * this.recFactor * Math.PI * R_REC * R_REC * NI * NI * LX * LY;
    const lam = rate * dt;
    let k = Math.floor(lam) + (Math.random() < lam - Math.floor(lam) ? 1 : 0);
    while (k-- > 0) {
      const x = Math.random() * LX;
      const y = Math.random() * LY;
      this.electrons.add(x, y, VTH * gauss(), VTH * gauss());
      this.holes.add(x, y, VTH * gauss(), VTH * gauss());
      this.generatedTotal++;
      this.flashes.push({ x, y, t: this.time, kind: 'gen' });
    }
  }

  step(dt: number): void {
    if (this.wall) {
      this.eInt.fill(0);
      this.eExt.fill(0);
      this.eTot.fill(0);
      this.countBins(false);
    } else this.computeField();
    this.move(this.electrons, -1, dt, true);
    this.move(this.holes, 1, dt, false);
    if (this.contacts) this.inject(dt);
    this.recombine(dt);
    this.generate(dt);
    this.time += dt;
    if (this.flashes.length > 400) this.flashes.splice(0, this.flashes.length - 400);
    while (this.flashes.length > 0 && this.time - this.flashes[0]!.t > 0.6) this.flashes.shift();
  }

  /** Run without drawing. */
  equilibrate(duration: number, dt = 0.01): void {
    const n = Math.round(duration / dt);
    for (let i = 0; i < n; i++) this.step(dt);
    this.flashes = [];
    this.crossings = 0;
  }
}
