/**
 * Demo Registry
 *
 * Central registry for all demos in the platform.
 */

import type { DemoDefinition } from './types';

/** Internal demo registry map */
const demoRegistry = new Map<string, DemoDefinition>();

/**
 * Register a demo with the platform.
 * Call this for each demo module at startup.
 */
export function registerDemo(demo: DemoDefinition): void {
  if (demoRegistry.has(demo.id)) {
    console.warn(`Demo with id "${demo.id}" is already registered. Overwriting.`);
  }
  demoRegistry.set(demo.id, demo);
}

/**
 * Register multiple demos at once.
 */
export function registerDemos(demos: DemoDefinition[]): void {
  demos.forEach(registerDemo);
}

/**
 * Get a demo by its ID.
 */
export function getDemo(id: string): DemoDefinition | undefined {
  return demoRegistry.get(id);
}

/**
 * Get all registered demos.
 */
export function getAllDemos(): DemoDefinition[] {
  return Array.from(demoRegistry.values());
}

/**
 * Get demos grouped by category.
 */
export function getDemosByCategory(): Map<string, DemoDefinition[]> {
  const categories = new Map<string, DemoDefinition[]>();

  for (const demo of demoRegistry.values()) {
    const category = demo.category ?? 'Uncategorized';
    const list = categories.get(category) ?? [];
    list.push(demo);
    categories.set(category, list);
  }

  return categories;
}

/**
 * Check if a demo with given ID exists.
 */
export function hasDemo(id: string): boolean {
  return demoRegistry.has(id);
}

/**
 * Get total number of registered demos.
 */
export function getDemoCount(): number {
  return demoRegistry.size;
}
