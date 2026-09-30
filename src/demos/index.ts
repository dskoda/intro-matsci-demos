/**
 * Demos Registry
 *
 * Import and export all demos here.
 * New demos should be added to the allDemos array.
 */

import type { DemoDefinition } from '@app/types';
import { lennardJonesDemo } from './lennard-jones/LennardJonesDemo';
import { ljMD2DDemo } from './lj-2d-crystallization/LJMD2DDemo';
import { crystalStructuresDemo } from './crystal-structures/CrystalStructuresDemo';

/**
 * All registered demos.
 * Add new demos to this array.
 */
export const allDemos: DemoDefinition[] = [
  lennardJonesDemo,
  ljMD2DDemo,
  crystalStructuresDemo,
  // Add new demos here:
];

export { lennardJonesDemo, ljMD2DDemo, crystalStructuresDemo };
