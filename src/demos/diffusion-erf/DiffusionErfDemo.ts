/**
 * Diffusion Profile Demo (erf solution)
 *
 * A rod with uniform initial concentration C0 is exposed to a constant surface
 * concentration Cs. Shows C(x, t) = Cs - (Cs - C0) erf(x / 2 sqrt(Dt)) with
 * D = D0 exp(-Q/kT), evolving over (logarithmic) time.
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import { Plot2D } from '@core/canvas/Plot2D';
import {
  createSlider,
  createButton,
  type Disposable,
  type SliderControl,
  type ButtonControl,
} from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import {
  diffusivity,
  concentration,
  diffusionLength,
  depthOfFraction,
  absorbedAmount,
  formatTime,
  formatLength,
} from './diffusion';

interface DemoParams {
  /** log10 of D0 (m^2/s) */
  logD0: number;
  /** Activation energy (eV) */
  Q: number;
  /** Temperatures of the three compared curves (K) */
  T1: number;
  T2: number;
  T3: number;
  /** Surface concentration (at.%) */
  cs: number;
  /** Initial concentration (at.%) */
  c0: number;
  /** log10 of elapsed time (s) */
  logT: number;
  /** log10 of rod length shown (m) */
  logL: number;
  /** Time evolution speed in decades per second */
  speed: number;
}

const defaultParams: DemoParams = {
  logD0: -5,
  Q: 1.0,
  T1: 900,
  T2: 1000,
  T3: 1100,
  cs: 1.0,
  c0: 0.1,
  logT: 1,
  logL: -2,
  speed: 0.4,
};

const LOG_T_MIN = 0;
const LOG_T_MAX = 9;
const MARGIN_LEFT = 64;
const MARGIN_RIGHT = 24;
const ROD_HEIGHT = 70;
const PAD = 16;
/** Colors of the three temperature curves (and their sliders) */
const CURVE_COLORS = ['#4a9eff', '#ff9f43', '#f472b6'];
/** Fixed concentration axis maximum (at.%), equal to the slider maximum */
const C_AXIS_MAX = 10;

function num(v: string | undefined, lo: number, hi: number, fallback: number): number {
  const x = v === undefined ? NaN : parseFloat(v);
  return clamp(Number.isFinite(x) ? x : fallback, lo, hi);
}

function parseParams(src: Record<string, string>, params: DemoParams): void {
  params.logD0 = num(src.logD0, -10, 0, params.logD0);
  params.Q = num(src.Q, 0.1, 3.0, params.Q);
  params.T1 = num(src.T1, 300, 1800, params.T1);
  params.T2 = num(src.T2, 300, 1800, params.T2);
  params.T3 = num(src.T3, 300, 1800, params.T3);
  params.cs = num(src.cs, 0, 10, params.cs);
  params.c0 = num(src.c0, 0, 10, params.c0);
  params.logT = num(src.logT, LOG_T_MIN, LOG_T_MAX, params.logT);
  params.logL = num(src.logL, -6, 0, params.logL);
  params.speed = num(src.speed, 0.05, 2, params.speed);
}

