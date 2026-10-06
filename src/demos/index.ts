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
import { millerIndicesDemo } from './miller-indices/MillerIndicesDemo';
import { defects2DDemo } from './defects/Defects2DDemo';
import { defects3DDemo } from './defects/Defects3DDemo';
import { vacancyDiffusionDemo } from './vacancy-diffusion/VacancyDiffusionDemo';
import { diffusionErfDemo } from './diffusion-erf/DiffusionErfDemo';
import { diffusionAtomisticDemo } from './diffusion-atomistic/DiffusionAtomisticDemo';
import { elasticPlasticDemo } from './elastic-plastic/ElasticPlasticDemo';

/**
 * All registered demos.
 * Add new demos to this array.
 */
export const allDemos: DemoDefinition[] = [
  lennardJonesDemo,
  ljMD2DDemo,
  crystalStructuresDemo,
  millerIndicesDemo,
  defects2DDemo,
  defects3DDemo,
  vacancyDiffusionDemo,
  diffusionErfDemo,
  diffusionAtomisticDemo,
  elasticPlasticDemo,
  // Add new demos here:
];

export {
  lennardJonesDemo,
  ljMD2DDemo,
  crystalStructuresDemo,
  millerIndicesDemo,
  defects2DDemo,
  defects3DDemo,
  vacancyDiffusionDemo,
  diffusionErfDemo,
  diffusionAtomisticDemo,
  elasticPlasticDemo,
};
