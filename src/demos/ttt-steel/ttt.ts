/**
 * Pure model of the isothermal transformation (TTT) behaviour of a eutectoid steel
 * (0.76 wt% C), after the textbook diagram. Temperatures in °C, times in seconds.
 *
 * Austenite (γ) transforms by diffusion into coarse pearlite (just below A1), fine pearlite
 * (near the nose) or bainite (below ~540 °C). Below Ms the remaining austenite becomes
 * martensite athermally (Koistinen–Marburger), depending only on the lowest temperature
 * reached. Pearlite and bainite slowly coarsen into spheroidite near A1.
 *
 * The diffusional part uses one C-curve: the time to 50 % at each temperature (tabulated),
 * Avrami kinetics with exponent n, and the additivity rule through an "equivalent time" so
 * that arbitrary stepwise or continuous temperature paths can be integrated.
 */

export type Phase = 'A' | 'Pc' | 'Pf' | 'B' | 'M' | 'S';
export const PHASES: Phase[] = ['A', 'Pc', 'Pf', 'B', 'M', 'S'];

export const PHASE_NAME: Record<Phase, string> = {
  A: 'Austenite',
  Pc: 'Coarse pearlite',
  Pf: 'Fine pearlite',
  B: 'Bainite',
  M: 'Martensite',
  S: 'Spheroidite',
};

export const PHASE_COLOR: Record<Phase, string> = {
  A: '#9aa4b5',
  Pc: '#f2a65a',
  Pf: '#e0585f',
  B: '#6fd08c',
  M: '#58a6ff',
  S: '#c792ea',
};

export type Fractions = Record<Phase, number>;

export const A1 = 727;
export const MS = 220;
/** Koistinen–Marburger constant (1/°C) */
export const KM = 0.011;
export const T_AUST = 800;
/** Lowest temperature of the diagram (°C): sub-zero quenching down to liquid nitrogen */
export const T_MIN = -200;
/** Boundaries between the products formed by diffusion (°C) */
export const T_COARSE = 650;
export const T_BAINITE = 540;

/** Time of the start of the quench (s); plotted time axis is absolute time since t = 0 */
export const T0 = 0.1;
export const LT_MIN = -1;
export const LT_MAX = 6;

const N_AVRAMI = 2.5;
const LN2 = Math.LN2;

/** log10 of the time (s) to 50 % transformation, from the textbook C-curve */
const TABLE: [number, number][] = [
  [726, 6.3],
  [715, 5.3],
  [700, 4.35],
  [680, 3.35],
  [650, 2.25],
  [620, 1.45],
  [590, 1.0],
  [560, 0.78],
  [540, 0.73],
  [500, 0.95],
  [450, 1.35],
  [400, 1.65],
  [350, 2.0],
  [300, 2.45],
  [250, 2.95],
  [220, 3.25],
  [150, 3.9],
  [20, 4.9],
  [-200, 7],
];

export function logTau50(T: number): number {
  if (T >= A1) return Infinity;
  if (T >= TABLE[0]![0]) return TABLE[0]![1];
  for (let i = 1; i < TABLE.length; i++) {
    const [T1, v1] = TABLE[i]!;
    const [T0_, v0] = TABLE[i - 1]!;
    if (T >= T1) return v1 + ((v0 - v1) * (T - T1)) / (T0_ - T1);
  }
  return TABLE[TABLE.length - 1]![1];
}

const A_START = Math.pow(Math.log(1 / 0.99) / LN2, 1 / N_AVRAMI);
const A_FINISH = Math.pow(Math.log(100) / LN2, 1 / N_AVRAMI);

/** Plot coordinate log10(T0 + t) of an isothermal time t after the quench */
export function ltOf(t: number): number {
  return Math.log10(T0 + t);
}

/** Isothermal start (1 %) and finish (99 %) of the diffusional transformation, as plot log-times */
export function startLt(T: number): number {
  return ltOf(Math.pow(10, logTau50(T)) * A_START);
}
/** Isothermal 50 % line (the time constant of the C-curve) */
export function halfLt(T: number): number {
  return ltOf(Math.pow(10, logTau50(T)));
}
export function finishLt(T: number): number {
  return ltOf(Math.pow(10, logTau50(T)) * A_FINISH);
}

/** Product of the diffusional transformation at temperature T */
export function product(T: number): 'Pc' | 'Pf' | 'B' {
  return T >= T_COARSE ? 'Pc' : T >= T_BAINITE ? 'Pf' : 'B';
}

/** Time constant (s) for spheroidization of pearlite/bainite at T */
export function tauSpheroid(T: number): number {
  return Math.pow(10, 4.5 + 0.012 * (A1 - T));
}

export function emptyFractions(): Fractions {
  return { A: 1, Pc: 0, Pf: 0, B: 0, M: 0, S: 0 };
}

export class Transformation {
  f: Fractions = emptyFractions();
  /** JMAK fraction of the diffusional transformation (before martensite takes its share) */
  private Y = 0;
  /** lowest temperature at which martensite has been formed down to */
  private Tm = Infinity;

  reset() {
    this.f = emptyFractions();
    this.Y = 0;
    this.Tm = Infinity;
  }

  copy(): Fractions {
    return { ...this.f };
  }

  /** Advance dt seconds while at temperature T (dt = 0 for an instantaneous change of T) */
  step(T: number, dt: number) {
    const f = this.f;
    // martensite: athermal, from the austenite left when the temperature drops below Ms
    if (T < MS && T < this.Tm) {
      const from = Math.min(this.Tm, MS);
      const dm = f.A * (1 - Math.exp(-KM * (from - T)));
      f.A -= dm;
      f.M += dm;
      this.Tm = T;
    }
    if (dt <= 0 || T >= A1) return;
    // diffusional decomposition of the remaining austenite, additivity via equivalent time
    if (this.Y < 1 - 1e-12 && f.A > 1e-12) {
      const tau = Math.pow(10, logTau50(T));
      const teq = tau * Math.pow(-Math.log(1 - this.Y) / LN2, 1 / N_AVRAMI);
      const Yn = Math.min(1 - 1e-12, 1 - Math.exp(-LN2 * Math.pow((teq + dt) / tau, N_AVRAMI)));
      const d = (f.A * (Yn - this.Y)) / (1 - this.Y);
      f.A -= d;
      f[product(T)] += d;
      this.Y = Yn;
    }
    // spheroidization of existing pearlite and bainite
    const pool = f.Pc + f.Pf + f.B;
    if (pool > 1e-12) {
      const g = 1 - Math.exp(-dt / tauSpheroid(T));
      if (g > 1e-9) {
        f.S += pool * g;
        f.Pc *= 1 - g;
        f.Pf *= 1 - g;
        f.B *= 1 - g;
      }
    }
  }
}

/** Phase fractions versus plot log-time for a hold at T after an instantaneous quench from austenite */
export function isothermal(T: number, step = 0.025): { lt: number[]; f: Record<Phase, number[]> } {
  const tr = new Transformation();
  const lt: number[] = [];
  const f: Record<Phase, number[]> = { A: [], Pc: [], Pf: [], B: [], M: [], S: [] };
  tr.step(T, 0);
  let tPrev = 0;
  for (let x = LT_MIN; x <= LT_MAX + 1e-9; x += step) {
    const t = Math.max(0, Math.pow(10, x) - T0);
    tr.step(T, t - tPrev);
    tPrev = t;
    lt.push(x);
    for (const p of PHASES) f[p].push(tr.f[p]);
  }
  return { lt, f };
}
