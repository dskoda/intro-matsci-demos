/**
 * Demos Registry
 *
 * Import and export all demos here.
 * New demos should be added to the allDemos array.
 */

import type { DemoDefinition } from '@app/types';
import { demoTemplate } from './_template/DemoTemplate';
import { lennardJonesDemo } from './lennard-jones/LennardJonesDemo';

/**
 * All registered demos.
 * Add new demos to this array.
 */
export const allDemos: DemoDefinition[] = [
  demoTemplate,
  lennardJonesDemo,
  // Add new demos here:
];

export { demoTemplate, lennardJonesDemo };
