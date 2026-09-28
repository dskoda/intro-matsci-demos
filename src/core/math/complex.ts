/**
 * Complex Number Utilities
 *
 * Efficient complex number operations using typed arrays for performance.
 * Complex arrays store real and imaginary parts in separate arrays.
 */

/**
 * Complex array type: stores real and imaginary parts separately.
 */
export interface ComplexArray {
  real: Float64Array;
  imag: Float64Array;
  length: number;
}

/**
 * Create a new complex array of given size.
 */
export function createComplexArray(length: number): ComplexArray {
  return {
    real: new Float64Array(length),
    imag: new Float64Array(length),
    length,
  };
}

/**
 * Create a complex array from real values (imaginary = 0).
 */
export function fromReal(real: Float64Array | number[]): ComplexArray {
  const realArr = real instanceof Float64Array ? real : new Float64Array(real);
  return {
    real: realArr,
    imag: new Float64Array(realArr.length),
    length: realArr.length,
  };
}

/**
 * Clone a complex array.
 */
export function cloneComplex(arr: ComplexArray): ComplexArray {
  return {
    real: new Float64Array(arr.real),
    imag: new Float64Array(arr.imag),
    length: arr.length,
  };
}

/**
 * Complex addition: result = a + b
 */
export function complexAdd(a: ComplexArray, b: ComplexArray, result?: ComplexArray): ComplexArray {
  const len = Math.min(a.length, b.length);
  const out = result ?? createComplexArray(len);

  for (let i = 0; i < len; i++) {
    out.real[i] = a.real[i]! + b.real[i]!;
    out.imag[i] = a.imag[i]! + b.imag[i]!;
  }

  return out;
}

/**
 * Complex multiplication: result = a * b (element-wise)
 */
export function complexMultiply(
  a: ComplexArray,
  b: ComplexArray,
  result?: ComplexArray
): ComplexArray {
  const len = Math.min(a.length, b.length);
  const out = result ?? createComplexArray(len);

  for (let i = 0; i < len; i++) {
    const ar = a.real[i]!;
    const ai = a.imag[i]!;
    const br = b.real[i]!;
    const bi = b.imag[i]!;
    out.real[i] = ar * br - ai * bi;
    out.imag[i] = ar * bi + ai * br;
  }

  return out;
}

/**
 * Complex scalar multiplication.
 */
export function complexScale(
  arr: ComplexArray,
  scalar: number,
  result?: ComplexArray
): ComplexArray {
  const out = result ?? createComplexArray(arr.length);

  for (let i = 0; i < arr.length; i++) {
    out.real[i] = arr.real[i]! * scalar;
    out.imag[i] = arr.imag[i]! * scalar;
  }

  return out;
}

/**
 * Complex scalar multiplication by complex number.
 */
export function complexScaleComplex(
  arr: ComplexArray,
  re: number,
  im: number,
  result?: ComplexArray
): ComplexArray {
  const out = result ?? createComplexArray(arr.length);

  for (let i = 0; i < arr.length; i++) {
    const ar = arr.real[i]!;
    const ai = arr.imag[i]!;
    out.real[i] = ar * re - ai * im;
    out.imag[i] = ar * im + ai * re;
  }

  return out;
}

/**
 * Compute magnitude (absolute value) of each element.
 */
export function complexMagnitude(arr: ComplexArray, result?: Float64Array): Float64Array {
  const out = result ?? new Float64Array(arr.length);

  for (let i = 0; i < arr.length; i++) {
    const re = arr.real[i]!;
    const im = arr.imag[i]!;
    out[i] = Math.sqrt(re * re + im * im);
  }

  return out;
}

/**
 * Compute squared magnitude of each element (faster than magnitude).
 */
export function complexMagnitudeSquared(arr: ComplexArray, result?: Float64Array): Float64Array {
  const out = result ?? new Float64Array(arr.length);

  for (let i = 0; i < arr.length; i++) {
    const re = arr.real[i]!;
    const im = arr.imag[i]!;
    out[i] = re * re + im * im;
  }

  return out;
}

/**
 * Compute phase (argument) of each element.
 */
export function complexPhase(arr: ComplexArray, result?: Float64Array): Float64Array {
  const out = result ?? new Float64Array(arr.length);

  for (let i = 0; i < arr.length; i++) {
    out[i] = Math.atan2(arr.imag[i]!, arr.real[i]!);
  }

  return out;
}

/**
 * Complex conjugate.
 */
export function complexConjugate(arr: ComplexArray, result?: ComplexArray): ComplexArray {
  const out = result ?? createComplexArray(arr.length);

  for (let i = 0; i < arr.length; i++) {
    out.real[i] = arr.real[i]!;
    out.imag[i] = -arr.imag[i]!;
  }

  return out;
}

/**
 * Complex exponential: e^(i * arr) for real array.
 */
export function complexExp(phases: Float64Array, result?: ComplexArray): ComplexArray {
  const out = result ?? createComplexArray(phases.length);

  for (let i = 0; i < phases.length; i++) {
    out.real[i] = Math.cos(phases[i]!);
    out.imag[i] = Math.sin(phases[i]!);
  }

  return out;
}

/**
 * Create complex from magnitude and phase arrays.
 */
export function fromPolar(mag: Float64Array, phase: Float64Array): ComplexArray {
  const len = Math.min(mag.length, phase.length);
  const result = createComplexArray(len);

  for (let i = 0; i < len; i++) {
    const m = mag[i]!;
    const p = phase[i]!;
    result.real[i] = m * Math.cos(p);
    result.imag[i] = m * Math.sin(p);
  }

  return result;
}

/**
 * Single complex number operations.
 */
export const Complex = {
  add: (ar: number, ai: number, br: number, bi: number) => [ar + br, ai + bi] as const,

  sub: (ar: number, ai: number, br: number, bi: number) => [ar - br, ai - bi] as const,

  mul: (ar: number, ai: number, br: number, bi: number) =>
    [ar * br - ai * bi, ar * bi + ai * br] as const,

  div: (ar: number, ai: number, br: number, bi: number) => {
    const denom = br * br + bi * bi;
    return [(ar * br + ai * bi) / denom, (ai * br - ar * bi) / denom] as const;
  },

  mag: (re: number, im: number) => Math.sqrt(re * re + im * im),

  phase: (re: number, im: number) => Math.atan2(im, re),

  conj: (re: number, im: number) => [re, -im] as const,

  exp: (re: number, im: number) => {
    const e = Math.exp(re);
    return [e * Math.cos(im), e * Math.sin(im)] as const;
  },

  fromPolar: (mag: number, phase: number) => [mag * Math.cos(phase), mag * Math.sin(phase)] as const,
};
