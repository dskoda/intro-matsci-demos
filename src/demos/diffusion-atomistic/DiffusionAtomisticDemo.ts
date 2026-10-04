/**
 * Atomistic Diffusion Demo
 *
 * Solute atoms (circles stacked at each position x along a rod) hop randomly along the
 * rod, while a surface reservoir at x = 0 keeps the surface concentration constant.
 * The host atoms are not drawn. Compared live with the erf solution.
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import { Plot2D } from '@core/canvas/Plot2D';
import {
  createSlider,
  createSelect,
  createCheckbox,
  createButton,
  type Disposable,
  type SliderControl,
  type SelectControl,
  type CheckboxControl,
  type ButtonControl,
} from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import { hopProbability } from '../vacancy-diffusion/vacancy';
import { concentration } from '../diffusion-erf/diffusion';
import { SoluteRod, CAPACITY } from './solute';

interface DemoParams {
  /** Number of sites along the rod */
  size: number;
  /** Surface concentration (% of site capacity) */
  cs: number;
  /** Initial concentration in the rod (% of site capacity) */
  c0: number;
  /** Activation energy (eV) */
  Q: number;
  /** Temperature (K) */
  T: number;
  /** Surface exchange probability per sweep */
  exchange: number;
  /** log10 of sweeps per frame */
  logSpeed: number;
  showTheory: boolean;
}

const defaultParams: DemoParams = {
  size: 60,
  cs: 50,
  c0: 0,
  Q: 0.3,
  T: 900,
  exchange: 0.5,
  logSpeed: 1,
  showTheory: true,
};

const SIZES = [30, 60, 90];
const MARGIN_LEFT = 64;
const MARGIN_RIGHT = 24;
const PAD = 16;
const COLOR_SOLUTE = '#ff9f43';
const COLOR_SURFACE = '#f472b6';
const COLOR_THEORY = '#4ade80';
const MAX_SWEEPS_PER_FRAME = 3000;

function num(v: string | undefined, lo: number, hi: number, fallback: number): number {
  const x = v === undefined ? NaN : parseFloat(v);
  return clamp(Number.isFinite(x) ? x : fallback, lo, hi);
}

