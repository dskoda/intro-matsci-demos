/**
 * Course lectures shown on the home page.
 *
 * Edit this list: each lecture has a number, a title, and the ids of the demos
 * (from `src/demos/index.ts`) that belong to it. Demos not listed here are shown
 * under "Other demos" so that none is lost.
 */

export interface Lecture {
  number: number;
  title: string;
  demos: string[];
}

export const lectures: Lecture[] = [
  { number: 1, title: 'Atoms & bonding', demos: ['lennard-jones', 'lj-2d-crystallization'] },
  { number: 2, title: 'Crystal structures', demos: ['crystal-structures', 'miller-indices'] },
  { number: 3, title: 'Defects & diffusion', demos: ['defects-2d', 'defects-3d', 'vacancy-diffusion'] },
];
