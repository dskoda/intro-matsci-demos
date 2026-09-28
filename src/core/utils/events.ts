/**
 * Event Utilities
 *
 * Helper functions for event binding and cleanup.
 */

/** Event listener entry for disposal */
interface EventListenerEntry {
  target: EventTarget;
  type: string;
  listener: EventListenerOrEventListenerObject;
  options?: AddEventListenerOptions;
}

/**
 * Event binder that tracks listeners for easy disposal.
 */
export class EventBinder {
  private listeners: EventListenerEntry[] = [];

  /**
   * Add an event listener and track it for disposal.
   */
  on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (this: HTMLElement, ev: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions
  ): this;

  on<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    listener: (this: Window, ev: WindowEventMap[K]) => void,
    options?: AddEventListenerOptions
  ): this;

  on<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    listener: (this: Document, ev: DocumentEventMap[K]) => void,
    options?: AddEventListenerOptions
  ): this;

  on(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions
  ): this {
    target.addEventListener(type, listener, options);
    this.listeners.push({ target, type, listener, options });
    return this;
  }

  /**
   * Remove a specific listener.
   */
  off(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject
  ): this {
    target.removeEventListener(type, listener);
    this.listeners = this.listeners.filter(
      (e) => !(e.target === target && e.type === type && e.listener === listener)
    );
    return this;
  }

  /**
   * Remove all tracked listeners.
   */
  dispose(): void {
    this.listeners.forEach((entry) => {
      entry.target.removeEventListener(entry.type, entry.listener, entry.options);
    });
    this.listeners = [];
  }

  /**
   * Get the number of tracked listeners.
   */
  get count(): number {
    return this.listeners.length;
  }
}

/**
 * Create an event binder.
 */
export function createEventBinder(): EventBinder {
  return new EventBinder();
}

/**
 * One-time event listener.
 */
export function once<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  listener: (this: HTMLElement, ev: HTMLElementEventMap[K]) => void
): void {
  target.addEventListener(type, listener, { once: true });
}

/**
 * Debounce a function.
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: number | undefined;

  return (...args: Parameters<T>) => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    timeoutId = window.setTimeout(() => {
      fn(...args);
      timeoutId = undefined;
    }, delay);
  };
}

/**
 * Throttle a function.
 */
export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let lastRun = 0;
  let timeoutId: number | undefined;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = limit - (now - lastRun);

    if (remaining <= 0) {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      lastRun = now;
      fn(...args);
    } else if (timeoutId === undefined) {
      timeoutId = window.setTimeout(() => {
        lastRun = Date.now();
        fn(...args);
        timeoutId = undefined;
      }, remaining);
    }
  };
}

/**
 * Create a keyboard shortcut handler.
 */
export function onKeyCombo(
  combo: string,
  handler: (e: KeyboardEvent) => void,
  target: EventTarget = window
): () => void {
  const parts = combo.toLowerCase().split('+');
  const key = parts[parts.length - 1]!;
  const modifiers = {
    ctrl: parts.includes('ctrl'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    meta: parts.includes('meta'),
  };

  const listener = (e: Event) => {
    const ke = e as KeyboardEvent;
    if (
      ke.key.toLowerCase() === key &&
      ke.ctrlKey === modifiers.ctrl &&
      ke.shiftKey === modifiers.shift &&
      ke.altKey === modifiers.alt &&
      ke.metaKey === modifiers.meta
    ) {
      handler(ke);
    }
  };

  target.addEventListener('keydown', listener);

  return () => {
    target.removeEventListener('keydown', listener);
  };
}
