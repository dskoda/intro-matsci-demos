/**
 * Kinematic model of an edge dislocation gliding through a 2D square crystal
 * under shear. Pure geometry/physics: no DOM, no three.js.
 *
 * Units: lattice spacing a = 1, Burgers vector b = 1, shear modulus G = 1.
 * Row j = 0 is fixed; the top row j = NY-1 is displaced by gamma * H. The slip
 * plane lies between rows SLIP_ROW-1 and SLIP_ROW.
 */

export const NX = 24;
export const NY = 12;
export const H = NY - 1;
export const SLIP_Y = (NY - 1) / 2; // 5.5, between rows 5 and 6
export const SLIP_ROW = Math.ceil(SLIP_Y); // first row above the slip plane
export const G = 1;
export const B = 1;
export const GAMMA_MAX = 0.4;
/** Theoretical rigid-slip strength, G / 2 pi. */
export const TAU_THEORY = G / (2 * Math.PI);

/** Core half-width margin: xd runs from -MARGIN*w to NX-1+MARGIN*w. */
const MARGIN = 5.5;
const MAX_SPEED = 40;

export interface Params {
  /** Lattice friction (Peierls) stress needed to move the dislocation. */
  tauP: number;
  /** Core width parameter w. */
  width: number;
  /** Dislocation mobility: speed = mobility * (tau - tauP). */
  mobility: number;
}

export interface State {
  /** Applied shear strain (top grip displacement / H). */
  gamma: number;
  /** Position of the dislocation core along the slip plane. */
  xd: number;
  /** Number of dislocations that already crossed the crystal. */
  slips: number;
}

export interface Bond {
  a: number;
  b: number;
  strain: number;
}

export const xStart = (p: Params): number => -MARGIN * p.width;
export const xEnd = (p: Params): number => NX - 1 + MARGIN * p.width;

export function newState(p: Params): State {
  return { gamma: 0, xd: xStart(p), slips: 0 };
}

/** Slip profile: 1 behind the core (slipped), 0 ahead of it. */
function profile(x: number, xd: number, w: number): number {
  return 0.5 * (1 - Math.tanh((x - xd) / w));
}

/** Mean slip over the columns, i.e. the swept fraction of the slip plane. */
export function sweptFraction(xd: number, w: number): number {
  let sum = 0;
  for (let i = 0; i < NX; i++) sum += profile(i, xd, w);
  return sum / NX;
}

export function gammaPlastic(s: State, p: Params): number {
  return (B * (s.slips + sweptFraction(s.xd, p.width))) / H;
}

export function tau(s: State, p: Params): number {
  return G * (s.gamma - gammaPlastic(s, p));
}

/**
 * Advance the state. `dir` is +1 (loading) or -1 (unloading); `rate` is the
 * strain rate. Returns true if the dislocation moved.
 */
export function step(s: State, p: Params, dir: number, rate: number, dt: number): boolean {
  s.gamma = Math.min(GAMMA_MAX, s.gamma + dir * rate * dt);
  // Unloading stops when the stress reaches zero (permanent set remains).
  if (dir < 0) s.gamma = Math.max(s.gamma, gammaPlastic(s, p));
  const t = tau(s, p);
  if (t <= p.tauP) return false;
  s.xd += Math.min(MAX_SPEED, p.mobility * (t - p.tauP)) * dt;
  if (s.xd > xEnd(p)) {
    s.slips++;
    s.xd = xStart(p);
  }
  return true;
}

/** Displaced positions; index = j * NX + i. */
export function displaced(s: State, p: Params): { x: Float64Array; y: Float64Array } {
  const x = new Float64Array(NX * NY);
  const y = new Float64Array(NX * NY);
  const gEl = s.gamma - gammaPlastic(s, p);
  const fbar = sweptFraction(s.xd, p.width);
  for (let j = 0; j < NY; j++) {
    const upper = j >= SLIP_ROW;
    const w = p.width + 0.3 * Math.abs(j - SLIP_Y);
    // The grip row is rigid, so the slip profile blends into its mean value.
    const g = upper ? Math.pow((j - SLIP_Y) / (H - SLIP_Y), 3) : 0;
    for (let i = 0; i < NX; i++) {
      let ux = gEl * j;
      if (upper) ux += B * (s.slips + (1 - g) * profile(i, s.xd, w) + g * fbar);
      x[j * NX + i] = i + ux;
      y[j * NX + i] = j;
    }
  }
  return { x, y };
}

export function bonds(x: Float64Array, y: Float64Array): Bond[] {
  const out: Bond[] = [];
  const len = (a: number, b: number) => Math.hypot(x[a]! - x[b]!, y[a]! - y[b]!);
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const a = j * NX + i;
      if (i + 1 < NX) out.push({ a, b: a + 1, strain: len(a, a + 1) - 1 });
      if (j + 1 < NY) out.push({ a, b: a + NX, strain: len(a, a + NX) - 1 });
    }
  }
  return out;
}

/** Mean strain of the bonds attached to each atom. */
export function atomStrain(bs: Bond[]): Float64Array {
  const sum = new Float64Array(NX * NY);
  const cnt = new Float64Array(NX * NY);
  for (const bd of bs) {
    sum[bd.a] = sum[bd.a]! + bd.strain;
    sum[bd.b] = sum[bd.b]! + bd.strain;
    cnt[bd.a] = cnt[bd.a]! + 1;
    cnt[bd.b] = cnt[bd.b]! + 1;
  }
  for (let k = 0; k < sum.length; k++) sum[k] = sum[k]! / cnt[k]!;
  return sum;
}
