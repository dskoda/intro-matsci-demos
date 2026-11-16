/**
 * Electron drift and scattering in a solid (Lecture 13: Electrical properties)
 *
 * Free electrons are pushed by an electric field and scatter off lattice vibrations,
 * substitutional impurities, vacancies and grain boundaries. The demo shows why every
 * kind of disorder lowers the drift velocity (and therefore the conductivity) without
 * introducing the Drude formulas: the readout simply shows the time between collisions,
 * the drift velocity and the resulting current.
 *
 * The physics is in electrons.ts.
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import { Plot2D } from '@core/canvas/Plot2D';
import {
  createSlider,
  createCheckbox,
  createButton,
  type Disposable,
  type SliderControl,
  type CheckboxControl,
} from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import {
  ElectronGas,
  NX,
  NY,
  W,
  H,
  GW,
  GH,
  MAX_N,
  MAX_GRAINS,
  MAX_TAGGED,
  R_SUB,
  R_VAC,
} from './electrons';

interface DemoParams {
  n: number;
  /** Field strength, arbitrary units 0..10. */
  field: number;
  /** Substitutional impurities, % of lattice sites. */
  imp: number;
  /** Vacancies, % of lattice sites. */
  vac: number;
  grains: number;
  reflectivity: number;
  temperature: number;
  trail: boolean;
  /** Number of electrons followed with a trail (1..3). */
  follow: number;
}

const defaultParams: DemoParams = {
  n: 300,
  field: 4,
  imp: 0,
  vac: 0,
  grains: 1,
  reflectivity: 0.6,
  temperature: 1,
  trail: true,
  follow: 3,
};

const ACCEL_PER_FIELD = 0.02;
const DT = 0.03;
const STEPS_PER_FRAME = 4;
const RATE_WINDOW = 4; // time units over which collision rates are averaged
const HISTORY_SPAN = 60;
const HISTORY_DT = 0.5;
const TRAIL_LEN = 500;

const KIND_COLOR = ['#dfe6ff', '#ff9f4a', '#c77dff'];
const KIND_LABEL = ['Lattice vibrations', 'Point defects', 'Grain boundaries'];
const COLOR_ELECTRON = '#4ac3ff';
const COLOR_TAGGED = ['#ffe14a', '#7CFF9F', '#ff7ad9'];

