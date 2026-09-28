/**
 * Hash Params Utilities
 *
 * Read and write URL hash parameters for shareable demo presets.
 */

/**
 * Parameter schema definition for type-safe parsing.
 */
export interface ParamSchema {
  [key: string]: {
    type: 'string' | 'number' | 'boolean';
    default?: string | number | boolean;
    min?: number;
    max?: number;
    enum?: (string | number)[];
  };
}

/**
 * Get current hash parameters as an object.
 */
export function getHashParams(): Record<string, string> {
  const hash = window.location.hash;
  const queryStart = hash.indexOf('?');
  if (queryStart === -1) return {};

  const queryString = hash.slice(queryStart + 1);
  const params: Record<string, string> = {};

  for (const pair of queryString.split('&')) {
    const [key, value] = pair.split('=');
    if (key) {
      params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : '';
    }
  }

  return params;
}

/**
 * Set hash parameters, preserving the path.
 */
export function setHashParams(params: Record<string, string | number | boolean>): void {
  const hash = window.location.hash;
  const queryStart = hash.indexOf('?');
  const path = queryStart === -1 ? hash : hash.slice(0, queryStart);

  const queryParts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== undefined) {
      queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }

  const queryString = queryParts.length > 0 ? '?' + queryParts.join('&') : '';
  const newHash = path + queryString;

  // Use replaceState to avoid polluting history
  window.history.replaceState(null, '', newHash);
}

/**
 * Update specific hash parameters, merging with existing.
 */
export function updateHashParams(updates: Record<string, string | number | boolean | null>): void {
  const current = getHashParams();

  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      delete current[key];
    } else {
      current[key] = String(value);
    }
  }

  setHashParams(current);
}

/**
 * Parse hash parameters according to a schema.
 */
export function parseHashParams<T extends ParamSchema>(
  schema: T
): { [K in keyof T]: T[K]['type'] extends 'number' ? number : T[K]['type'] extends 'boolean' ? boolean : string } {
  const rawParams = getHashParams();
  const result: Record<string, string | number | boolean> = {};

  for (const [key, config] of Object.entries(schema)) {
    const rawValue = rawParams[key];

    if (rawValue === undefined) {
      result[key] = config.default ?? (config.type === 'number' ? 0 : config.type === 'boolean' ? false : '');
      continue;
    }

    switch (config.type) {
      case 'number': {
        let numValue = parseFloat(rawValue);
        if (Number.isNaN(numValue)) {
          numValue = (config.default as number) ?? 0;
        }
        if (config.min !== undefined) numValue = Math.max(config.min, numValue);
        if (config.max !== undefined) numValue = Math.min(config.max, numValue);
        if (config.enum && !config.enum.includes(numValue)) {
          numValue = (config.default as number) ?? (config.enum[0] as number);
        }
        result[key] = numValue;
        break;
      }

      case 'boolean':
        result[key] = rawValue === 'true' || rawValue === '1';
        break;

      case 'string':
      default:
        if (config.enum && !config.enum.includes(rawValue)) {
          result[key] = (config.default as string) ?? (config.enum[0] as string);
        } else {
          result[key] = rawValue;
        }
        break;
    }
  }

  return result as { [K in keyof T]: T[K]['type'] extends 'number' ? number : T[K]['type'] extends 'boolean' ? boolean : string };
}

/**
 * Create a shareable URL with current parameters.
 */
export function getShareableUrl(): string {
  return window.location.href;
}

/**
 * Copy shareable URL to clipboard.
 */
export async function copyShareableUrl(): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(getShareableUrl());
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a param state manager for a demo.
 */
export interface ParamState<T extends Record<string, string | number | boolean>> {
  get: () => T;
  set: (updates: Partial<T>) => void;
  subscribe: (listener: (state: T) => void) => () => void;
  toUrlParams: () => Record<string, string>;
}

export function createParamState<T extends Record<string, string | number | boolean>>(
  initial: T
): ParamState<T> {
  let state = { ...initial };
  const listeners = new Set<(state: T) => void>();

  return {
    get: () => ({ ...state }),

    set: (updates: Partial<T>) => {
      state = { ...state, ...updates };
      listeners.forEach((l) => l(state));
    },

    subscribe: (listener: (state: T) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    toUrlParams: () => {
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(state)) {
        params[key] = String(value);
      }
      return params;
    },
  };
}