function parseParams(src: Record<string, string>, params: DemoParams): void {
  const size = num(src.size, SIZES[0]!, SIZES[SIZES.length - 1]!, params.size);
  params.size = SIZES.includes(size) ? size : params.size;
  params.cs = num(src.cs, 0, 100, params.cs);
  params.c0 = num(src.c0, 0, 100, params.c0);
  params.Q = num(src.Q, 0.05, 1.0, params.Q);
  params.T = num(src.T, 300, 1800, params.T);
  params.exchange = num(src.exchange, 0.05, 1, params.exchange);
  params.logSpeed = num(src.logSpeed, -1, 3.5, params.logSpeed);
  if (src.showTheory !== undefined) params.showTheory = src.showTheory === 'true';
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  const params: DemoParams = { ...defaultParams };
  parseParams(options.getParams(), params);

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0a0a0a', autoResize: true });
  const ctx = canvas.ctx;
  const plot = new Plot2D(ctx, {
    bounds: { xMin: 0, xMax: 1, yMin: 0, yMax: 100 },
    margins: { top: 16, right: MARGIN_RIGHT, bottom: 48, left: MARGIN_LEFT },
  });

  let rod = new SoluteRod(params.size);
  let seed = 1;
  let playing = true;
  let sweepAccum = 0;

  let sizeSelect: SelectControl | null = null;
  let csSlider: SliderControl | null = null;
  let c0Slider: SliderControl | null = null;
  let qSlider: SliderControl | null = null;
  let tSlider: SliderControl | null = null;
  let exchangeSlider: SliderControl | null = null;
  let speedSlider: SliderControl | null = null;
  let theoryCheckbox: CheckboxControl | null = null;
  let playButton: ButtonControl | null = null;
  let statsEl: HTMLElement | null = null;

  const disposables: Disposable[] = [];

  function pHop(): number {
    return hopProbability(params.Q, params.T);
  }

  function rebuild() {
    if (rod.n !== params.size) rod = new SoluteRod(params.size);
    rod.reset(params.cs / 100, params.c0 / 100, seed);
    sweepAccum = 0;
    render();
  }

  function advance(sweeps: number) {
    const p = pHop();
    for (let i = 0; i < sweeps; i++) rod.step(p, params.exchange, params.cs / 100);
  }

  function render() {
    const w = canvas.width;
    const h = canvas.height;
    canvas.clear();
    if (w < 200 || h < 260) return;

    const n = rod.n;
    const innerW = w - MARGIN_LEFT - MARGIN_RIGHT;
    const cw = innerW / n;

    // Stacked atoms
    const labelH = 18;
    const stackTop = PAD + labelH;
    const stackH = clamp(h * 0.42, 110, 320);
    const bottom = stackTop + stackH;
    const dia = Math.min(cw * 0.9, stackH / CAPACITY);

    ctx.fillStyle = 'rgba(244,114,182,0.12)';
    ctx.fillRect(MARGIN_LEFT, stackTop, cw, stackH);
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MARGIN_LEFT, bottom);
    ctx.lineTo(MARGIN_LEFT + innerW, bottom);
    ctx.stroke();

    for (let i = 0; i < n; i++) {
      const cx = MARGIN_LEFT + (i + 0.5) * cw;
      ctx.fillStyle = i === 0 ? COLOR_SURFACE : COLOR_SOLUTE;
      for (let k = 0; k < rod.counts[i]!; k++) {
        ctx.beginPath();
        ctx.arc(cx, bottom - (k + 0.5) * dia, dia * 0.46, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.fillStyle = '#aaa';
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('Surface reservoir', MARGIN_LEFT, stackTop - 3);
    ctx.textAlign = 'right';
    ctx.fillText('Solute atoms along the rod (host atoms not shown) →', w - MARGIN_RIGHT, stackTop - 3);

    // Profile plot (columns aligned with the stacks above)
    const plotTop = bottom + PAD;
    ctx.save();
    ctx.translate(0, plotTop);
    plot.setSize(w, h - plotTop - PAD);
    plot.setBounds({ xMin: -0.5, xMax: n - 0.5, yMin: 0, yMax: 100 });
    const xTicks = Plot2D.generateTicks(0, n - 1, 6);
    const yTicks = [0, 25, 50, 75, 100];
    plot.drawGrid(xTicks, yTicks);
    plot.drawAxes('Position along rod x (sites)', 'Concentration (%)');
    plot.drawTickLabels(xTicks, yTicks);

    const xs = Float64Array.from({ length: n }, (_, i) => i);
    const sim = Float64Array.from(rod.counts, (c) => (c / CAPACITY) * 100);
    if (params.showTheory) {
      const d = pHop() / 2;
      const theory = Float64Array.from(xs, (x) =>
        concentration(x, rod.sweeps, d, params.cs, params.c0)
      );
      plot.drawLine(xs, theory, COLOR_THEORY, 2);
    }
    plot.drawLine(xs, sim, COLOR_SOLUTE, 1.5);
    for (let i = 0; i < n; i++) plot.drawPoint(i, sim[i]!, 3, COLOR_SOLUTE);
    ctx.restore();

    updateStats();
  }

  function updateStats() {
    if (!statsEl) return;
    const p = pHop();
    const d = p / 2;
    statsEl.textContent = [
      `Hop probability per sweep: ${p >= 0.001 ? p.toFixed(4) : p.toExponential(2)}`,
      `D = ${d.toExponential(2)} sites²/sweep`,
      `Sweeps: ${rod.sweeps} · Hops: ${rod.hops}`,
      `2√(Dt) = ${(2 * Math.sqrt(d * rod.sweeps)).toFixed(1)} sites`,
      `Solute atoms in rod: ${rod.total}`,
    ].join('\n');
  }

  function getParamRecord(): Record<string, string> {
    return {
      size: String(params.size),
      cs: params.cs.toFixed(0),
      c0: params.c0.toFixed(0),
      Q: params.Q.toFixed(2),
      T: String(Math.round(params.T)),
      exchange: params.exchange.toFixed(2),
      logSpeed: params.logSpeed.toFixed(1),
      showTheory: String(params.showTheory),
    };
  }

  function syncControls() {
    sizeSelect?.setValue(String(params.size));
    csSlider?.setValue(params.cs);
    c0Slider?.setValue(params.c0);
    qSlider?.setValue(params.Q);
    tSlider?.setValue(params.T);
    exchangeSlider?.setValue(params.exchange);
    speedSlider?.setValue(params.logSpeed);
    theoryCheckbox?.setChecked(params.showTheory);
  }

  function onChange(rebuildNeeded: boolean) {
    if (rebuildNeeded) rebuild();
    else render();
    options.setParams(getParamRecord());
  }

  function slider(
    section: { content: HTMLElement },
    label: string,
    min: number,
    max: number,
    step: number,
    key: 'cs' | 'c0' | 'Q' | 'T' | 'exchange' | 'logSpeed',
    format: (v: number) => string,
    resets: boolean
  ): SliderControl {
    const s = createSlider({
      label,
      min,
      max,
      step,
      value: params[key],
      format,
      onChange: (v) => {
        params[key] = v;
        onChange(resets);
      },
    });
    disposables.push(s);
    section.content.appendChild(s.element);
    return s;
  }

  if (controlsPanel) {
    const setup = createSection({ title: 'Rod and concentrations' });
    disposables.push(setup);

    sizeSelect = createSelect({
      label: 'Rod length',
      options: SIZES.map((s) => ({ value: String(s), label: `${s} sites` })),
      value: String(params.size),
      onChange: (v) => {
        params.size = parseInt(v, 10);
        onChange(true);
      },
    });
    disposables.push(sizeSelect);
    setup.content.appendChild(sizeSelect.element);

    csSlider = slider(setup, 'Surface concentration, Cs', 0, 100, 1, 'cs', (v) => v.toFixed(0) + ' %', false);
    c0Slider = slider(setup, 'Initial concentration, C₀', 0, 100, 1, 'c0', (v) => v.toFixed(0) + ' %', true);
    exchangeSlider = slider(
      setup,
      'Surface exchange rate',
      0.05,
      1,
      0.05,
      'exchange',
      (v) => v.toFixed(2),
      false
    );
    setup.content.appendChild(
      createHelperText(
        'Concentration is the fraction of the 20 slots of a site that are occupied. At the surface, atoms appear and disappear at random so that Cs stays constant.'
      )
    );
    controlsPanel.appendChild(setup.element);

    const thermo = createSection({ title: 'Hopping' });
    disposables.push(thermo);
    qSlider = slider(thermo, 'Activation energy Q', 0.05, 1.0, 0.01, 'Q', (v) => v.toFixed(2) + ' eV', false);
    tSlider = slider(thermo, 'Temperature', 300, 1800, 10, 'T', (v) => v.toFixed(0) + ' K', false);
    thermo.content.appendChild(
      createHelperText('Each sweep, every solute atom hops to a random neighbour with probability exp(−Q/kT).')
    );
    controlsPanel.appendChild(thermo.element);

    const sim = createSection({ title: 'Simulation' });
    disposables.push(sim);
    speedSlider = slider(
      sim,
      'Speed',
      -1,
      3.5,
      0.1,
      'logSpeed',
      (v) => {
        const s = Math.pow(10, v);
        return (s < 10 ? s.toFixed(1) : s.toFixed(0)) + ' sweeps/frame';
      },
      false
    );

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

    const resetButton = createButton({
      label: 'Reset',
      variant: 'secondary',
      onClick: () => {
        seed = Math.floor(Math.random() * 1e9);
        rebuild();
      },
    });
    disposables.push(resetButton);
    sim.content.appendChild(resetButton.element);

    theoryCheckbox = createCheckbox({
      label: 'Show erf solution (green)',
      checked: params.showTheory,
      onChange: (c) => {
        params.showTheory = c;
        onChange(false);
      },
    });
    disposables.push(theoryCheckbox);
    sim.content.appendChild(theoryCheckbox.element);

    statsEl = createHelperText('');
    statsEl.style.whiteSpace = 'pre-line';
    sim.content.appendChild(statsEl);
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

export const diffusionAtomisticDemo: DemoDefinition = {
  id: 'diffusion-atomistic',
  title: 'Diffusion into a rod: atomistic view',
  description:
    'Solute atoms hop randomly along a rod while a surface reservoir keeps the surface concentration constant; the average profile converges to the erf solution.',
  category: 'Diffusion',
  tags: ['diffusion', 'Monte Carlo', 'random walk', 'erf', 'Fick'],
  create,
};

export default diffusionAtomisticDemo;
