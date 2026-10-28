/**
 * S-curves of phase transformations (Lecture 10).
 *
 * Left: temperature axis. Click or drag to choose T; the more stable phase (parent α above Tm,
 * product β below) is highlighted and the undercooling ΔT = Tm − T is marked.
 * Top right: transformed fraction X versus log₁₀ t at that temperature, built by running the
 * simulation clock forward. Earlier runs stay as faded curves, so different temperatures
 * (different undercoolings) can be compared.
 * Bottom right: the microstructure at the current X, from nuclei that grow and impinge.
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import { Plot2D } from '@core/canvas/Plot2D';
import { createSlider, createSelect, createButton, type Disposable } from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import {
  GRID,
  LOGT_MAX,
  LOGT_MIN,
  TM_K,
  T_MAX_K,
  T_MIN_K,
  avramiN,
  buildMicro,
  defaultKinetics,
  grainLength,
  viewSide,
  fractionAt,
  noseTemperature,
  pictureTime,
  rates,
  t50,
  type KineticParams,
  type Mechanism,
  type MicroMap,
} from './sCurve';

interface DemoParams {
  /** Temperature (K) */
  T: number;
  /** Nucleation barrier strength */
  a: number;
  /** Diffusion barrier */
  q: number;
  mech: Mechanism;
  /** Clock speed in decades of time per second */
  speed: number;
}

const defaultParams: DemoParams = {
  T: 700,
  a: defaultKinetics.a,
  q: defaultKinetics.q,
  mech: defaultKinetics.mech,
  speed: 1,
};

const GHOST_COLORS = ['#f2a65a', '#7bd88f', '#c792ea', '#ffd166', '#4cc9f0'];
const MAX_GHOSTS = 5;
const CURVE_STEP = 0.05;
const FONT = '-apple-system, BlinkMacSystemFont, sans-serif';

function num(v: string | undefined, lo: number, hi: number, fb: number): number {
  const x = parseFloat(v ?? '');
  return clamp(Number.isFinite(x) ? x : fb, lo, hi);
}

function parseParams(src: Record<string, string>, p: DemoParams): void {
  if (src.T !== undefined) p.T = Math.round(num(src.T, T_MIN_K, T_MAX_K, defaultParams.T));
  if (src.a !== undefined) p.a = num(src.a, 0.05, 1, defaultParams.a);
  if (src.q !== undefined) p.q = num(src.q, 2, 10, defaultParams.q);
  if (src.mech !== undefined) p.mech = src.mech === 'saturated' ? 'saturated' : 'continuous';
  if (src.speed !== undefined) p.speed = num(src.speed, 0.2, 4, defaultParams.speed);
}

function toRecord(p: DemoParams): Record<string, string> {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]));
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Ghost {
  T: number;
  head: number;
  color: string;
}

function sci(v: number): string {
  if (v === 0) return '0';
  const e = Math.floor(Math.log10(v));
  const m = v / Math.pow(10, e);
  return `${m.toFixed(1)}×10${String(e)
    .replace('-', '⁻')
    .replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'.charAt(+d))}`;
}

/** Grain-size scale relative to the nose of the C-curve */
function relGrain(T: number, k: KineticParams): string {
  const r = grainLength(T, k) / grainLength(noseTemperature(k), k);
  return r >= 100 || r < 0.01 ? sci(r) : r.toPrecision(2);
}

