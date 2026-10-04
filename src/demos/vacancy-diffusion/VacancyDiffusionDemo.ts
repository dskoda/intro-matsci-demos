/**
 * Vacancy Diffusion Demo
 *
 * Monte Carlo hopping of atoms into neighbouring vacancies on a 2D square lattice.
 * Start from a sharp A|B interface or a single crystal with tracer colouring.
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import { Plot2D } from '@core/canvas/Plot2D';
import {
  createSlider,
  createSelect,
  createButton,
  type Disposable,
  type SliderControl,
  type SelectControl,
} from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import {
  VacancyLattice,
  hopProbability,
  K_B_EV,
  VACANCY,
  SPECIES_A,
  type InitMode,
} from './vacancy';

interface DemoParams {
  mode: InitMode;
  size: number;
  /** Vacancy fraction */
  c: number;
  /** Temperature (K) */
  T: number;
  /** Activation energy (eV) */
  Ea: number;
  /** log10 of sweeps per frame */
  logSpeed: number;
}

const defaultParams: DemoParams = {
  mode: 'interface',
  size: 40,
  c: 0.05,
  T: 900,
  Ea: 0.4,
  logSpeed: 1.5,
};

const SIZES = [20, 30, 40, 60];
const COLOR_A = '#4a9eff';
const COLOR_B = '#ff9f43';
const N_TRACERS = 3;
const TRAIL_LEN = 400;
const MAX_HISTORY = 400;
const MAX_SWEEPS_PER_FRAME = 1000;

function num(v: string | undefined, lo: number, hi: number, fallback: number): number {
  const x = v === undefined ? NaN : parseFloat(v);
  return clamp(Number.isFinite(x) ? x : fallback, lo, hi);
}