/** Dark blue (low) to orange (high). */
function colorAt(f: number): string {
  const t = clamp(f, 0, 1);
  const r = Math.round(20 + t * (255 - 20));
  const g = Math.round(40 + t * (170 - 40));
  const b = Math.round(90 + t * (60 - 90));
  return `rgb(${r},${g},${b})`;
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  const params: DemoParams = { ...defaultParams };
  parseParams(options.getParams(), params);

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0a0a0a', autoResize: true });
  const ctx = canvas.ctx;
  const plot = new Plot2D(ctx, {
    bounds: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
    margins: { top: 20, right: MARGIN_RIGHT, bottom: 48, left: MARGIN_LEFT },
  });

  let playing = true;

  let logD0Slider: SliderControl | null = null;
  let qSlider: SliderControl | null = null;
  const tempSliders: (SliderControl | null)[] = [null, null, null];
  let csSlider: SliderControl | null = null;
  let c0Slider: SliderControl | null = null;
  let timeSlider: SliderControl | null = null;
  let lSlider: SliderControl | null = null;
  let speedSlider: SliderControl | null = null;
  let playButton: ButtonControl | null = null;
  let statsEl: HTMLElement | null = null;

  const disposables: Disposable[] = [];

  function temperatures(): number[] {
    return [params.T1, params.T2, params.T3];
  }

  function diffusion(tempK: number): number {
    return diffusivity(Math.pow(10, params.logD0), params.Q, tempK);
  }

  function time(): number {
    return Math.pow(10, params.logT);
  }

  function rodLength(): number {
    return Math.pow(10, params.logL);
  }

  function render() {
    const w = canvas.width;
    const h = canvas.height;
    canvas.clear();
    if (w < 150 || h < 200) return;

    const t = time();
    const temps = temperatures();
    const ds = temps.map(diffusion);
    const xMax = rodLength();
    const cMax = C_AXIS_MAX;
    const nPts = 200;
    const xs = Float64Array.from({ length: nPts }, (_, i) => (i / (nPts - 1)) * xMax);
    const profile = (d: number) =>
      Float64Array.from(xs, (x) => concentration(x, t, d, params.cs, params.c0));

    // Rods (one per temperature, aligned with the plot x-range)
    const rodLeft = MARGIN_LEFT;
    const rodWidth = w - MARGIN_LEFT - MARGIN_RIGHT;
    const cols = Math.max(1, Math.floor(rodWidth));
    const gap = 3;
    const stripH = (ROD_HEIGHT - 2 * gap) / 3;
    for (let k = 0; k < 3; k++) {
      const y0 = PAD + k * (stripH + gap);
      for (let i = 0; i < cols; i++) {
        const c = concentration((i / cols) * xMax, t, ds[k]!, params.cs, params.c0);
        ctx.fillStyle = colorAt(c / cMax);
        ctx.fillRect(rodLeft + i, y0, 2, stripH);
      }
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 1;
      ctx.strokeRect(rodLeft, y0, rodWidth, stripH);
      ctx.fillStyle = CURVE_COLORS[k]!;
      ctx.fillRect(rodLeft - 9, y0, 5, stripH);
    }
    ctx.fillStyle = '#aaa';
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`Surface (C = ${params.cs.toFixed(1)} at.%) →  rod interior`, rodLeft, PAD - 2);

    // Plot
    const plotTop = PAD + ROD_HEIGHT + PAD + 18;
    ctx.save();
    ctx.translate(0, plotTop);
    plot.setSize(w, h - plotTop - PAD);
    plot.setBounds({ xMin: 0, xMax, yMin: 0, yMax: cMax });
    const xTicks = Plot2D.generateTicks(0, xMax, 5);
    const yTicks = Plot2D.generateTicks(0, cMax, 5);
    plot.drawGrid(xTicks, yTicks);
    plot.drawAxes('Depth x', 'C (at.%)');
    plot.drawTickLabels(xTicks, yTicks, (v) => (v === 0 ? '0' : formatLength(v)));

    const flat = (c: number) => new Float64Array(nPts).fill(c);
    plot.drawLine(xs, flat(params.c0), '#555', 1);
    plot.drawLine(xs, flat(params.cs), '#555', 1);
    for (let k = 0; k < 3; k++) {
      plot.drawLine(xs, profile(ds[k]!), CURVE_COLORS[k]!, 2.5);
    }
    ctx.restore();

    updateStats(ds, temps, t);
  }

  function updateStats(ds: number[], temps: number[], t: number) {
    if (!statsEl) return;
    const lines = [`Time: ${formatTime(t)}`];
    for (let k = 0; k < 3; k++) {
      const d = ds[k]!;
      lines.push(
        `<span style="color:${CURVE_COLORS[k]}">${temps[k]!.toFixed(0)} K: D = ${d.toExponential(2)} m²/s, ` +
          `2√(Dt) = ${formatLength(diffusionLength(t, d))}, ` +
          `C mid-point at ${formatLength(depthOfFraction(t, d, 0.5))}, ` +
          `absorbed ${absorbedAmount(t, d, params.cs, params.c0).toExponential(2)} at.%·m</span>`
      );
    }
    statsEl.innerHTML = lines.join('<br />');
  }

  function getParamRecord(): Record<string, string> {
    return {
      logD0: params.logD0.toFixed(1),
      Q: params.Q.toFixed(2),
      T1: String(Math.round(params.T1)),
      T2: String(Math.round(params.T2)),
      T3: String(Math.round(params.T3)),
      cs: params.cs.toFixed(1),
      c0: params.c0.toFixed(1),
      logT: params.logT.toFixed(2),
      logL: params.logL.toFixed(1),
      speed: params.speed.toFixed(2),
    };
  }

  function syncControls() {
    logD0Slider?.setValue(params.logD0);
    qSlider?.setValue(params.Q);
    tempSliders[0]?.setValue(params.T1);
    tempSliders[1]?.setValue(params.T2);
    tempSliders[2]?.setValue(params.T3);
    csSlider?.setValue(params.cs);
    c0Slider?.setValue(params.c0);
    timeSlider?.setValue(params.logT);
    lSlider?.setValue(params.logL);
    speedSlider?.setValue(params.speed);
  }

  function onChange() {
    render();
    options.setParams(getParamRecord());
  }

  function slider(
    section: { content: HTMLElement },
    label: string,
    min: number,
    max: number,
    step: number,
    key: keyof DemoParams,
    format: (v: number) => string,
    color?: string
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
        onChange();
      },
    });
    if (color) {
      s.element.style.setProperty('--color-primary', color);
      const labelText = s.element.querySelector<HTMLElement>('.control-label span');
      if (labelText) labelText.style.color = color;
    }
    disposables.push(s);
    section.content.appendChild(s.element);
    return s;
  }

  if (controlsPanel) {
    const diff = createSection({ title: 'Diffusion coefficient' });
    disposables.push(diff);
    logD0Slider = slider(diff, 'D₀ (log scale)', -10, 0, 0.1, 'logD0', (v) =>
      `10^${v.toFixed(1)} m²/s`
    );
    qSlider = slider(diff, 'Activation energy Q', 0.1, 3.0, 0.05, 'Q', (v) => v.toFixed(2) + ' eV');
    (['T1', 'T2', 'T3'] as const).forEach((key, k) => {
      tempSliders[k] = slider(
        diff,
        `Temperature ${k + 1}`,
        300,
        1800,
        10,
        key,
        (v) => v.toFixed(0) + ' K',
        CURVE_COLORS[k]
      );
    });
    diff.content.appendChild(
      createHelperText('D = D₀ exp(−Q / kT); one curve and rod per temperature')
    );
    controlsPanel.appendChild(diff.element);

    const conc = createSection({ title: 'Concentrations' });
    disposables.push(conc);
    csSlider = slider(conc, 'Surface, Cs', 0, 10, 0.1, 'cs', (v) => v.toFixed(1) + ' at.%');
    c0Slider = slider(conc, 'Initial in rod, C₀', 0, 10, 0.1, 'c0', (v) => v.toFixed(1) + ' at.%');
    conc.content.appendChild(
      createHelperText('C(x,t) = Cs − (Cs − C₀) erf( x / 2√(Dt) )')
    );
    controlsPanel.appendChild(conc.element);

    const sim = createSection({ title: 'Time' });
    disposables.push(sim);
    timeSlider = slider(sim, 'Elapsed time (log scale)', LOG_T_MIN, LOG_T_MAX, 0.01, 'logT', (v) =>
      formatTime(Math.pow(10, v))
    );
    speedSlider = slider(sim, 'Speed', 0.05, 2, 0.05, 'speed', (v) => v.toFixed(2) + ' decades/s');

    playButton = createButton({
      label: 'Pause',
      variant: 'primary',
      onClick: () => {
        if (!playing && params.logT >= LOG_T_MAX) params.logT = LOG_T_MIN;
        playing = !playing;
        playButton?.setLabel(playing ? 'Pause' : 'Play');
        syncControls();
        onChange();
      },
    });
    disposables.push(playButton);
    sim.content.appendChild(playButton.element);

    const restart = createButton({
      label: 'Restart',
      variant: 'secondary',
      onClick: () => {
        params.logT = LOG_T_MIN;
        playing = true;
        playButton?.setLabel('Pause');
        syncControls();
        onChange();
      },
    });
    disposables.push(restart);
    sim.content.appendChild(restart.element);
    controlsPanel.appendChild(sim.element);

    const view = createSection({ title: 'Rod' });
    disposables.push(view);
    lSlider = slider(view, 'Rod length (log scale)', -6, 0, 0.1, 'logL', (v) =>
      formatLength(Math.pow(10, v))
    );
    statsEl = createHelperText('');
    statsEl.style.whiteSpace = 'pre-line';
    view.content.appendChild(statsEl);
    controlsPanel.appendChild(view.element);
  }

  const loop = new AnimationLoop((dt) => {
    if (playing) {
      params.logT += params.speed * dt;
      if (params.logT >= LOG_T_MAX) {
        params.logT = LOG_T_MAX;
        playing = false;
        playButton?.setLabel('Play');
        options.setParams(getParamRecord());
      }
      timeSlider?.setValue(params.logT);
    }
    render();
  });

  canvas.onResize(() => {
    if (!loop.running) render();
  });

  syncControls();
  render();

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
      syncControls();
      render();
    },
  };
}

export const diffusionErfDemo: DemoDefinition = {
  id: 'diffusion-erf',
  title: 'Diffusion profile (erf solution)',
  description:
    'Concentration profile in a rod with a constant surface concentration: C(x,t) = Cs − (Cs − C0) erf(x / 2√(Dt)), with an Arrhenius diffusion coefficient on a log scale.',
  category: 'Diffusion',
  tags: ['diffusion', 'Fick', 'erf', 'Arrhenius', 'carburizing'],
  create,
};

export default diffusionErfDemo;