function fmtTime(t: number): string {
  if (!Number.isFinite(t)) return '∞';
  if (t < 1e-2) return sci(t) + ' s';
  if (t < 1e4) return t.toPrecision(3) + ' s';
  const yr = t / 3.156e7;
  return t < 3.156e7 ? sci(t) + ' s' : (yr < 1e3 ? yr.toPrecision(2) : sci(yr)) + ' yr';
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  const params: DemoParams = { ...defaultParams };
  parseParams(options.getParams(), params);

  const kin = (): KineticParams => ({ a: params.a, q: params.q, mech: params.mech });

  // Run state: the simulation clock is log10 of the time (s)
  let head = LOGT_MIN;
  let playing = true;
  const ghosts: Ghost[] = [];
  let colorIdx = 0;
  let hoverT: number | null = null;
  let dragging = false;

  // A fresh random microstructure per run; the window size (grains across) follows T.
  // Rebuilding costs tens of ms, so it is deferred while the temperature is being dragged.
  let seed = 1 + Math.floor(Math.random() * 1e6);
  let map: MicroMap | null = null;
  let mapKey = '';
  function getMap(): MicroMap {
    const side = Math.round(viewSide(params.T, kin()) * 4) / 4;
    const key = `${params.mech}|${seed}|${side}`;
    if (!map || (key !== mapKey && !dragging)) {
      map = buildMicro(params.mech, seed, side);
      mapKey = key;
    }
    return map;
  }

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0b0e14', autoResize: true });
  const plotG = new Plot2D(canvas.ctx, {
    bounds: { xMin: 0, xMax: 1, yMin: 0, yMax: T_MAX_K },
    margins: { top: 30, right: 14, bottom: 14, left: 52 },
  });
  const plotS = new Plot2D(canvas.ctx, {
    bounds: { xMin: LOGT_MIN, xMax: LOGT_MAX, yMin: 0, yMax: 1 },
    margins: { top: 30, right: 18, bottom: 46, left: 66 },
  });
  const rects: { g: Rect; s: Rect; m: Rect; r: Rect } = {
    g: { x: 0, y: 0, w: 1, h: 1 },
    s: { x: 0, y: 0, w: 1, h: 1 },
    m: { x: 0, y: 0, w: 1, h: 1 },
    r: { x: 0, y: 0, w: 1, h: 1 },
  };

  const micro = document.createElement('canvas');
  micro.width = GRID;
  micro.height = GRID;
  const microCtx = micro.getContext('2d')!;
  const microImg = microCtx.createImageData(GRID, GRID);

  const disposables: Disposable[] = [];
  const sliders: Record<string, ReturnType<typeof createSlider>> = {};
  const selects: Record<string, ReturnType<typeof createSelect>> = {};
  let applyingPreset = false;

  function updateUrl() {
    options.setParams(toRecord(params));
  }

  function restart() {
    seed = 1 + Math.floor(Math.random() * 1e6);
    head = LOGT_MIN;
    playing = true;
  }

  /** Keep the run just finished (or in progress) as a faded curve for comparison */
  function commitRun() {
    if (head < LOGT_MIN + 0.8 || params.T >= TM_K) return;
    const i = ghosts.findIndex((g) => Math.abs(g.T - params.T) < 3);
    const color = ghosts[i]?.color ?? GHOST_COLORS[colorIdx++ % GHOST_COLORS.length] ?? '#ffffff';
    if (i >= 0) ghosts.splice(i, 1);
    ghosts.push({ T: params.T, head, color });
    if (ghosts.length > MAX_GHOSTS) ghosts.shift();
  }

  function setT(T: number) {
    T = Math.round(clamp(T, T_MIN_K, T_MAX_K));
    if (T === params.T) return;
    commitRun();
    params.T = T;
    restart();
    sliders.T?.setValue(T);
    if (!applyingPreset) selects.preset?.setValue('custom');
    updateUrl();
  }

  /** Kinetic constants changed: earlier curves no longer compare, so drop them */
  function setKinetics() {
    ghosts.length = 0;
    colorIdx = 0;
    restart();
    updateUrl();
  }

  if (controlsPanel) {
    const state = createSection({ title: 'Temperature' });
    disposables.push(state);
    selects.preset = createSelect({
      label: 'Quench to',
      options: [
        { value: 'custom', label: 'Custom (slider / click)' },
        { value: 'small', label: 'Small undercooling (small ΔT)' },
        { value: 'nose', label: 'Nose of the C-curve (fastest)' },
        { value: 'deep', label: 'Deep undercooling (sluggish atoms)' },
      ],
      value: 'custom',
      onChange: (v) => {
        const T =
          v === 'small' ? 860 : v === 'nose' ? noseTemperature(kin()) : v === 'deep' ? 330 : null;
        if (T === null) return;
        applyingPreset = true;
        setT(T);
        applyingPreset = false;
        selects.preset?.setValue(v);
      },
    });
    sliders.T = createSlider({
      label: 'Temperature T',
      min: T_MIN_K,
      max: T_MAX_K,
      step: 1,
      value: params.T,
      format: (v) => `${v.toFixed(0)} K  (Tm = ${TM_K} K)`,
      onChange: (v) => setT(v),
    });
    const clear = createButton({
      label: 'Clear comparison curves',
      variant: 'secondary',
      onClick: () => {
        ghosts.length = 0;
        colorIdx = 0;
      },
    });
    for (const c of [selects.preset, sliders.T, clear]) {
      disposables.push(c);
      state.content.appendChild(c.element);
    }
    controlsPanel.appendChild(state.element);

    const mat = createSection({ title: 'Material' });
    disposables.push(mat);
    mat.content.appendChild(
      createHelperText(
        'Changing these constants changes every curve, so the comparison curves are cleared.'
      )
    );
    selects.mech = createSelect({
      label: 'Nucleation',
      options: [
        { value: 'continuous', label: 'Continuous (rate I, n = 3)' },
        { value: 'saturated', label: 'Site saturation (all at t = 0, n = 2)' },
      ],
      value: params.mech,
      onChange: (v) => {
        params.mech = v === 'saturated' ? 'saturated' : 'continuous';
        setKinetics();
      },
    });
    sliders.a = createSlider({
      label: 'Nucleation barrier (∝ γ³)',
      min: 0.05,
      max: 1,
      step: 0.01,
      value: params.a,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        params.a = v;
        setKinetics();
      },
    });
    sliders.q = createSlider({
      label: 'Diffusion barrier',
      min: 2,
      max: 10,
      step: 0.1,
      value: params.q,
      format: (v) => v.toFixed(1) + ' kTm',
      onChange: (v) => {
        params.q = v;
        setKinetics();
      },
    });
    for (const c of [selects.mech, sliders.a, sliders.q]) {
      disposables.push(c);
      mat.content.appendChild(c.element);
    }
    controlsPanel.appendChild(mat.element);

    const run = createSection({ title: 'Clock' });
    disposables.push(run);
    sliders.speed = createSlider({
      label: 'Clock speed',
      min: 0.2,
      max: 4,
      step: 0.1,
      value: params.speed,
      format: (v) => v.toFixed(1) + ' decades / s',
      onChange: (v) => {
        params.speed = v;
        updateUrl();
      },
    });
    const playBtn = createButton({
      label: 'Pause',
      onClick: () => {
        playing = !playing;
        if (playing && head >= LOGT_MAX - 1e-9) restart();
        playBtn.setLabel(playing ? 'Pause' : 'Play');
      },
    });
    const restartBtn = createButton({
      label: 'Restart this temperature',
      variant: 'secondary',
      onClick: () => {
        restart();
        playBtn.setLabel('Pause');
      },
    });
    for (const c of [sliders.speed, playBtn, restartBtn]) {
      disposables.push(c);
      run.content.appendChild(c.element);
    }
    controlsPanel.appendChild(run.element);
  }

  function syncControls() {
    sliders.T?.setValue(params.T);
    sliders.a?.setValue(params.a);
    sliders.q?.setValue(params.q);
    sliders.speed?.setValue(params.speed);
    selects.mech?.setValue(params.mech);
    selects.preset?.setValue('custom');
  }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------

  function advance(dt: number) {
    if (!playing || params.T >= TM_K) return;
    head = Math.min(LOGT_MAX, head + params.speed * dt);
    if (head >= LOGT_MAX || fractionAt(Math.pow(10, head), params.T, kin()) > 0.9995) {
      playing = false;
      // leave the finished curve on screen; Play/Restart or a new T starts again
      head = Math.min(LOGT_MAX, head);
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function computeLayout() {
    const W = canvas.width;
    const H = canvas.height;
    const wide = W >= H * 1.1;
    if (wide) {
      const lw = clamp(W * 0.2, 170, 260);
      rects.g = { x: 0, y: 0, w: lw, h: H };
      const sh = H * 0.56;
      rects.s = { x: lw, y: 0, w: W - lw, h: sh };
      const ms = Math.max(60, Math.min(H - sh - 30, (W - lw) * 0.4));
      rects.m = { x: lw + 20, y: sh + 8, w: ms, h: ms };
      rects.r = { x: rects.m.x + ms + 18, y: sh + 8, w: W - lw - ms - 54, h: ms };
    } else {
      const gh = H * 0.3;
      const sh = H * 0.36;
      rects.g = { x: 0, y: 0, w: W, h: gh };
      rects.s = { x: 0, y: gh, w: W, h: sh };
      const ms = Math.max(60, Math.min(H - gh - sh - 12, W * 0.45));
      rects.m = { x: 14, y: gh + sh + 6, w: ms, h: ms };
      rects.r = { x: ms + 28, y: gh + sh + 6, w: W - ms - 42, h: ms };
    }
  }

  function text(
    s: string,
    x: number,
    y: number,
    color = '#cbd5e1',
    size = 12,
    align: CanvasTextAlign = 'left',
    baseline: CanvasTextBaseline = 'middle',
    bold = false
  ) {
    const ctx = canvas.ctx;
    ctx.fillStyle = color;
    ctx.font = `${bold ? 'bold ' : ''}${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.fillText(s, x, y);
  }

  function drawTemperature() {
    const ctx = canvas.ctx;
    const r = rects.g;
    ctx.save();
    ctx.translate(r.x, r.y);
    plotG.setSize(r.w, r.h);
    const x0 = plotG.toCanvasX(0);
    const x1 = plotG.toCanvasX(1);
    const yTm = plotG.toCanvasY(TM_K);
    const yTop = plotG.toCanvasY(T_MAX_K);
    const yBot = plotG.toCanvasY(0);

    // Stable-phase regions
    ctx.fillStyle = 'rgba(240, 120, 80, 0.13)';
    ctx.fillRect(x0, yTop, x1 - x0, yTm - yTop);
    ctx.fillStyle = 'rgba(80, 140, 240, 0.13)';
    ctx.fillRect(x0, yTm, x1 - x0, yBot - yTm);
    plotG.drawGrid(undefined, [200, 400, 600, 800, 1000, 1200]);
    plotG.drawAxes(undefined, 'Temperature (K)');
    plotG.drawTickLabels([], [0, 200, 400, 600, 800, 1000, 1200], undefined, (v) => v.toFixed(0));
    text('Temperature', r.w / 2, 14, '#e2e8f0', 13, 'center', 'middle', true);
    text('α more stable', (x0 + x1) / 2, yTop + 14, '#f0a080', 12, 'center', 'middle', true);
    text('β more stable', (x0 + x1) / 2, yBot - 14, '#80b0f0', 12, 'center', 'middle', true);

    // Tm line
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, yTm);
    ctx.lineTo(x1, yTm);
    ctx.stroke();
    ctx.setLineDash([]);
    text(`Tm = ${TM_K} K`, x1 - 4, yTm - 9, '#e2e8f0', 12, 'right');

    // Hover guide
    if (hoverT !== null && !dragging) {
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.25)';
      const yh = plotG.toCanvasY(hoverT);
      ctx.beginPath();
      ctx.moveTo(x0, yh);
      ctx.lineTo(x1, yh);
      ctx.stroke();
    }

    // Selected temperature and undercooling ΔT = Tm − T
    const T = params.T;
    const yT = plotG.toCanvasY(T);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, yT);
    ctx.lineTo(x1, yT);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(x0 - 1, yT);
    ctx.lineTo(x0 - 11, yT - 6);
    ctx.lineTo(x0 - 11, yT + 6);
    ctx.fill();
    const below = T < TM_K;
    text(`T = ${T} K`, x1 - 4, yT + (below ? 10 : -10), '#ffffff', 12, 'right', 'middle', true);
    if (below) {
      const xa = x0 + (x1 - x0) * 0.35;
      ctx.strokeStyle = '#ffd166';
      ctx.fillStyle = '#ffd166';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xa, yTm);
      ctx.lineTo(xa, yT);
      ctx.stroke();
      for (const [y, d] of [
        [yTm, 1],
        [yT, -1],
      ] as const) {
        ctx.beginPath();
        ctx.moveTo(xa, y);
        ctx.lineTo(xa - 4, y + d * 8);
        ctx.lineTo(xa + 4, y + d * 8);
        ctx.fill();
      }
      if (yT - yTm > 26) {
        text(`ΔT = ${TM_K - T} K`, xa + 8, (yTm + yT) / 2, '#ffd166', 12, 'left', 'middle', true);
      }
    } else {
      text(
        'ΔT = 0: no undercooling',
        (x0 + x1) / 2,
        yT + 14,
        '#ffd166',
        12,
        'center',
        'middle',
        true
      );
    }
    ctx.restore();
  }

  function curve(T: number, k: KineticParams, upTo: number): { xs: number[]; ys: number[] } {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let x = LOGT_MIN; x < upTo; x += CURVE_STEP) {
      xs.push(x);
      ys.push(fractionAt(Math.pow(10, x), T, k));
    }
    xs.push(upTo);
    ys.push(fractionAt(Math.pow(10, upTo), T, k));
    return { xs, ys };
  }

  function drawSCurve() {
    const ctx = canvas.ctx;
    const r = rects.s;
    const k = kin();
    ctx.save();
    ctx.translate(r.x, r.y);
    plotS.setSize(r.w, r.h);
    const xt = [-2, 0, 2, 4, 6, 8, 10];
    const yt = [0, 0.25, 0.5, 0.75, 1];
    plotS.drawGrid(xt, yt);
    plotS.drawAxes('log₁₀ ( time / s )', 'Fraction transformed X');
    plotS.drawTickLabels(
      xt,
      yt,
      (v) => v.toFixed(0),
      (v) => v.toFixed(2)
    );
    text(
      'Transformed fraction vs. time at fixed temperature',
      r.w / 2,
      14,
      '#e2e8f0',
      13,
      'center',
      'middle',
      true
    );

    // comparison curves
    for (const g of ghosts) {
      const c = curve(g.T, k, g.head);
      plotS.drawLine(c.xs, c.ys, g.color + 'aa', 2);
      const ex = plotS.toCanvasX(g.head);
      const ey = plotS.toCanvasY(c.ys[c.ys.length - 1] ?? 0);
      text(`${g.T} K`, ex + 5, ey - 7, g.color, 11, 'left');
    }

    const T = params.T;
    if (T >= TM_K) {
      text(
        `T ≥ Tm: α is stable, no undercooling, so nothing transforms`,
        plotS.toCanvasX((LOGT_MIN + LOGT_MAX) / 2),
        plotS.toCanvasY(0.5),
        '#ffd166',
        13,
        'center'
      );
    } else {
      const half = t50(T, k);
      const lh = Math.log10(half);
      // 50 % guide and t50 marker, shown once the clock has passed it
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath();
      ctx.moveTo(plotS.toCanvasX(LOGT_MIN), plotS.toCanvasY(0.5));
      ctx.lineTo(plotS.toCanvasX(LOGT_MAX), plotS.toCanvasY(0.5));
      ctx.stroke();
      if (lh <= head) {
        ctx.beginPath();
        ctx.moveTo(plotS.toCanvasX(lh), plotS.toCanvasY(0.5));
        ctx.lineTo(plotS.toCanvasX(lh), plotS.toCanvasY(0));
        ctx.stroke();
        text('t₅₀', plotS.toCanvasX(lh) + 4, plotS.toCanvasY(0.04), '#ffffff', 11);
      }
      ctx.setLineDash([]);

      const c = curve(T, k, head);
      plotS.drawLine(c.xs, c.ys, '#ffffff', 3);
      const hx = plotS.toCanvasX(head);
      const hy = plotS.toCanvasY(c.ys[c.ys.length - 1] ?? 0);
      ctx.fillStyle = '#ffd166';
      ctx.beginPath();
      ctx.arc(hx, hy, 5, 0, Math.PI * 2);
      ctx.fill();
      if (lh > LOGT_MAX) {
        text(
          `t₅₀ ≈ ${fmtTime(half)}: beyond the plotted range`,
          plotS.toCanvasX(LOGT_MAX) - 6,
          plotS.toCanvasY(0.55),
          '#ffd166',
          12,
          'right'
        );
      }
    }
    // current time marker on the axis
    const hx = plotS.toCanvasX(head);
    ctx.strokeStyle = 'rgba(255, 209, 102, 0.35)';
    ctx.beginPath();
    ctx.moveTo(hx, plotS.toCanvasY(0));
    ctx.lineTo(hx, plotS.toCanvasY(1));
    ctx.stroke();
    ctx.restore();
  }

  function drawMicro(X: number, s: number) {
    const ctx = canvas.ctx;
    const m = getMap();
    const d = microImg.data;
    const n = GRID * GRID;
    const active = params.T < TM_K && s > 0;
    for (let i = 0; i < n; i++) {
      const t = m.time[i]!;
      let R = 34;
      let G = 42;
      let B = 58;
      if (active && t <= s) {
        const g = m.grain[i]!;
        const h = (Math.imul(g + 1, 2654435761) >>> 8) & 255;
        R = 40 + (h >> 4) * 2;
        G = 150 + (h & 15) * 3;
        B = 150 + ((h >> 2) & 15) * 3;
        const right = (i + 1) % GRID === 0 ? i : i + 1;
        const down = i + GRID >= n ? i : i + GRID;
        if (
          (m.grain[right] !== g && m.time[right]! <= s) ||
          (m.grain[down] !== g && m.time[down]! <= s)
        ) {
          R = 14;
          G = 24;
          B = 34;
        } else if (s - t < 0.05) {
          R = Math.min(255, R + 70);
          G = Math.min(255, G + 60);
          B = Math.min(255, B + 40);
        }
      }
      d[4 * i] = R;
      d[4 * i + 1] = G;
      d[4 * i + 2] = B;
      d[4 * i + 3] = 255;
    }
    microCtx.putImageData(microImg, 0, 0);
    const r = rects.m;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(micro, r.x, r.y, r.w, r.h);
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    text('Microstructure', r.x, r.y - 6, '#e2e8f0', 12, 'left', 'alphabetic', true);
    text(
      `X = ${(100 * X).toFixed(1)} %`,
      r.x + r.w - 4,
      r.y - 6,
      '#ffd166',
      12,
      'right',
      'alphabetic',
      true
    );
    // legend
    const ly = r.y + r.h + 14;
    ctx.fillStyle = 'rgb(34,42,58)';
    ctx.fillRect(r.x, ly - 8, 10, 10);
    text('α (parent)', r.x + 15, ly - 3, '#94a3b8', 11);
    ctx.fillStyle = 'rgb(70,190,190)';
    ctx.fillRect(r.x + 85, ly - 8, 10, 10);
    text('β (grains)', r.x + 100, ly - 3, '#94a3b8', 11);
  }

  function drawReadout(X: number) {
    const r = rects.r;
    const k = kin();
    const T = params.T;
    const rt = rates(T, k);
    const lines: [string, string][] = [
      ['Stable phase', T < TM_K ? 'β' : T > TM_K ? 'α' : 'equal'],
      ['Undercooling ΔT', T < TM_K ? `${TM_K - T} K` : '0'],
      ['Grain size ∝ ℓ', T < TM_K ? `${relGrain(T, k)} × nose` : '–'],
      ['Nucleation', k.mech === 'continuous' ? `I = ${sci(rt.I)}` : 'sites formed at t = 0'],
      ['Growth rate U', sci(rt.U)],
      ['Avrami exponent n', String(avramiN(k))],
      ['Clock t', fmtTime(Math.pow(10, head))],
      ['t₅₀', T < TM_K ? fmtTime(t50(T, k)) : '–'],
      ['Fraction X', `${(100 * X).toFixed(1)} %`],
    ];
    const step = Math.min(21, r.h / (lines.length + 1));
    let y = r.y + step * 0.6;
    for (const [a, b] of lines) {
      text(a, r.x, y, '#94a3b8', 12);
      text(b, r.x + Math.min(r.w, 260), y, '#e2e8f0', 12, 'right', 'middle', true);
      y += step;
    }
  }

  function render(dt = 0) {
    advance(dt);
    canvas.clear();
    computeLayout();
    const k = kin();
    const T = params.T;
    const X = T < TM_K ? fractionAt(Math.pow(10, head), T, k) : 0;
    const s = T < TM_K ? pictureTime(Math.pow(10, head), T, k) : 0;
    drawTemperature();
    drawSCurve();
    drawMicro(X, s);
    drawReadout(X);
  }

  const loop = new AnimationLoop((dt) => render(dt));

  // ---------------------------------------------------------------------------
  // Pointer interaction on the temperature axis
  // ---------------------------------------------------------------------------

  function toT(e: PointerEvent): { T: number; inside: boolean } {
    const rect = canvas.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left - rects.g.x;
    const py = e.clientY - rect.top - rects.g.y;
    const T = plotG.toDataY(py);
    return {
      T: clamp(T, T_MIN_K, T_MAX_K),
      inside: px >= 0 && px <= rects.g.w && py >= 0 && py <= rects.g.h,
    };
  }

  function onPointerDown(e: PointerEvent) {
    const s = toT(e);
    if (!s.inside) return;
    dragging = true;
    canvas.canvas.setPointerCapture(e.pointerId);
    setT(s.T);
  }

  function onPointerMove(e: PointerEvent) {
    const s = toT(e);
    if (dragging) {
      setT(s.T);
      return;
    }
    hoverT = s.inside ? s.T : null;
    canvas.canvas.style.cursor = s.inside ? 'ns-resize' : 'default';
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    try {
      canvas.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // pointer capture may already be released
    }
  }

  function onPointerLeave() {
    hoverT = null;
  }

  canvas.canvas.addEventListener('pointerdown', onPointerDown);
  canvas.canvas.addEventListener('pointermove', onPointerMove);
  canvas.canvas.addEventListener('pointerup', onPointerUp);
  canvas.canvas.addEventListener('pointercancel', onPointerUp);
  canvas.canvas.addEventListener('pointerleave', onPointerLeave);

  canvas.onResize(() => render());

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
      canvas.canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.canvas.removeEventListener('pointermove', onPointerMove);
      canvas.canvas.removeEventListener('pointerup', onPointerUp);
      canvas.canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.dispose();
    },
    getParams() {
      return toRecord(params);
    },
    setParams(p: Record<string, string>) {
      parseParams(p, params);
      syncControls();
      ghosts.length = 0;
      restart();
    },
  };
}

export const sCurveDemo: DemoDefinition = {
  id: 's-curve',
  title: 'S-curves of phase transformations',
  description:
    'Fraction transformed vs. log time at a chosen temperature: pick T on a free-energy axis that shows which phase is stable and the driving force, watch the S-curve build as nuclei grow and impinge, and compare temperatures.',
  category: 'Phase transformations',
  tags: ['S-curve', 'JMAK', 'Avrami', 'nucleation', 'growth', 'driving force', 'kinetics', 'TTT'],
  create,
};

export default sCurveDemo;
