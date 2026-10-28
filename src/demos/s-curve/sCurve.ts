/**
 * Pure model for the S-curve demo (Lecture 10): a parent phase α transforms to β by
 * nucleation and growth, with Avrami (JMAK) kinetics in a 2D section.
 *
 * Reduced units: Tm = 1, latent heat per volume L = 1, τ = T/Tm. Temperatures are shown in
 * kelvin with Tm = TM_K. Rates are in arbitrary units and calibrated by `T_SCALE` so that the
 * transformation at the nose of the C-curve (default parameters) takes about one second.
 */

import { clamp } from '@core/math/validation';
import { mulberry32 } from '../strengthening/strengthening';

export const TM_K = 1000;
export const T_MIN_K = 200;
export const T_MAX_K = 1200;

/** Visible log10(time / s) range of the S-curve plot */
export const LOGT_MIN = -2;
export const LOGT_MAX = 10;

export type Mechanism = 'continuous' | 'saturated';

export interface KineticParams {
  /** Nucleation barrier strength (∝ interfacial energy cubed) */
  a: number;
  /** Diffusion (atomic attachment) barrier */
  q: number;
  mech: Mechanism;
}

export const defaultKinetics: KineticParams = { a: 0.35, q: 5, mech: 'continuous' };

/** Driving force ΔG = G_α − G_β per volume (0 at or above Tm) */
export function drivingForce(T: number): number {
  return Math.max(0, 1 - T / TM_K);
}

/** Nucleation rate per area (reduced, before time calibration) */
function nucRaw(T: number, k: KineticParams): number {
  const dG = drivingForce(T);
  if (dG <= 0) return 0;
  const tau = T / TM_K;
  return Math.exp(-k.a / (dG * dG * tau) - k.q / tau);
}

/** Growth rate of the interface (reduced, before time calibration) */
function growthRaw(T: number, k: KineticParams): number {
  const dG = drivingForce(T);
  if (dG <= 0) return 0;
  const tau = T / TM_K;
  return Math.exp(-k.q / tau) * (1 - Math.exp((-6 * dG) / tau));
}

/** Time calibration per mechanism so that default kinetics give a ~1 s transformation at the nose */
const tScales: Record<Mechanism, number> = { continuous: 1, saturated: 1 };

/**
 * Characteristic rate Γ with X_ext = (π/3)(Γ t)^3 (continuous nucleation, rate I) or
 * π (Γ t)^2 (site saturation, N = exp(−a/(ΔG² τ)) nuclei per area from t = 0).
 */
function gamma(T: number, k: KineticParams): number {
  const U = growthRaw(T, k);
  if (U <= 0) return 0;
  const sc = tScales[k.mech];
  if (k.mech === 'continuous') return sc * Math.cbrt(nucRaw(T, k) * U * U);
  const dG = drivingForce(T);
  return sc * U * Math.sqrt(Math.exp(-k.a / (dG * dG * (T / TM_K))));
}

/** Avrami exponent (2D section) */
export function avramiN(k: KineticParams): number {
  return k.mech === 'continuous' ? 3 : 2;
}

/** Extended volume fraction at time t (s) */
function extended(t: number, T: number, k: KineticParams): number {
  const g = gamma(T, k);
  if (g <= 0) return 0;
  const s = g * t;
  return k.mech === 'continuous' ? (Math.PI / 3) * s * s * s : Math.PI * s * s;
}

/** Transformed fraction at time t (s) */
export function fractionAt(t: number, T: number, k: KineticParams): number {
  return 1 - Math.exp(-extended(t, T, k));
}

/** Dimensionless picture time s = Γ t used by the microstructure map */
export function pictureTime(t: number, T: number, k: KineticParams): number {
  return gamma(T, k) * t;
}

/** Time (s) to reach 50 % transformed; Infinity when nothing transforms */
export function t50(T: number, k: KineticParams): number {
  const g = gamma(T, k);
  if (g <= 0) return Infinity;
  const e = Math.LN2;
  const s = k.mech === 'continuous' ? Math.cbrt((3 * e) / Math.PI) : Math.sqrt(e / Math.PI);
  return s / g;
}

/** Reduced nucleation and growth rates for readouts (calibrated time units) */
export function rates(T: number, k: KineticParams): { I: number; U: number } {
  const sc = tScales[k.mech];
  return { I: nucRaw(T, k) * sc, U: growthRaw(T, k) * sc };
}