function parseParams(src: Record<string, string>, params: DemoParams): void {
  if (src.mode === 'interface' || src.mode === 'crystal') params.mode = src.mode;
  const size = num(src.size, 20, 60, params.size);
  params.size = SIZES.includes(size) ? size : params.size;
  params.c = num(src.c, 0.005, 0.2, params.c);
  params.T = num(src.T, 300, 1800, params.T);
  params.Ea = num(src.Ea, 0.1, 2.0, params.Ea);
  params.logSpeed = num(src.logSpeed, -1, 3, params.logSpeed);
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  const params: DemoParams = { ...defaultParams };
  parseParams(options.getParams(), params);

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0a0a0a', autoResize: true });
  const ctx = canvas.ctx;
  const plot = new Plot2D(ctx, {
    bounds: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
    margins: { top: 24, right: 20, bottom: 44, left: 56 },
  });

  let lattice = new VacancyLattice(params.size);
  let seed = 1;
  let playing = true;
  let sweepAccum = 0;

  // History for MSD plot
  let histT: number[] = [];
  let histY: number[] = [];
  let histStride = 1;
  let histFrame = 0;
  // Tracer trails (wrapped site coordinates, NaN = break)
  let tracers: number[] = [];
  let trails: number[][] = [];
  let initialProfile: ArrayLike<number> = new Float64Array(0);

  let modeSelect: SelectControl | null = null;
  let sizeSelect: SelectControl | null = null;
  let cSlider: SliderControl | null = null;
  let tSlider: SliderControl | null = null;
  let eaSlider: SliderControl | null = null;
  let speedSlider: SliderControl | null = null;
  let playButton: ReturnType<typeof createButton> | null = null;
  let probEl: HTMLElement | null = null;
  let statsEl: HTMLElement | null = null;

  const disposables: Disposable[] = [];

  function pHop(): number {
    return hopProbability(params.Ea, params.T);
  }

  function rebuild() {
    if (lattice.n !== params.size) lattice = new VacancyLattice(params.size);
    lattice.reset(params.mode, params.c, seed);
    initialProfile = lattice.profile();
    sweepAccum = 0;
    histT = [0];
    histY = [0];
    histStride = 1;
    histFrame = 0;
    // Pick tracer atoms spread over the lattice
    tracers = [];
    trails = [];
    for (let k = 0; k < N_TRACERS; k++) {
      const x = Math.floor(((k + 0.5) / N_TRACERS) * lattice.n);
      const y = Math.floor(lattice.n / 2);
      let id = lattice.ids[y * lattice.n + x]!;
      if (id < 0) id = lattice.ids[y * lattice.n + x + 1]!;
      if (id >= 0) {
        tracers.push(id);
        trails.push([]);
      }
    }
    recordTrails();
    render();
  }

  function recordTrails() {
    const n = lattice.n;
    for (let k = 0; k < tracers.length; k++) {
      const s = lattice.siteOf[tracers[k]!]!;
      const trail = trails[k]!;
      const x = s % n;
      const y = (s - x) / n;
      const len = trail.length;
      if (len >= 2) {
        const px = trail[len - 2]!;
        const py = trail[len - 1]!;
        if (Math.abs(px - x) > n / 2 || Math.abs(py - y) > n / 2) trail.push(NaN, NaN);
      }
      trail.push(x, y);
      if (trail.length > TRAIL_LEN * 2) trail.splice(0, trail.length - TRAIL_LEN * 2);
    }
  }

  function recordHistory() {
    histFrame++;
    if (histFrame % histStride !== 0) return;
    histT.push(lattice.sweeps);
    histY.push(lattice.msd());
    if (histT.length > MAX_HISTORY) {
      histT = histT.filter((_, i) => i % 2 === 0);
      histY = histY.filter((_, i) => i % 2 === 0);
      histStride *= 2;
    }
  }

  function advance(sweeps: number) {
    const p = pHop();
    for (let i = 0; i < sweeps; i++) lattice.step(p);
    recordTrails();
    recordHistory();
  }

  function atomColor(species: number): string {
    return species === SPECIES_A ? COLOR_A : COLOR_B;
  }

  function render() {
    const w = canvas.width;
    const h = canvas.height;
    canvas.clear();
    if (w < 50 || h < 50) return;

    const n = lattice.n;
    const pad = 16;
    const wide = w >= h * 1.15;
    const side = wide
      ? Math.min(h - 2 * pad, w * 0.55)
      : Math.min(w - 2 * pad, h * 0.55);
    const ox = wide ? pad : (w - side) / 2;
    const oy = wide ? (h - side) / 2 : pad;
    const cell = side / n;

    // Lattice
    ctx.save();
    ctx.translate(ox, oy);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, side, side);
    const rAtom = cell * 0.42;
    for (let s = 0; s < lattice.sites; s++) {
      const x = s % n;
      const y = (s - x) / n;
      const g = lattice.grid[s]!;
      if (g === VACANCY) continue;
      ctx.fillStyle = atomColor(g);
      ctx.beginPath();
      ctx.arc((x + 0.5) * cell, (y + 0.5) * cell, rAtom, 0, Math.PI * 2);
      ctx.fill();
    }
    // Vacancies
    ctx.lineWidth = Math.max(1, cell * 0.08);
    for (let k = 0; k < lattice.vacancies.length; k++) {
      const s = lattice.vacancies[k]!;
      const x = s % n;
      const y = (s - x) / n;
      ctx.strokeStyle = lattice.hopped[k] ? '#ffffff' : '#777';
      ctx.beginPath();
      ctx.arc((x + 0.5) * cell, (y + 0.5) * cell, rAtom, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Tracer trails (single crystal)
    if (params.mode === 'crystal') {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1.5, cell * 0.12);
      ctx.lineJoin = 'round';
      for (const trail of trails) {
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i < trail.length; i += 2) {
          const tx = trail[i]!;
          if (Number.isNaN(tx)) {
            pen = false;
            continue;
          }
          const px = (tx + 0.5) * cell;
          const py = (trail[i + 1]! + 0.5) * cell;
          if (pen) ctx.lineTo(px, py);
          else ctx.moveTo(px, py);
          pen = true;
        }
        ctx.stroke();
      }
      for (const id of tracers) {
        const s = lattice.siteOf[id]!;
        const x = s % n;
        const y = (s - x) / n;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc((x + 0.5) * cell, (y + 0.5) * cell, rAtom * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, side, side);
    ctx.restore();

    // Plot
    const px = wide ? ox + side + pad : pad;
    const py = wide ? pad : oy + side + pad;
    const pw = wide ? w - px - pad : w - 2 * pad;
    const ph = wide ? h - 2 * pad : h - py - pad;
    if (pw > 120 && ph > 100) {
      ctx.save();
      ctx.translate(px, py);
      plot.setSize(pw, ph);
      drawPlot();
      ctx.restore();
    }

    updateStats();
  }

  function drawPlot() {
    const n = lattice.n;
    if (params.mode === 'interface') {
      plot.setBounds({ xMin: 0, xMax: n - 1, yMin: 0, yMax: 1 });
      const xs = Float64Array.from({ length: n }, (_, i) => i);
      plot.drawGrid(Plot2D.generateTicks(0, n - 1, 5), [0, 0.25, 0.5, 0.75, 1]);
      plot.drawAxes('Column x', 'Fraction of A atoms');
      plot.drawTickLabels(Plot2D.generateTicks(0, n - 1, 5), [0, 0.5, 1], undefined, (v) =>
        v.toFixed(1)
      );
      plot.drawLine(xs, initialProfile, '#666', 1.5);
      plot.drawLine(xs, lattice.profile(), COLOR_A, 2.5);
    } else {
      const tMax = Math.max(10, histT[histT.length - 1] ?? 10);
      const yMax = Math.max(1, ...histY) * 1.1;
      plot.setBounds({ xMin: 0, xMax: tMax, yMin: 0, yMax });
      const xt = Plot2D.generateTicks(0, tMax, 5);
      const yt = Plot2D.generateTicks(0, yMax, 4);
      plot.drawGrid(xt, yt);
      plot.drawAxes('MC sweeps', 'MSD (lattice spacings²)');
      plot.drawTickLabels(xt, yt);
      plot.drawLine(histT, histY, '#4ade80', 2.5);
    }
  }

  function updateProbText() {
    if (!probEl) return;
    const p = pHop();
    probEl.textContent =
      `kT = ${(K_B_EV * params.T).toFixed(3)} eV · hop probability exp(−Ea/kT) = ` +
      (p >= 0.001 ? p.toFixed(4) : p.toExponential(2));
  }

  function updateStats() {
    if (!statsEl) return;
    const lines = [
      `Sweeps: ${lattice.sweeps} · Hops: ${lattice.hops}`,
      `Vacancies: ${lattice.vacancyCount} of ${lattice.sites} sites`,
    ];
    lines.push(
      params.mode === 'interface'
        ? `Interface width (10–90%): ${lattice.mixingWidth().toFixed(1)} spacings`
        : `MSD: ${lattice.msd().toFixed(2)} spacings²`
    );
    statsEl.textContent = lines.join('\n');
  }

  function getParamRecord(): Record<string, string> {
    return {
      mode: params.mode,
      size: String(params.size),
      c: params.c.toFixed(3),
      T: String(Math.round(params.T)),
      Ea: params.Ea.toFixed(2),
      logSpeed: params.logSpeed.toFixed(1),
    };
  }

  function syncControls() {
    modeSelect?.setValue(params.mode);
    sizeSelect?.setValue(String(params.size));
    cSlider?.setValue(params.c * 100);
    tSlider?.setValue(params.T);
    eaSlider?.setValue(params.Ea);
    speedSlider?.setValue(params.logSpeed);
    updateProbText();
  }

  function onChange(rebuildNeeded: boolean) {
    if (rebuildNeeded) rebuild();
    updateProbText();
    options.setParams(getParamRecord());
  }

  if (controlsPanel) {
    const setup = createSection({ title: 'Setup' });
    disposables.push(setup);

    modeSelect = createSelect({
      label: 'Initial condition',
      options: [
        { value: 'interface', label: 'Sharp A|B interface' },
        { value: 'crystal', label: 'Single crystal (tracers)' },
      ],
      value: params.mode,
      onChange: (v) => {
        params.mode = v as InitMode;
        onChange(true);
      },
    });
    disposables.push(modeSelect);
    setup.content.appendChild(modeSelect.element);

    sizeSelect = createSelect({
      label: 'Lattice size',
      options: SIZES.map((s) => ({ value: String(s), label: `${s} × ${s}` })),
      value: String(params.size),
      onChange: (v) => {
        params.size = parseInt(v, 10);
        onChange(true);
      },
    });
    disposables.push(sizeSelect);
    setup.content.appendChild(sizeSelect.element);

    cSlider = createSlider({
      label: 'Vacancy concentration',
      min: 0.5,
      max: 20,
      step: 0.5,
      value: params.c * 100,
      format: (v) => v.toFixed(1) + ' %',
      onChange: (v) => {
        params.c = v / 100;
        onChange(true);
      },
    });
    disposables.push(cSlider);
    setup.content.appendChild(cSlider.element);

    const resetButton = createButton({
      label: 'Reset',
      variant: 'secondary',
      onClick: () => {
        seed = Math.floor(Math.random() * 1e9);
        rebuild();
      },
    });
    disposables.push(resetButton);
    setup.content.appendChild(resetButton.element);
    controlsPanel.appendChild(setup.element);

    const thermo = createSection({ title: 'Thermodynamics' });
    disposables.push(thermo);

    tSlider = createSlider({
      label: 'Temperature',
      min: 300,
      max: 1800,
      step: 10,
      value: params.T,
      format: (v) => v.toFixed(0) + ' K',
      onChange: (v) => {
        params.T = v;
        onChange(false);
      },
    });
    disposables.push(tSlider);
    thermo.content.appendChild(tSlider.element);

    eaSlider = createSlider({
      label: 'Activation energy Ea',
      min: 0.1,
      max: 2.0,
      step: 0.05,
      value: params.Ea,
      format: (v) => v.toFixed(2) + ' eV',
      onChange: (v) => {
        params.Ea = v;
        onChange(false);
      },
    });
    disposables.push(eaSlider);
    thermo.content.appendChild(eaSlider.element);

    probEl = createHelperText('');
    thermo.content.appendChild(probEl);
    controlsPanel.appendChild(thermo.element);

    const sim = createSection({ title: 'Simulation' });
    disposables.push(sim);

    speedSlider = createSlider({
      label: 'Speed',
      min: -1,
      max: 3,
      step: 0.1,
      value: params.logSpeed,
      format: (v) => {
        const s = Math.pow(10, v);
        return (s < 10 ? s.toFixed(1) : s.toFixed(0)) + ' sweeps/frame';
      },
      onChange: (v) => {
        params.logSpeed = v;
        onChange(false);
      },
    });
    disposables.push(speedSlider);
    sim.content.appendChild(speedSlider.element);

    playButton = createButton({
      label: 'Pause',
      variant: 'primary',
      onClick: () => {
        playing = !playing;
        playButton?.setLabel(playing ? 'Pause' : 'Play');
      },
    });
    disposables.push(playButton);
    sim.content.appendChild(playButton.element);

    const stepButton = createButton({
      label: 'Step (1 sweep)',
      variant: 'secondary',
      onClick: () => {
        advance(1);
        render();
      },
    });
    disposables.push(stepButton);
    sim.content.appendChild(stepButton.element);

    statsEl = createHelperText('');
    statsEl.style.whiteSpace = 'pre-line';
    sim.content.appendChild(statsEl);
    sim.content.appendChild(
      createHelperText(
        'Each sweep, every vacancy picks a random neighbour and swaps with it with probability exp(−Ea/kT). Hollow circles are vacancies (white = just hopped).'
      )
    );
    controlsPanel.appendChild(sim.element);
  }

  const loop = new AnimationLoop(() => {
    if (playing) {
      sweepAccum += Math.pow(10, params.logSpeed);
      const n = Math.min(MAX_SWEEPS_PER_FRAME, Math.floor(sweepAccum));
      sweepAccum -= Math.floor(sweepAccum);
      if (n > 0) advance(n);
    }
    render();
  });

  canvas.onResize(() => {
    if (!loop.running) render();
  });

  rebuild();
  syncControls();

  return {
    start() {
      loop.start();
    },
    stop() {
      loop.stop();
    },
    resize() {
      render();
    },
    dispose() {
      loop.dispose();
      disposables.forEach((d) => d.dispose());
      canvas.dispose();
    },
    getParams: getParamRecord,
    setParams(p: Record<string, string>) {
      parseParams(p, params);
      rebuild();
      syncControls();
    },
  };
}

export const vacancyDiffusionDemo: DemoDefinition = {
  id: 'vacancy-diffusion',
  title: 'Vacancy diffusion',
  description:
    'Monte Carlo simulation of atoms hopping into neighbouring vacancies on a 2D lattice: watch an A|B interface interdiffuse as a function of temperature, activation energy and vacancy concentration.',
  category: 'Diffusion',
  tags: ['diffusion', 'vacancy', 'Monte Carlo', 'defects', 'Arrhenius'],
  create,
};

export default vacancyDiffusionDemo;
