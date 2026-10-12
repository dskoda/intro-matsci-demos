/**
 * Recrystallization and grain growth (Lecture 5: Strength).
 *
 * 2D multi-order-parameter phase-field model. Stage 1: annealed grains of
 * different sizes. Stage 2: cold rolling flattens the grains and stores defect
 * energy that varies between and inside grains. Stage 3: choose an annealing
 * profile. Stage 4: new, defect-free grains nucleate at high-energy sites and
 * consume the deformed grains (recrystallization), then coarsen (grain growth).
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import { Plot2D } from '@core/canvas/Plot2D';
import { createSlider, createSelect, createButton, type Disposable } from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import {
  N,
  Q,
  Q_OLD,
  S_MAX,
  Structure,
  PhaseField,
  buildStoredEnergy,
  countComponents,
  relativeStrength,
} from './phaseField';

interface DemoParams {
  grains: number;
  dispersion: number;
  eps: number;
  het: number;
  profile: 'iso' | 'ramp' | 'two';
  temp: number;
  hold: number;
  rate: number;
  temp1: number;
  time1: number;
  view: 'grains' | 'energy' | 'both';
  speed: number;
  seed: number;
}

const defaultParams: DemoParams = {
  grains: 40,
  dispersion: 0.6,
  eps: 0.5,
  het: 0.6,
  profile: 'iso',
  temp: 800,
  hold: 600,
  rate: 4,
  temp1: 600,
  time1: 600,
  view: 'grains',
  speed: 8,
  seed: 1,
};

const T_START = 300;
const E_SCALE = 0.45; // stored energy mapped to full colour
const ROLL_FRAMES = 80;

type Stage = 'annealed' | 'rolling' | 'deformed' | 'annealing' | 'done';

function num(v: string | undefined, lo: number, hi: number, fb: number): number {
  const x = parseFloat(v ?? '');
  return clamp(Number.isFinite(x) ? x : fb, lo, hi);
}

function parseParams(src: Record<string, string>, p: DemoParams): void {
  if (src.grains !== undefined) p.grains = Math.round(num(src.grains, 15, 90, defaultParams.grains));
  if (src.dispersion !== undefined) p.dispersion = num(src.dispersion, 0, 1, defaultParams.dispersion);
  if (src.eps !== undefined) p.eps = num(src.eps, 0, 0.6, defaultParams.eps);
  if (src.het !== undefined) p.het = num(src.het, 0, 1, defaultParams.het);
  if (src.profile === 'iso' || src.profile === 'ramp' || src.profile === 'two') p.profile = src.profile;
  if (src.temp !== undefined) p.temp = Math.round(num(src.temp, 600, 900, defaultParams.temp));
  if (src.hold !== undefined) p.hold = Math.round(num(src.hold, 50, 3000, defaultParams.hold));
  if (src.rate !== undefined) p.rate = num(src.rate, 1, 30, defaultParams.rate);
  if (src.temp1 !== undefined) p.temp1 = Math.round(num(src.temp1, 450, 750, defaultParams.temp1));
  if (src.time1 !== undefined) p.time1 = Math.round(num(src.time1, 50, 3000, defaultParams.time1));
  if (src.view === 'grains' || src.view === 'energy' || src.view === 'both') p.view = src.view;
  if (src.speed !== undefined) p.speed = Math.round(num(src.speed, 1, 40, defaultParams.speed));
  if (src.seed !== undefined) p.seed = Math.round(num(src.seed, 1, 9999, defaultParams.seed));
}

function toRecord(p: DemoParams): Record<string, string> {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]));
}

/** Annealing temperature at time t, and total duration, for the chosen profile. */
function profileT(p: DemoParams, t: number): number {
  if (p.profile === 'iso') return p.temp;
  if (p.profile === 'ramp') return Math.min(p.temp, T_START + p.rate * t);
  return t < p.time1 ? p.temp1 : p.temp;
}

