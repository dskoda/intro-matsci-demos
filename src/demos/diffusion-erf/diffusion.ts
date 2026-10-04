/**
 * Diffusion into a semi-infinite rod with constant surface concentration (pure logic).
 *
 * C(x, t) = Cs - (Cs - C0) * erf(x / (2 sqrt(D t))),   D = D0 exp(-Q / kT)
 */

export const K_B_EV = 8.617333e-5; // eV/K

/** Error function (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/** Arrhenius diffusion coefficient (same units as D0). */
export function diffusivity(d0: number, qEv: number, tempK: number): number {
  return d0 * Math.exp(-qEv / (K_B_EV * tempK));
}

/** Concentration at depth x (m) after time t (s). */
export function concentration(
  x: number,
  t: number,
  d: number,
  cSurface: number,
  cInitial: number
): number {
  const denom = 2 * Math.sqrt(d * t);
  if (denom <= 0) return x <= 0 ? cSurface : cInitial;
  return cSurface - (cSurface - cInitial) * erf(x / denom);
}

/** Diffusion length 2 sqrt(D t) (m). */
export function diffusionLength(t: number, d: number): number {
  return 2 * Math.sqrt(d * t);
}

/** Depth (m) at which (C - C0)/(Cs - C0) = f, i.e. erf(x / 2 sqrt(Dt)) = 1 - f. */
export function depthOfFraction(t: number, d: number, f: number): number {
  // Solve erf(z) = 1 - f by bisection; f = (C - C0)/(Cs - C0)
  const target = 1 - f;
  let lo = 0;
  let hi = 6;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (erf(mid) < target) lo = mid;
    else hi = mid;
  }
  return ((lo + hi) / 2) * diffusionLength(t, d);
}

/** Total solute absorbed per unit area, in (concentration units)*m: 2 (Cs - C0) sqrt(D t / pi). */
export function absorbedAmount(t: number, d: number, cSurface: number, cInitial: number): number {
  return 2 * (cSurface - cInitial) * Math.sqrt((d * t) / Math.PI);
}

export function formatTime(s: number): string {
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  if (s < 3600) return `${(s / 60).toFixed(1)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  if (s < 3.156e7) return `${(s / 86400).toFixed(1)} days`;
  return `${(s / 3.156e7).toFixed(1)} years`;
}

export function formatLength(m: number): string {
  const a = Math.abs(m);
  if (a < 1e-6) return `${(m * 1e9).toFixed(1)} nm`;
  if (a < 1e-3) return `${(m * 1e6).toFixed(1)} µm`;
  if (a < 1) return `${(m * 1e3).toFixed(2)} mm`;
  return `${m.toFixed(2)} m`;
}
