/**
 * Units and Physical Constants
 *
 * Common physical constants and unit conversion utilities.
 */

/** Physical constants in SI units */
export const CONSTANTS = {
  /** Speed of light (m/s) */
  c: 299792458,
  /** Planck's constant (J·s) */
  h: 6.62607015e-34,
  /** Reduced Planck's constant (J·s) */
  hbar: 1.054571817e-34,
  /** Electron mass (kg) */
  m_e: 9.1093837015e-31,
  /** Proton mass (kg) */
  m_p: 1.67262192369e-27,
  /** Elementary charge (C) */
  e: 1.602176634e-19,
  /** Boltzmann constant (J/K) */
  k_B: 1.380649e-23,
  /** Avogadro's number (1/mol) */
  N_A: 6.02214076e23,
  /** Vacuum permittivity (F/m) */
  epsilon_0: 8.8541878128e-12,
  /** Vacuum permeability (H/m) */
  mu_0: 1.25663706212e-6,
  /** Gravitational constant (m³/(kg·s²)) */
  G: 6.67430e-11,
  /** Standard gravity (m/s²) */
  g: 9.80665,
  /** Pi */
  PI: Math.PI,
  /** Two Pi */
  TWO_PI: Math.PI * 2,
} as const;

/** Common unit conversions */
export const UNITS = {
  // Length
  nm_to_m: 1e-9,
  um_to_m: 1e-6,
  mm_to_m: 1e-3,
  cm_to_m: 1e-2,
  km_to_m: 1e3,

  // Time
  ns_to_s: 1e-9,
  us_to_s: 1e-6,
  ms_to_s: 1e-3,

  // Energy
  eV_to_J: 1.602176634e-19,
  meV_to_J: 1.602176634e-22,
  keV_to_J: 1.602176634e-16,

  // Angle
  deg_to_rad: Math.PI / 180,
  rad_to_deg: 180 / Math.PI,

  // Frequency
  THz_to_Hz: 1e12,
  GHz_to_Hz: 1e9,
  MHz_to_Hz: 1e6,
  kHz_to_Hz: 1e3,
} as const;

/**
 * Convert degrees to radians.
 */
export function degToRad(degrees: number): number {
  return degrees * UNITS.deg_to_rad;
}

/**
 * Convert radians to degrees.
 */
export function radToDeg(radians: number): number {
  return radians * UNITS.rad_to_deg;
}

/**
 * Convert electronvolts to Joules.
 */
export function eVToJ(eV: number): number {
  return eV * UNITS.eV_to_J;
}

/**
 * Convert Joules to electronvolts.
 */
export function JToEV(J: number): number {
  return J / UNITS.eV_to_J;
}

/**
 * Format a number with SI prefix.
 */
export function formatSI(value: number, unit: string, precision = 3): string {
  const prefixes = [
    { factor: 1e-15, prefix: 'f' },
    { factor: 1e-12, prefix: 'p' },
    { factor: 1e-9, prefix: 'n' },
    { factor: 1e-6, prefix: 'μ' },
    { factor: 1e-3, prefix: 'm' },
    { factor: 1, prefix: '' },
    { factor: 1e3, prefix: 'k' },
    { factor: 1e6, prefix: 'M' },
    { factor: 1e9, prefix: 'G' },
    { factor: 1e12, prefix: 'T' },
  ];

  const absValue = Math.abs(value);

  for (let i = prefixes.length - 1; i >= 0; i--) {
    const p = prefixes[i]!;
    if (absValue >= p.factor || i === 0) {
      const scaled = value / p.factor;
      return `${scaled.toPrecision(precision)} ${p.prefix}${unit}`;
    }
  }

  return `${value.toPrecision(precision)} ${unit}`;
}
