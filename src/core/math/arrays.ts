/**
 * Typed Array Utilities
 *
 * Helper functions for working with typed arrays.
 */

/**
 * Create a Float64Array filled with zeros.
 */
export function zeros(length: number): Float64Array {
  return new Float64Array(length);
}

/**
 * Create a Float64Array filled with ones.
 */
export function ones(length: number): Float64Array {
  const arr = new Float64Array(length);
  arr.fill(1);
  return arr;
}

/**
 * Create a Float64Array with evenly spaced values.
 * Similar to numpy.linspace.
 */
export function linspace(start: number, end: number, count: number): Float64Array {
  const arr = new Float64Array(count);
  if (count === 1) {
    arr[0] = start;
    return arr;
  }

  const step = (end - start) / (count - 1);
  for (let i = 0; i < count; i++) {
    arr[i] = start + i * step;
  }
  return arr;
}

/**
 * Create a Float64Array with values from start to end (exclusive) with given step.
 * Similar to numpy.arange.
 */
export function arange(start: number, end: number, step = 1): Float64Array {
  const count = Math.ceil((end - start) / step);
  const arr = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    arr[i] = start + i * step;
  }
  return arr;
}

/**
 * Find the minimum value in an array.
 */
export function min(arr: ArrayLike<number>): number {
  if (arr.length === 0) return NaN;
  let m = arr[0] as number;
  for (let i = 1; i < arr.length; i++) {
    const v = arr[i] as number;
    if (v < m) m = v;
  }
  return m;
}

/**
 * Find the maximum value in an array.
 */
export function max(arr: ArrayLike<number>): number {
  if (arr.length === 0) return NaN;
  let m = arr[0] as number;
  for (let i = 1; i < arr.length; i++) {
    const v = arr[i] as number;
    if (v > m) m = v;
  }
  return m;
}

/**
 * Find min and max in one pass.
 */
export function minMax(arr: ArrayLike<number>): [number, number] {
  if (arr.length === 0) return [NaN, NaN];
  let minVal = arr[0] as number;
  let maxVal = arr[0] as number;
  for (let i = 1; i < arr.length; i++) {
    const v = arr[i] as number;
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }
  return [minVal, maxVal];
}

/**
 * Compute the sum of an array.
 */
export function sum(arr: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    s += arr[i] as number;
  }
  return s;
}

/**
 * Compute the mean of an array.
 */
export function mean(arr: ArrayLike<number>): number {
  return arr.length > 0 ? sum(arr) / arr.length : NaN;
}

/**
 * Copy array values into another array.
 */
export function copy(src: ArrayLike<number>, dst: Float64Array, srcOffset = 0): void {
  for (let i = 0; i < Math.min(src.length - srcOffset, dst.length); i++) {
    dst[i] = src[srcOffset + i]!;
  }
}

/**
 * Fill an array with a value.
 */
export function fill(arr: Float64Array, value: number): void {
  arr.fill(value);
}

/**
 * Scale array values in-place.
 */
export function scale(arr: Float64Array, factor: number): void {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = arr[i]! * factor;
  }
}

/**
 * Add arrays element-wise: result = a + b
 */
export function add(a: ArrayLike<number>, b: ArrayLike<number>, result?: Float64Array): Float64Array {
  const len = Math.min(a.length, b.length);
  const out = result ?? new Float64Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = a[i]! + b[i]!;
  }
  return out;
}

/**
 * Subtract arrays element-wise: result = a - b
 */
export function subtract(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  result?: Float64Array
): Float64Array {
  const len = Math.min(a.length, b.length);
  const out = result ?? new Float64Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = a[i]! - b[i]!;
  }
  return out;
}

/**
 * Multiply arrays element-wise: result = a * b
 */
export function multiply(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  result?: Float64Array
): Float64Array {
  const len = Math.min(a.length, b.length);
  const out = result ?? new Float64Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = a[i]! * b[i]!;
  }
  return out;
}

/**
 * Apply a function to each element.
 */
export function map(
  arr: ArrayLike<number>,
  fn: (value: number, index: number) => number,
  result?: Float64Array
): Float64Array {
  const out = result ?? new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    out[i] = fn(arr[i]!, i);
  }
  return out;
}

/**
 * FFT shift: swap halves of an array.
 */
export function fftshift(arr: Float64Array, result?: Float64Array): Float64Array {
  const N = arr.length;
  const half = Math.floor(N / 2);
  const out = result ?? new Float64Array(N);

  for (let i = 0; i < N; i++) {
    out[i] = arr[(i + half) % N]!;
  }

  return out;
}

/**
 * Inverse FFT shift.
 */
export function ifftshift(arr: Float64Array, result?: Float64Array): Float64Array {
  const N = arr.length;
  const half = Math.ceil(N / 2);
  const out = result ?? new Float64Array(N);

  for (let i = 0; i < N; i++) {
    out[i] = arr[(i + half) % N]!;
  }

  return out;
}