/** Temperature of the fastest transformation (nose of the C-curve) for given kinetics */
export function noseTemperature(k: KineticParams): number {
  let best = TM_K * 0.6;
  let bestG = -1;
  for (let T = 100; T < TM_K; T += 2) {
    const g = gamma(T, k);
    if (g > bestG) {
      bestG = g;
      best = T;
    }
  }
  return best;
}

// Calibrate: nose t50 of the default kinetics = 1 s (t50 scales as 1 / scale)
for (const mech of ['continuous', 'saturated'] as const) {
  const k = { ...defaultKinetics, mech };
  tScales[mech] = t50(noseTemperature(k), k);
}

/**
 * Characteristic length ℓ of the microstructure (∝ final grain size): (U/I)^{1/3} for
 * continuous nucleation, the nucleus spacing N^{-1/2} for site saturation. Higher driving
 * force means more nuclei, so a smaller ℓ.
 */
export function grainLength(T: number, k: KineticParams): number {
  const dG = drivingForce(T);
  if (dG <= 0) return Infinity;
  const tau = T / TM_K;
  if (k.mech === 'continuous') return Math.cbrt(growthRaw(T, k) / nucRaw(T, k));
  return Math.exp(k.a / (2 * dG * dG * tau));
}

/**
 * Side of the viewed window in units of ℓ (so the number of grains across is about this).
 * The true spread of ℓ with T is enormous, so it is compressed (square root) and clamped to
 * SIDE_MIN…SIDE_MAX; the nose of the C-curve gets 8.
 */
export function viewSide(T: number, k: KineticParams): number {
  const l = grainLength(T, k);
  if (!Number.isFinite(l)) return SIDE_MAX;
  const ref = grainLength(noseTemperature(k), k);
  return clamp(8 * Math.pow(ref / l, 0.5), SIDE_MIN, SIDE_MAX);
}

// ---------------------------------------------------------------------------
// Microstructure map
// ---------------------------------------------------------------------------

export const GRID = 192;
export const SIDE_MIN = 3;
export const SIDE_MAX = 18;
/** Latest nucleation time (picture units) for continuous nucleation */
const S_MAX = 2.8;

export interface MicroMap {
  /** Picture time at which each pixel transforms */
  time: Float32Array;
  /** Index of the nucleus that transforms each pixel */
  grain: Int32Array;
  /** Nucleation picture time per nucleus */
  nucTime: Float32Array;
  /** Pixel size in picture length units */
  pixel: number;
}

/**
 * Pixel transformation times from random nuclei: a pixel transforms when the first interface,
 * growing at unit speed from a nucleus born at s_i, reaches it (periodic domain).
 */
export function buildMicro(mech: Mechanism, seed: number, side: number): MicroMap {
  const DOMAIN = side;
  const rng = mulberry32(seed);
  const n =
    mech === 'continuous' ? Math.round(DOMAIN * DOMAIN * S_MAX) : Math.round(DOMAIN * DOMAIN);
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  const ns = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    nx[i] = rng() * DOMAIN;
    ny[i] = rng() * DOMAIN;
    ns[i] = mech === 'continuous' ? rng() * S_MAX : 0;
  }
  const time = new Float32Array(GRID * GRID);
  const grain = new Int32Array(GRID * GRID);
  const px = DOMAIN / GRID;
  const half = DOMAIN / 2;
  for (let j = 0; j < GRID; j++) {
    const y = (j + 0.5) * px;
    for (let i = 0; i < GRID; i++) {
      const x = (i + 0.5) * px;
      let best = Infinity;
      let bi = 0;
      for (let k = 0; k < n; k++) {
        let dx = Math.abs(x - nx[k]!);
        if (dx > half) dx = DOMAIN - dx;
        let dy = Math.abs(y - ny[k]!);
        if (dy > half) dy = DOMAIN - dy;
        const s = ns[k]! + Math.sqrt(dx * dx + dy * dy);
        if (s < best) {
          best = s;
          bi = k;
        }
      }
      time[j * GRID + i] = best;
      grain[j * GRID + i] = bi;
    }
  }
  return { time, grain, nucTime: ns, pixel: px };
}

/** Share of pixels transformed by picture time s (for checking against the analytic X) */
export function mapFraction(m: MicroMap, s: number): number {
  let c = 0;
  for (let i = 0; i < m.time.length; i++) if (m.time[i]! <= s) c++;
  return c / m.time.length;
}