function profileDuration(p: DemoParams): number {
  if (p.profile === 'iso') return p.hold;
  if (p.profile === 'ramp') return (p.temp - T_START) / p.rate + p.hold;
  return p.time1 + p.hold;
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

// Old grains: muted cool colours. New grains: vivid warm colours.
const PALETTE: [number, number, number][] = [];
for (let k = 0; k < Q_OLD; k++) PALETTE.push(hsl(190 + ((k * 37) % 100), 0.28, 0.36 + 0.035 * ((k * 3) % 7)));
const NEW_HUES = [8, 28, 48, 330, 18, 66, 350, 38];
for (let k = 0; k < Q - Q_OLD; k++) PALETTE.push(hsl(NEW_HUES[k]!, 0.92, 0.56));

function heat(v: number): [number, number, number] {
  const t = clamp(v, 0, 1);
  if (t < 0.5) {
    const u = t / 0.5;
    return [Math.round(30 + 190 * u), Math.round(10 + 20 * u), Math.round(60 + 60 * u * (1 - u) * 4 + 40 * (1 - u))];
  }
  const u = (t - 0.5) / 0.5;
  return [255, Math.round(30 + 200 * u), Math.round(60 * (1 - u))];
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  const params: DemoParams = { ...defaultParams };
  parseParams(options.getParams(), params);

  let structure = new Structure({ grains: params.grains, dispersion: params.dispersion, seed: params.seed });
  let sizeRef = 1;
  let stage: Stage = 'annealed';
  let rollFrame = 0;
  let labels: Int32Array = new Int32Array(N * N);
  let energy: Float32Array = new Float32Array(N * N);
  let pf: PhaseField | null = null;
  let paused = true;
  let frame = 0;
  let strengthRolled = 1;
  let lastStats = { X: 0, size: 1, energy: 0, grains: 0 };

  // History for the plots
  const hT: number[] = [];
  const hX: number[] = [];
  const hS: number[] = [];
  const hH: number[] = [];
  const hTime: number[] = [];

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0b0e14', autoResize: true });
  const margins = { top: 22, right: 12, bottom: 28, left: 46 };
  const plots = [0, 1, 2, 3].map(
    () => new Plot2D(canvas.ctx, { bounds: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 }, margins })
  );

  const img = document.createElement('canvas');
  img.width = N;
  img.height = N;
  const imgCtx = img.getContext('2d')!;
  const imgData = imgCtx.createImageData(N, N);
  const domBuf = new Uint8Array(N * N);
  const eBuf = new Float32Array(N * N);

  const disposables: Disposable[] = [];
  const sliders: Record<string, ReturnType<typeof createSlider>> = {};
  const selects: Record<string, ReturnType<typeof createSelect>> = {};
  let startBtn: ReturnType<typeof createButton> | null = null;
  const profileOnly: Record<string, HTMLElement[]> = { ramp: [], two: [] };

  function updateUrl() {
    options.setParams(toRecord(params));
  }

  function referenceSize(): number {
    const dom = new Uint8Array(N * N);
    const lab = structure.labels(1);
    for (let c = 0; c < N * N; c++) dom[c] = structure.color[lab[c]!]!;
    // Components of equal colour can merge only if same-colour grains touch (colouring forbids that)
    return N / Math.sqrt(Math.max(1, countComponents(dom)));
  }

  function resetAll() {
    structure = new Structure({ grains: params.grains, dispersion: params.dispersion, seed: params.seed });
    sizeRef = referenceSize();
    labels = structure.labels(1);
    energy = new Float32Array(N * N);
    pf = null;
    stage = 'annealed';
    paused = true;
    clearHistory();
    startBtn?.setLabel('Start anneal');
  }

  function clearHistory() {
    hT.length = hX.length = hS.length = hH.length = hTime.length = 0;
  }

  function startRolling() {
    pf = null;
    clearHistory();
    paused = true;
    startBtn?.setLabel('Start anneal');
    if (params.eps <= 0) {
      labels = structure.labels(1);
      energy = new Float32Array(N * N);
      finishRolling();
      return;
    }
    stage = 'rolling';
    rollFrame = 0;
  }

  function sRolled(progress: number): number {
    const eps = params.eps * progress;
    return clamp(1 / (1 - eps), 1, S_MAX);
  }

  function finishRolling() {
    stage = 'deformed';
    const dom = new Uint8Array(N * N);
    for (let c = 0; c < N * N; c++) dom[c] = structure.color[labels[c]!]!;
    const size = N / Math.sqrt(Math.max(1, countComponents(dom)));
    let e = 0;
    for (let c = 0; c < N * N; c++) e += energy[c]!;
    strengthRolled = relativeStrength(e / (N * N), size, sizeRef);
  }

  function startAnneal() {
    if (stage === 'annealed') startRolling();
    if (stage === 'rolling') return;
    if (stage === 'deformed' || stage === 'done') {
      pf = new PhaseField(labels, structure.color, energy, params.seed);
      stage = 'annealing';
      clearHistory();
      record();
    }
    paused = false;
    startBtn?.setLabel('Pause');
  }

  function backToRolled() {
    if (stage === 'annealing' || stage === 'done') {
      pf = null;
      stage = 'deformed';
      clearHistory();
      paused = true;
      startBtn?.setLabel('Start anneal');
    }
  }

  function record() {
    if (!pf) return;
    lastStats = pf.stats();
    hTime.push(pf.time);
    hT.push(profileT(params, pf.time));
    hX.push(lastStats.X);
    hS.push(lastStats.size);
    hH.push(relativeStrength(lastStats.energy, lastStats.size, sizeRef));
    if (hTime.length > 3000) {
      for (const h of [hTime, hT, hX, hS, hH]) h.shift();
    }
  }

  function syncControls() {
    sliders.grains?.setValue(params.grains);
    sliders.dispersion?.setValue(params.dispersion);
    sliders.eps?.setValue(params.eps);
    sliders.het?.setValue(params.het);
    sliders.temp?.setValue(params.temp);
    sliders.hold?.setValue(params.hold);
    sliders.rate?.setValue(params.rate);
    sliders.temp1?.setValue(params.temp1);
    sliders.time1?.setValue(params.time1);
    sliders.speed?.setValue(params.speed);
    selects.profile?.setValue(params.profile);
    selects.view?.setValue(params.view);
    updateVisibility();
  }

  function updateVisibility() {
    for (const el of profileOnly.ramp!) el.style.display = params.profile === 'ramp' ? '' : 'none';
    for (const el of profileOnly.two!) el.style.display = params.profile === 'two' ? '' : 'none';
  }

  if (controlsPanel) {
    const info = createSection({ title: 'Recrystallization' });
    disposables.push(info);
    info.content.appendChild(
      createHelperText(
        'Cold work stores defects in the grains. On annealing, new defect-free grains nucleate where the stored energy is high and sweep through the deformed ones; afterwards the grains coarsen.'
      )
    );
    controlsPanel.appendChild(info.element);

    const addSlider = (
      section: { content: HTMLElement },
      key: keyof DemoParams,
      label: string,
      min: number,
      max: number,
      step: number,
      format: (v: number) => string,
      onChange: () => void
    ) => {
      const s = createSlider({
        label,
        min,
        max,
        step,
        value: params[key] as number,
        format,
        onChange: (v) => {
          (params[key] as number) = v;
          updateUrl();
          onChange();
        },
      });
      sliders[key] = s;
      disposables.push(s);
      section.content.appendChild(s.element);
      return s;
    };

    // Stage 1
    const s1 = createSection({ title: '1 · Annealed grains' });
    disposables.push(s1);
    addSlider(s1, 'grains', 'Number of grains', 15, 90, 1, (v) => v.toFixed(0), resetAll);
    addSlider(s1, 'dispersion', 'Grain-size spread', 0, 1, 0.05, (v) => v.toFixed(2), resetAll);
    const newMicro = createButton({
      label: 'New microstructure',
      variant: 'secondary',
      onClick: () => {
        params.seed = 1 + Math.floor(Math.random() * 9999);
        updateUrl();
        resetAll();
      },
    });
    disposables.push(newMicro);
    s1.content.appendChild(newMicro.element);
    controlsPanel.appendChild(s1.element);

    // Stage 2
    const s2 = createSection({ title: '2 · Cold work' });
    disposables.push(s2);
    addSlider(s2, 'eps', 'Reduction by rolling', 0, 0.6, 0.01, (v) => (v * 100).toFixed(0) + ' %', resetAll);
    addSlider(s2, 'het', 'Heterogeneity of stored energy', 0, 1, 0.05, (v) => v.toFixed(2), resetAll);
    const roll = createButton({ label: 'Roll the sample', onClick: startRolling });
    disposables.push(roll);
    s2.content.appendChild(roll.element);
    controlsPanel.appendChild(s2.element);

    // Stage 3
    const s3 = createSection({ title: '3 · Annealing profile' });
    disposables.push(s3);
    selects.profile = createSelect({
      label: 'Profile',
      options: [
        { value: 'iso', label: 'Isothermal hold' },
        { value: 'ramp', label: 'Ramp, then hold' },
        { value: 'two', label: 'Two-step (low T, then high T)' },
      ],
      value: params.profile,
      onChange: (v) => {
        params.profile = v as DemoParams['profile'];
        updateVisibility();
        updateUrl();
      },
    });
    disposables.push(selects.profile);
    s3.content.appendChild(selects.profile.element);
    const noop = () => {};
    const t1 = addSlider(s3, 'temp1', 'Step-1 temperature', 450, 750, 10, (v) => v.toFixed(0) + ' K', noop);
    const d1 = addSlider(s3, 'time1', 'Step-1 duration', 50, 3000, 50, (v) => v.toFixed(0), noop);
    addSlider(s3, 'temp', 'Annealing temperature', 600, 900, 10, (v) => v.toFixed(0) + ' K', noop);
    const rt = addSlider(s3, 'rate', 'Heating rate', 1, 30, 1, (v) => v.toFixed(0) + ' K/unit', noop);
    addSlider(s3, 'hold', 'Hold time', 50, 3000, 50, (v) => v.toFixed(0), noop);
    profileOnly.two!.push(t1.element, d1.element);
    profileOnly.ramp!.push(rt.element);
    updateVisibility();

    startBtn = createButton({
      label: 'Start anneal',
      onClick: () => {
        if (stage === 'annealing') {
          paused = !paused;
          startBtn?.setLabel(paused ? 'Resume' : 'Pause');
        } else {
          startAnneal();
        }
      },
    });
    const back = createButton({ label: 'Back to rolled state', variant: 'secondary', onClick: backToRolled });
    for (const b of [startBtn, back]) {
      disposables.push(b);
      s3.content.appendChild(b.element);
    }
    controlsPanel.appendChild(s3.element);

    // Display
    const disp = createSection({ title: 'Display' });
    disposables.push(disp);
    selects.view = createSelect({
      label: 'View',
      options: [
        { value: 'grains', label: 'Grains' },
        { value: 'energy', label: 'Stored energy' },
        { value: 'both', label: 'Grains + stored energy' },
      ],
      value: params.view,
      onChange: (v) => {
        params.view = v as DemoParams['view'];
        updateUrl();
      },
    });
    disposables.push(selects.view);
    disp.content.appendChild(selects.view.element);
    addSlider(disp, 'speed', 'Simulation speed', 1, 40, 1, (v) => v.toFixed(0) + '×', noop);
    controlsPanel.appendChild(disp.element);
  }

  resetAll();

  const loop = new AnimationLoop(() => {
    advance();
    render();
  });

  function advance() {
    frame++;
    if (stage === 'rolling') {
      rollFrame++;
      const prog = rollFrame / ROLL_FRAMES;
      const ease = prog * prog * (3 - 2 * prog);
      labels = structure.labels(sRolled(ease));
      energy = buildStoredEnergy(structure, labels, Math.max(1e-4, params.eps * ease), params.het);
      for (let c = 0; c < N * N; c++) energy[c] = energy[c]! * ease;
      if (rollFrame >= ROLL_FRAMES) {
        labels = structure.labels(sRolled(1));
        energy = buildStoredEnergy(structure, labels, params.eps, params.het);
        finishRolling();
      }
      return;
    }
    if (stage !== 'annealing' || paused || !pf) return;
    const D = profileDuration(params);
    const t0 = performance.now();
    for (let n = 0; n < params.speed && performance.now() - t0 < 24; n++) {
      pf.step(profileT(params, pf.time));
      if (pf.time >= D) {
        stage = 'done';
        startBtn?.setLabel('Start anneal');
        paused = true;
        break;
      }
    }
    if (frame % 3 === 0 || stage === 'done') record();
  }

  function renderMicrostructure(ctx: CanvasRenderingContext2D, x: number, y: number, side: number) {
    const data = imgData.data;
    const showGrains = params.view !== 'energy';
    const showEnergy = params.view !== 'grains';
    let eMap = energy;
    if (pf) eMap = pf.energyMap(eBuf);
    if (pf) pf.dominant(domBuf);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = j * N + i;
        let r = 20;
        let g = 24;
        let b = 32;
        if (showGrains) {
          let col: [number, number, number];
          let shade = 1;
          if (pf) {
            col = PALETTE[domBuf[c]!]!;
            shade = clamp(0.3 + ((pf.sumSquares(c) - 0.45) / 0.5) * 0.7, 0.3, 1);
          } else {
            const lab = labels[c]!;
            col = PALETTE[structure.color[lab]!]!;
            const edge =
              (i + 1 < N && labels[c + 1] !== lab) || (j + 1 < N && labels[c + N] !== lab) ? 0.5 : 1;
            shade = edge;
          }
          r = col[0] * shade;
          g = col[1] * shade;
          b = col[2] * shade;
        }
        if (showEnergy) {
          const e = clamp(eMap[c]! / E_SCALE, 0, 1);
          const h = heat(e);
          const a = showGrains ? 0.7 * Math.sqrt(e) : 1;
          r = r * (1 - a) + h[0] * a;
          g = g * (1 - a) + h[1] * a;
          b = b * (1 - a) + h[2] * a;
        }
        const o = c * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
    imgCtx.putImageData(imgData, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, x, y, side, side);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, side, side);
  }

  function caption(): string {
    switch (stage) {
      case 'annealed':
        return '1 · Annealed polycrystal: grains of different sizes, almost no stored defects';
      case 'rolling':
        return '2 · Rolling flattens the grains and stores defect (dislocation) energy';
      case 'deformed':
        return 'Cold-worked: stored energy differs between grains and near boundaries. Choose an anneal.';
      default: {
        if (!pf) return '';
        const X = lastStats.X;
        if (X < 0.01 && pf.rec < 0.4) return 'Recovery has removed much of the stored energy: little driving force is left';
        if (X < 0.01) return 'Heating: defects recover slowly, nuclei form at high-energy sites';
        if (X < 0.97) return `Recrystallization: new grains consume deformed grains (X = ${(X * 100).toFixed(0)} %)`;
        return 'Fully recrystallized: grain growth, large grains eat small ones';
      }
    }
  }

  function render() {
    const W = canvas.width;
    const H = canvas.height;
    const ctx = canvas.ctx;
    canvas.clear();
    const wide = W >= H * 1.25;
    const capH = 56;
    const side = wide ? Math.min(W * 0.52, H - capH - 20) : Math.min(W - 20, H * 0.5 - capH);
    const mx = wide ? 12 : (W - side) / 2;
    const my = 10;
    renderMicrostructure(ctx, mx, my, side);

    // Legend and caption
    const ly = my + side + 18;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    let lx = mx;
    const swatch = (col: [number, number, number], text: string) => {
      ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
      ctx.fillRect(lx, ly - 9, 12, 12);
      ctx.fillStyle = '#ccc';
      ctx.fillText(text, lx + 17, ly + 1);
      lx += 28 + text.length * 6.3;
    };
    swatch(PALETTE[2]!, 'deformed / original grains');
    swatch(PALETTE[Q_OLD + 1]!, 'new recrystallised grains');
    if (params.view !== 'grains') {
      const grad = ctx.createLinearGradient(lx, 0, lx + 70, 0);
      for (let k = 0; k <= 4; k++) {
        const h = heat(k / 4);
        grad.addColorStop(k / 4, `rgb(${h[0]},${h[1]},${h[2]})`);
      }
      ctx.fillStyle = grad;
      ctx.fillRect(lx, ly - 9, 70, 12);
      ctx.fillStyle = '#ccc';
      ctx.fillText('stored energy', lx + 76, ly + 1);
    }
    ctx.fillStyle = '#e6e9ef';
    ctx.font = '14px sans-serif';
    ctx.fillText(caption(), mx, ly + 24, wide ? W * 0.55 : W - 20);
    if (pf) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(
        `t = ${pf.time.toFixed(0)}   T = ${profileT(params, pf.time).toFixed(0)} K   X = ${(lastStats.X * 100).toFixed(0)} %`,
        mx + side,
        my + 16
      );
    }

    // Plot panels
    const px = wide ? mx + side + 10 : 8;
    const pw = wide ? W - px - 8 : W - 16;
    const py = wide ? 6 : my + side + capH + 6;
    const ph = wide ? H - 12 : H - py - 6;
    const cols = wide ? 1 : 2;
    const rows = wide ? 4 : 2;
    const cw = pw / cols;
    const ch = ph / rows;
    const D = profileDuration(params);
    const tmax = Math.max(D, 1);

    const panel = (
      k: number,
      title: string,
      yMin: number,
      yMax: number,
      xs: number[],
      ys: number[],
      color: string,
      extra?: (plot: Plot2D) => void
    ) => {
      const col = wide ? 0 : k % 2;
      const row = wide ? k : Math.floor(k / 2);
      ctx.save();
      ctx.translate(px + col * cw, py + row * ch);
      const plot = plots[k]!;
      plot.setSize(cw - 4, ch - 2);
      plot.setBounds({ xMin: 0, xMax: tmax, yMin, yMax });
      const xt = Plot2D.generateTicks(0, tmax, 4);
      const yt = Plot2D.generateTicks(yMin, yMax, 3);
      plot.drawGrid(xt, yt);
      plot.drawAxes(k === 3 || !wide ? 'annealing time' : undefined, undefined);
      plot.drawTickLabels(xt, yt, (v) => v.toFixed(0), (v) => (Math.abs(v) < 10 ? v.toFixed(1) : v.toFixed(0)));
      extra?.(plot);
      plot.drawLine(xs, ys, color, 2);
      if (xs.length) plot.drawPoint(xs[xs.length - 1]!, ys[ys.length - 1]!, 4, color);
      ctx.fillStyle = '#ddd';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(title, margins.left, 14);
      ctx.restore();
    };

    // Planned temperature profile
    const planX: number[] = [];
    const planY: number[] = [];
    for (let k = 0; k <= 160; k++) {
      const t = (k / 160) * tmax;
      planX.push(t);
      planY.push(profileT(params, t));
    }
    panel(0, 'Temperature (K)', 250, 950, hTime, hT, '#ff6b6b', (plot) => plot.drawLine(planX, planY, 'rgba(255,255,255,0.35)', 1.5));
    panel(1, 'Recrystallised fraction X', 0, 1, hTime, hX, '#fb923c');
    const sMax = Math.max(40, ...hS, sizeRef * 1.5);
    panel(2, 'Mean grain size (cells)', 0, Math.ceil(sMax / 10) * 10, hTime, hS, '#4ade80', (plot) => {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(plot.toCanvasX(0), plot.toCanvasY(sizeRef));
      ctx.lineTo(plot.toCanvasX(tmax), plot.toCanvasY(sizeRef));
      ctx.stroke();
      ctx.restore();
    });
    panel(3, 'Relative strength', 0, 2.5, hTime, hH, '#a78bfa', (plot) => {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      for (const [v, c] of [
        [1, 'rgba(255,255,255,0.35)'],
        [strengthRolled, 'rgba(251,191,36,0.6)'],
      ] as const) {
        ctx.strokeStyle = c;
        ctx.beginPath();
        ctx.moveTo(plot.toCanvasX(0), plot.toCanvasY(v));
        ctx.lineTo(plot.toCanvasX(tmax), plot.toCanvasY(v));
        ctx.stroke();
      }
      ctx.restore();
    });
  }

  function handleResize() {
    render();
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
      return toRecord(params);
    },
    setParams(p: Record<string, string>) {
      parseParams(p, params);
      syncControls();
      resetAll();
    },
  };
}

export const recrystallizationDemo: DemoDefinition = {
  id: 'recrystallization',
  title: 'Recrystallization and grain growth',
  description:
    'Phase-field simulation: cold work stores defect energy in heterogeneous grains; annealing nucleates new defect-free grains that consume the old ones, followed by grain growth.',
  category: 'Mechanical',
  tags: ['recrystallization', 'grain growth', 'phase field', 'annealing', 'cold work'],
  create,
};

export default recrystallizationDemo;
