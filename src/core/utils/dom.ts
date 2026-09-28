/**
 * DOM Utilities
 *
 * Helper functions for DOM manipulation.
 */

/**
 * Create an element with optional class and attributes.
 */
export function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options?: {
    className?: string;
    id?: string;
    text?: string;
    html?: string;
    attributes?: Record<string, string>;
    styles?: Partial<CSSStyleDeclaration>;
    parent?: HTMLElement;
  }
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);

  if (options) {
    if (options.className) el.className = options.className;
    if (options.id) el.id = options.id;
    if (options.text) el.textContent = options.text;
    if (options.html) el.innerHTML = options.html;

    if (options.attributes) {
      Object.entries(options.attributes).forEach(([key, value]) => {
        el.setAttribute(key, value);
      });
    }

    if (options.styles) {
      Object.assign(el.style, options.styles);
    }

    if (options.parent) {
      options.parent.appendChild(el);
    }
  }

  return el;
}

/**
 * Query selector with type safety.
 */
export function qs<T extends HTMLElement = HTMLElement>(
  selector: string,
  parent: ParentNode = document
): T | null {
  return parent.querySelector<T>(selector);
}

/**
 * Query selector that throws if not found.
 */
export function qsRequired<T extends HTMLElement = HTMLElement>(
  selector: string,
  parent: ParentNode = document
): T {
  const el = parent.querySelector<T>(selector);
  if (!el) {
    throw new Error(`Element not found: ${selector}`);
  }
  return el;
}

/**
 * Query selector all with array return.
 */
export function qsa<T extends HTMLElement = HTMLElement>(
  selector: string,
  parent: ParentNode = document
): T[] {
  return Array.from(parent.querySelectorAll<T>(selector));
}

/**
 * Remove all children from an element.
 */
export function clearChildren(element: HTMLElement): void {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

/**
 * Add multiple classes to an element.
 */
export function addClasses(element: HTMLElement, ...classes: string[]): void {
  element.classList.add(...classes);
}

/**
 * Remove multiple classes from an element.
 */
export function removeClasses(element: HTMLElement, ...classes: string[]): void {
  element.classList.remove(...classes);
}

/**
 * Toggle a class on an element.
 */
export function toggleClass(element: HTMLElement, className: string, force?: boolean): boolean {
  return element.classList.toggle(className, force);
}

/**
 * Set multiple CSS styles.
 */
export function setStyles(element: HTMLElement, styles: Partial<CSSStyleDeclaration>): void {
  Object.assign(element.style, styles);
}

/**
 * Get computed style value.
 */
export function getStyle(element: HTMLElement, property: string): string {
  return getComputedStyle(element).getPropertyValue(property);
}

/**
 * Show an element (remove display: none).
 */
export function show(element: HTMLElement, display = 'block'): void {
  element.style.display = display;
}

/**
 * Hide an element (set display: none).
 */
export function hide(element: HTMLElement): void {
  element.style.display = 'none';
}

/**
 * Check if element is visible.
 */
export function isVisible(element: HTMLElement): boolean {
  return element.style.display !== 'none' && element.offsetParent !== null;
}

/**
 * Get element's bounding rectangle.
 */
export function getBounds(element: HTMLElement): DOMRect {
  return element.getBoundingClientRect();
}

/**
 * Set element's data attributes.
 */
export function setData(element: HTMLElement, data: Record<string, string>): void {
  Object.entries(data).forEach(([key, value]) => {
    element.dataset[key] = value;
  });
}

/**
 * Get element's data attribute.
 */
export function getData(element: HTMLElement, key: string): string | undefined {
  return element.dataset[key];
}

/**
 * Wait for next animation frame.
 */
export function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/**
 * Wait for a specified time.
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