function parseParams(raw: Record<string, string>, base: DemoParams): DemoParams {
  const num = (key: string, fallback: number): number => {
    const v = parseFloat(raw[key] ?? '');
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    n: Math.round(clamp(num('n', base.n), 20, MAX_N)),
    field: clamp(num('e', base.field), 0, 10),
    imp: clamp(num('imp', base.imp), 0, 40),
    vac: clamp(num('vac', base.vac), 0, 40),
    grains: Math.round(clamp(num('grains', base.grains), 1, MAX_GRAINS)),
    reflectivity: clamp(num('refl', base.reflectivity), 0, 1),
    temperature: clamp(num('T', base.temperature), 0.25, 4),
    trail: raw.trail !== undefined ? raw.trail === 'true' : base.trail,
    follow: Math.round(clamp(num('follow', base.follow), 1, MAX_TAGGED)),
  };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  let params: DemoParams = parseParams(options.getParams(), defaultParams);

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0a0a0a', autoResize: true });
  const driftPlot = new Plot2D(canvas.ctx, {
    bounds: { xMin: 0, xMax: HISTORY_SPAN, yMin: 0, yMax: 1 },
    margins: { top: 22, right: 16, bottom: 38, left: 55 },
  });

  const gas = new ElectronGas();

  // ---- run state ----------------------------------------------------------------------
  let paused = false;
  let trails: number[][] = [[], [], []]; // per followed electron: x0, y0, x1, y1, ...
  let hist: { t: number[]; v: number[] } = { t: [], v: [] };
  let accV = 0;
  let accN = 0;
  let lastSample = 0;
  let rates = [0, 0, 0]; // collisions per electron per unit time
  let winStartCounts = [0, 0, 0];
  let winStartTime = 0;
  let vDrift = 0;
  let grainImage: HTMLCanvasElement | null = null;
  let grainImageKey = '';

  function applyParams(): void {
    gas.accel = params.field * ACCEL_PER_FIELD;
    gas.temperature = params.temperature;
    gas.reflectivity = params.reflectivity;
    gas.setDefects(params.imp / 100, params.vac / 100);
    gas.setGrains(params.grains);
    gas.setN(params.n);
    grainImage = null; // rebuilt lazily
  }

  function resetStats(): void {
    trails = [[], [], []];
    hist = { t: [], v: [] };
    accV = accN = 0;
    lastSample = 0;
    rates = [0, 0, 0];
    winStartCounts = [0, 0, 0];
    winStartTime = 0;
    vDrift = 0;
  }

  function restart(): void {
    gas.restart();
    resetStats();
  }

  // ---- controls -----------------------------------------------------------------------
  const disposables: Disposable[] = [];
  const sliders: Record<string, SliderControl> = {};
  let trailCheck: CheckboxControl | undefined;
  let pauseButton: ReturnType<typeof createButton> | undefined;

  function syncControls(): void {
    sliders.n?.setValue(params.n);
    sliders.e?.setValue(params.field);
    sliders.imp?.setValue(params.imp);
    sliders.vac?.setValue(params.vac);
    sliders.grains?.setValue(params.grains);
    sliders.refl?.setValue(params.reflectivity * 100);
    sliders.T?.setValue(params.temperature);
    sliders.follow?.setValue(params.follow);
    trailCheck?.setChecked(params.trail);
  }

  function currentUrlParams(): Record<string, string> {
    return {
      n: String(params.n),
      e: params.field.toFixed(1),
      imp: params.imp.toFixed(0),
      vac: params.vac.toFixed(0),
      grains: String(params.grains),
      refl: params.reflectivity.toFixed(2),
      T: params.temperature.toFixed(2),
      trail: String(params.trail),
      follow: String(params.follow),
    };
  }

  /** Called when a slider moves. Changes that alter the scattering restart the statistics. */
  function onChange(resetHistory: boolean): void {
    applyParams();
    if (resetHistory) {
      hist = { t: [], v: [] };
      winStartCounts = [...gas.counts];
      winStartTime = gas.time;
    }
    options.setParams(currentUrlParams());
  }

  function applyPreset(patch: Partial<DemoParams>): void {
    params = { ...params, ...patch };
    syncControls();
    applyParams();
    restart();
    options.setParams(currentUrlParams());
  }

  function addSlider(
    parent: HTMLElement,
    key: string,
    opts: {
      label: string;
      min: number;
      max: number;
      step: number;
      value: number;
      format: (v: number) => string;
      onChange: (v: number) => void;
    }
  ): void {
    const s = createSlider(opts);
    sliders[key] = s;
    disposables.push(s);
    parent.appendChild(s.element);
  }

  if (controlsPanel) {
    controlsPanel.appendChild(
      createHelperText(
        'Electrons (blue) are pushed by the electric field (pointing left, so negative charges drift right) and bounce off anything that disturbs the perfect lattice. Followed electrons (yellow, green, pink) leave a trail; rings mark where they scattered (white: vibrations, orange: defects, purple: boundaries). More scattering means shorter flights, a lower drift velocity and a lower current.'
      )
    );

    const presetSection = createSection({ title: 'Presets' });
    disposables.push(presetSection);
    const presets: Array<[string, Partial<DemoParams>, 'primary' | 'secondary']> = [
      ['Clean crystal', { imp: 0, vac: 0, grains: 1 }, 'primary'],
      ['Alloy: 30 % substitutions', { imp: 30, vac: 0, grains: 1 }, 'secondary'],
      ['Vacancy-rich: 25 % vacancies', { imp: 0, vac: 25, grains: 1 }, 'secondary'],
      ['Nanocrystalline: 50 grains', { imp: 0, vac: 0, grains: 50 }, 'secondary'],
    ];
    for (const [label, patch, variant] of presets) {
      const b = createButton({ label, variant, onClick: () => applyPreset(patch) });
      disposables.push(b);
      presetSection.content.appendChild(b.element);
    }
    controlsPanel.appendChild(presetSection.element);

    const driveSection = createSection({ title: 'Electrons and field' });
    disposables.push(driveSection);
    addSlider(driveSection.content, 'e', {
      label: 'Electric field E',
      min: 0,
      max: 10,
      step: 0.5,
      value: params.field,
      format: (v) => v.toFixed(1),
      onChange: (v) => {
        params.field = v;
        onChange(true);
      },
    });
    addSlider(driveSection.content, 'n', {
      label: 'Number of electrons N',
      min: 20,
      max: MAX_N,
      step: 20,
      value: params.n,
      format: (v) => v.toFixed(0),
      onChange: (v) => {
        params.n = Math.round(v);
        onChange(false);
      },
    });
    addSlider(driveSection.content, 'T', {
      label: 'Temperature (lattice vibrations)',
      min: 0.25,
      max: 4,
      step: 0.25,
      value: params.temperature,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        params.temperature = v;
        onChange(true);
      },
    });
    controlsPanel.appendChild(driveSection.element);

    const defectSection = createSection({ title: 'Point defects' });
    disposables.push(defectSection);
    addSlider(defectSection.content, 'imp', {
      label: 'Substitutional impurities',
      min: 0,
      max: 40,
      step: 1,
      value: params.imp,
      format: (v) => `${v.toFixed(0)} % of sites`,
      onChange: (v) => {
        params.imp = v;
        onChange(true);
      },
    });
    addSlider(defectSection.content, 'vac', {
      label: 'Vacancies',
      min: 0,
      max: 40,
      step: 1,
      value: params.vac,
      format: (v) => `${v.toFixed(0)} % of sites`,
      onChange: (v) => {
        params.vac = v;
        onChange(true);
      },
    });
    controlsPanel.appendChild(defectSection.element);

    const grainSection = createSection({ title: 'Grain boundaries' });
    disposables.push(grainSection);
    addSlider(grainSection.content, 'grains', {
      label: 'Number of grains (1 = single crystal)',
      min: 1,
      max: MAX_GRAINS,
      step: 1,
      value: params.grains,
      format: (v) => v.toFixed(0),
      onChange: (v) => {
        params.grains = Math.round(v);
        onChange(true);
      },
    });
    addSlider(grainSection.content, 'refl', {
      label: 'Boundary reflectivity',
      min: 0,
      max: 100,
      step: 5,
      value: params.reflectivity * 100,
      format: (v) => `${v.toFixed(0)} %`,
      onChange: (v) => {
        params.reflectivity = v / 100;
        onChange(true);
      },
    });
    controlsPanel.appendChild(grainSection.element);

    const displaySection = createSection({ title: 'Display' });
    disposables.push(displaySection);
    addSlider(displaySection.content, 'follow', {
      label: 'Electrons followed',
      min: 1,
      max: MAX_TAGGED,
      step: 1,
      value: params.follow,
      format: (v) => v.toFixed(0),
      onChange: (v) => {
        params.follow = Math.round(v);
        options.setParams(currentUrlParams());
      },
    });
    trailCheck = createCheckbox({
      label: 'Show trails and collision rings',
      checked: params.trail,
      onChange: (checked) => {
        params.trail = checked;
        options.setParams(currentUrlParams());
      },
    });
    disposables.push(trailCheck);
    displaySection.content.appendChild(trailCheck.element);

    pauseButton = createButton({
      label: 'Pause',
      variant: 'secondary',
      onClick: () => {
        paused = !paused;
        pauseButton?.setLabel(paused ? 'Resume' : 'Pause');
      },
    });
    disposables.push(pauseButton);
    displaySection.content.appendChild(pauseButton.element);

    const reshuffleBtn = createButton({
      label: 'New random defects and grains',
      variant: 'secondary',
      onClick: () => {
        gas.reshuffle();
        applyParams();
        restart();
      },
    });
    const restartBtn = createButton({
      label: 'Restart electrons',
      variant: 'secondary',
      onClick: () => restart(),
    });
    disposables.push(reshuffleBtn, restartBtn);
    displaySection.content.appendChild(reshuffleBtn.element);
    displaySection.content.appendChild(restartBtn.element);
    controlsPanel.appendChild(displaySection.element);
  }

  applyParams();
  gas.restart();

  // ---- stepping -----------------------------------------------------------------------
  function stepSimulation(): void {
    for (let s = 0; s < STEPS_PER_FRAME; s++) {
      gas.step(DT);
      accV += gas.meanVx();
      accN++;
      if (params.trail) {
        for (let k = 0; k < MAX_TAGGED; k++) {
          const tr = trails[k]!;
          tr.push(gas.x[k]!, gas.y[k]!);
          if (tr.length > TRAIL_LEN * 2) tr.splice(0, 2);
        }
      }
    }

    if (gas.time - lastSample >= HISTORY_DT && accN > 0) {
      vDrift = accV / accN;
      hist.t.push(gas.time);
      hist.v.push(vDrift);
      if (hist.t.length > HISTORY_SPAN / HISTORY_DT + 2) {
        hist.t.shift();
        hist.v.shift();
      }
      accV = accN = 0;
      lastSample = gas.time;
    }

    if (gas.time - winStartTime >= RATE_WINDOW) {
      const dtWin = gas.time - winStartTime;
      const fresh = [0, 1, 2].map((k) => (gas.counts[k]! - winStartCounts[k]!) / (gas.n * dtWin));
      const blend = rates[0]! + rates[1]! + rates[2]! > 0 ? 0.5 : 1;
      rates = rates.map((r, k) => r * (1 - blend) + fresh[k]! * blend);
      winStartCounts = [...gas.counts];
      winStartTime = gas.time;
    }
  }

  /** Smoothed drift velocity: mean of the recent history samples. */
  function smoothDrift(): number {
    const m = Math.min(hist.v.length, 20);
    if (m === 0) return 0;
    let s = 0;
    for (let i = hist.v.length - m; i < hist.v.length; i++) s += hist.v[i]!;
    return s / m;
  }

  // ---- rendering ----------------------------------------------------------------------
  function buildGrainImage(): HTMLCanvasElement | null {
    if (gas.grains <= 1) return null;
    const key = `${gas.grains}:${gas.seedX[0]}:${gas.seedY[0]}`;
    if (grainImage && grainImageKey === key) return grainImage;
    const c = document.createElement('canvas');
    c.width = GW;
    c.height = GH;
    const g = c.getContext('2d')!;
    const img = g.createImageData(GW, GH);
    const tints: Array<[number, number, number]> = [];
    for (let k = 0; k < gas.grains; k++) tints.push(hslToRgb((k * 0.381966) % 1, 0.5, 0.5));
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const lab = gas.grainMap[j * GW + i]!;
        const right = gas.grainMap[j * GW + ((i + 1) % GW)]!;
        const down = gas.grainMap[((j + 1) % GH) * GW + i]!;
        const o = (j * GW + i) * 4;
        if (lab !== right || lab !== down) {
          img.data[o] = 220;
          img.data[o + 1] = 170;
          img.data[o + 2] = 255;
          img.data[o + 3] = 230;
        } else {
          const t = tints[lab]!;
          img.data[o] = t[0];
          img.data[o + 1] = t[1];
          img.data[o + 2] = t[2];
          img.data[o + 3] = 38;
        }
      }
    }
    g.putImageData(img, 0, 0);
    grainImage = c;
    grainImageKey = key;
    return c;
  }

  function render(): void {
    const width = canvas.width;
    const height = canvas.height;
    const ctx = canvas.ctx;
    const headerH = 40;
    const stageH = Math.max(200, height * 0.64);

    canvas.clear();

    const s = Math.max(4, Math.min((width - 16) / NX, (stageH - headerH - 6) / NY));
    const ox = (width - s * NX) / 2;
    const oy = headerH;

    renderHeader(width);
    renderStage(ctx, s, ox, oy);

    const plotsTop = Math.max(oy + s * NY + 4, stageH);
    const plotsH = height - plotsTop;
    if (plotsH > 90) {
      ctx.save();
      ctx.translate(0, plotsTop);
      renderDriftPlot(width * 0.55, plotsH);
      ctx.translate(width * 0.55, 0);
      renderRates(width * 0.45, plotsH);
      ctx.restore();
    }
  }

  function renderHeader(width: number): void {
    const ctx = canvas.ctx;
    const total = rates[0]! + rates[1]! + rates[2]!;
    const tau = total > 0 ? 1 / total : NaN;
    const v = smoothDrift();
    const nDensity = gas.n / (W * H);
    const J = nDensity * v;
    const lines = [
      `t = ${gas.time.toFixed(0)}${paused ? '  (paused)' : ''}    time between collisions = ${
        Number.isFinite(tau) ? tau.toFixed(1) : '…'
      }`,
      `drift velocity = ${v.toFixed(2)}    current density J ∝ N × drift = ${J.toFixed(3)}${
        params.field > 0 ? `    conductivity σ = J / E = ${(J / params.field).toFixed(4)}` : ''
      }`,
    ];
    ctx.save();
    ctx.fillStyle = '#ddd';
    ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, 10, 6 + i * 17));

    // field arrow (points left)
    if (params.field > 0) {
      const len = 14 + params.field * 6;
      const ax = width - 14;
      const ay = 14;
      ctx.strokeStyle = '#ff6b6b';
      ctx.fillStyle = '#ff6b6b';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - len, ay);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ax - len - 8, ay);
      ctx.lineTo(ax - len, ay - 5);
      ctx.lineTo(ax - len, ay + 5);
      ctx.closePath();
      ctx.fill();
      ctx.textAlign = 'right';
      ctx.fillText('E', ax - len - 14, ay - 6);
    }
    ctx.restore();
  }

  function renderStage(ctx: CanvasRenderingContext2D, s: number, ox: number, oy: number): void {
    ctx.save();
    ctx.fillStyle = '#10131a';
    ctx.fillRect(ox, oy, s * NX, s * NY);

    const gi = buildGrainImage();
    if (gi) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(gi, ox, oy, s * NX, s * NY);
    }

    // host atoms
    ctx.fillStyle = '#2d3445';
    ctx.beginPath();
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        if (gas.siteType[j * NX + i] !== 0) continue;
        const cx = ox + (i + 0.5) * s;
        const cy = oy + (j + 0.5) * s;
        ctx.moveTo(cx + s * 0.16, cy);
        ctx.arc(cx, cy, s * 0.16, 0, Math.PI * 2);
      }
    }
    ctx.fill();

    // substitutions (filled) and vacancies (dashed outline)
    ctx.fillStyle = 'rgba(255, 159, 74, 0.85)';
    ctx.beginPath();
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        if (gas.siteType[j * NX + i] !== 1) continue;
        const cx = ox + (i + 0.5) * s;
        const cy = oy + (j + 0.5) * s;
        ctx.moveTo(cx + R_SUB * s, cy);
        ctx.arc(cx, cy, R_SUB * s, 0, Math.PI * 2);
      }
    }
    ctx.fill();
    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        if (gas.siteType[j * NX + i] !== 2) continue;
        const cx = ox + (i + 0.5) * s;
        const cy = oy + (j + 0.5) * s;
        ctx.moveTo(cx + R_VAC * s, cy);
        ctx.arc(cx, cy, R_VAC * s, 0, Math.PI * 2);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // electrons
    const r = Math.max(1.6, s * 0.1);
    ctx.fillStyle = COLOR_ELECTRON;
    ctx.beginPath();
    for (let i = Math.min(params.follow, gas.n); i < gas.n; i++) {
      const px = ox + gas.x[i]! * s;
      const py = oy + gas.y[i]! * s;
      ctx.moveTo(px + r, py);
      ctx.arc(px, py, r, 0, Math.PI * 2);
    }
    ctx.fill();

    if (params.trail) renderTrail(ctx, s, ox, oy);
    for (let k = 0; k < Math.min(params.follow, gas.n); k++) {
      ctx.fillStyle = COLOR_TAGGED[k]!;
      ctx.beginPath();
      ctx.arc(ox + gas.x[k]! * s, oy + gas.y[k]! * s, Math.max(3.5, s * 0.16), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox, oy, s * NX, s * NY);
    ctx.restore();
  }

  function renderTrail(ctx: CanvasRenderingContext2D, s: number, ox: number, oy: number): void {
    const span = TRAIL_LEN * DT;
    for (let k = 0; k < Math.min(params.follow, gas.n); k++) {
      const trail = trails[k]!;
      ctx.strokeStyle = COLOR_TAGGED[k]!;
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let j = 2; j < trail.length; j += 2) {
        const x0 = trail[j - 2]!;
        const y0 = trail[j - 1]!;
        const x1 = trail[j]!;
        const y1 = trail[j + 1]!;
        if (Math.abs(x1 - x0) > W / 2 || Math.abs(y1 - y0) > H / 2) continue; // periodic wrap
        ctx.moveTo(ox + x0 * s, oy + y0 * s);
        ctx.lineTo(ox + x1 * s, oy + y1 * s);
      }
      ctx.stroke();
    }

    for (const ev of gas.events) {
      if (ev.id >= params.follow) continue;
      const age = gas.time - ev.t;
      if (age > span) continue;
      ctx.strokeStyle = KIND_COLOR[ev.kind]!;
      ctx.globalAlpha = clamp(1 - age / span, 0.25, 1);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ox + ev.x * s, oy + ev.y * s, 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function renderDriftPlot(width: number, height: number): void {
    const t = gas.time;
    let lo = 0;
    let hi = 0.5;
    for (const v of hist.v) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    hi *= 1.15;
    lo *= 1.15;
    const xMin = Math.max(0, t - HISTORY_SPAN);
    driftPlot.setBounds({ xMin, xMax: xMin + HISTORY_SPAN, yMin: lo, yMax: hi });
    driftPlot.setSize(width, height);
    const xTicks = Plot2D.generateTicks(xMin, xMin + HISTORY_SPAN, 5);
    const yTicks = Plot2D.generateTicks(lo, hi, 4);
    driftPlot.drawGrid(xTicks, yTicks);
    driftPlot.drawAxes('time', 'drift velocity');
    driftPlot.drawTickLabels(
      xTicks,
      yTicks,
      (v) => v.toFixed(0),
      (v) => v.toFixed(1)
    );
    if (hist.t.length > 1) driftPlot.drawLine(hist.t, hist.v, '#7CFF9F', 2);
  }

  function renderRates(width: number, height: number): void {
    const ctx = canvas.ctx;
    const left = 16;
    const right = width - 16;
    const top = 22;
    const rowH = Math.min(34, (height - top - 44) / 3);
    const scale = Math.max(0.2, Math.max(...rates) * 1.2);
    const barMax = right - left;

    ctx.save();
    ctx.fillStyle = '#aaa';
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('Collisions per electron per unit time', left, 2);
    for (let k = 0; k < 3; k++) {
      const y = top + k * rowH;
      ctx.fillStyle = '#bbb';
      ctx.fillText(KIND_LABEL[k]!, left, y);
      ctx.fillStyle = KIND_COLOR[k]!;
      ctx.fillRect(left, y + 15, (rates[k]! / scale) * barMax, Math.max(6, rowH - 22));
      ctx.fillStyle = '#ddd';
      ctx.textAlign = 'right';
      ctx.fillText(rates[k]!.toFixed(3), right, y);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  const loop = new AnimationLoop(() => {
    if (!paused) stepSimulation();
    render();
  });

  function handleResize(): void {
    if (loop.running) render();
  }
  canvas.onResize(handleResize);

  return {
    start() {
      loop.start();
    },
    stop() {
      loop.stop();
    },
    resize() {
      handleResize();
    },
    dispose() {
      loop.dispose();
      disposables.forEach((d) => d.dispose());
      canvas.dispose();
    },
    getParams() {
      return currentUrlParams();
    },
    setParams(newParams: Record<string, string>) {
      params = parseParams(newParams, params);
      syncControls();
      applyParams();
      restart();
    },
  };
}

export const electronScatteringDemo: DemoDefinition = {
  id: 'electron-scattering',
  title: 'Electron drift and scattering (impurities, vacancies, grain boundaries)',
  description:
    'Free electrons accelerate in an electric field and scatter off lattice vibrations, impurity atoms, vacancies and grain boundaries. See why every kind of disorder shortens the flights between collisions, lowers the drift velocity and reduces the current.',
  category: 'Electrical properties',
  tags: [
    'electrical conductivity',
    'resistivity',
    'scattering',
    'drift',
    'impurities',
    'grain boundaries',
    'vacancies',
  ],
  create,
};

export default electronScatteringDemo;
