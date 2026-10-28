/**
 * TTT diagram of a eutectoid steel and the microstructure along a heat-treatment path
 * (Lecture 10).
 *
 * Left: the isothermal transformation diagram (temperature vs log time). Click to add the
 * steps of a heat treatment (holds, quenches, slow cooling); the path is then animated.
 * Top right: the S-curves of an isothermal hold at a chosen reference temperature, the
 * horizontal cut through the TTT diagram.
 * Bottom right: the microstructure and the amount of each phase now, how much the current
 * step changed it, and the phase fractions reached after every step.
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import { Plot2D } from '@core/canvas/Plot2D';
import {
  createSlider,
  createSelect,
  createButton,
  createCheckbox,
  type Disposable,
} from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import {
  A1,
  KM,
  LT_MAX,
  LT_MIN,
  MS,
  PHASES,
  PHASE_COLOR,
  PHASE_NAME,
  T0,
  T_AUST,
  T_MIN,
  Transformation,
  finishLt,
  halfLt,
  isothermal,
  product,
  startLt,
  tauSpheroid,
  type Fractions,
} from './ttt';
import { G, SteelPicture } from './tttMicro';

interface Pt {
  lt: number;
  T: number;
}

interface DemoParams {
  /** Reference temperature of the S-curve (°C) */
  ref: number;
  /** Show the S-curve panel */
  show: boolean;
  follow: boolean;
  /** Animation speed in decades of time per second */
  speed: number;
  /** Steps after the starting point, "hold end lt:T;lt:T" */
  path: string;
}

const START: Pt = { lt: LT_MIN, T: T_AUST };

/** A point of the animated trace. Every step restarts the time axis at its left edge. */
interface TP extends Pt {
  /** reached by the quench back to the left edge: temperature changes, no time passes */
  reset?: boolean;
  /** end of a step */
  end?: boolean;
  step: number;
}

/** Expand steps into: diagonal back to the left edge at the new temperature, then a hold */
function buildTrace(path: Pt[]): TP[] {
  const tr: TP[] = [{ lt: LT_MIN, T: T_AUST, end: true, step: 0 }];
  for (let i = 1; i < path.length; i++) {
    const q = path[i]!;
    tr.push({ lt: LT_MIN, T: q.T, reset: true, step: i });
    tr.push({ lt: q.lt, T: q.T, end: true, step: i });
  }
  return tr;
}

/** Each step is a hold: lt is the end of the hold on the time axis, T the temperature */
const PRESETS: Record<string, { label: string; pts: Pt[]; ref: number }> = {
  coarse: { label: 'Coarse pearlite: hold at 690 °C', pts: [p(5.3, 690)], ref: 690 },
  fine: { label: 'Fine pearlite: hold at 600 °C', pts: [p(3, 600)], ref: 600 },
  bainite: { label: 'Bainite: hold at 350 °C', pts: [p(4.5, 350)], ref: 350 },
  martensite: {
    label: 'Martensite: quench to 20 °C (~89 %)',
    pts: [p(1, 20)],
    ref: 20,
  },
  fullMartensite: {
    label: 'Full martensite: sub-zero quench to −196 °C',
    pts: [p(1, -196)],
    ref: -196,
  },
  interrupted: {
    label: 'Interrupted: 550 °C for 3 s, then quench',
    pts: [p(0.5, 550), p(2, 20)],
    ref: 550,
  },
  steps: {
    label: 'Two holds: 690 °C, then 600 °C, then quench',
    pts: [p(3.6, 690), p(3, 600), p(2, 20)],
    ref: 600,
  },
  austemper: {
    label: 'Austempering: hold at 350 °C, then cool',
    pts: [p(4, 350), p(2, 20)],
    ref: 350,
  },
  partial: {
    label: 'Partial martensite, then bainite at 250 °C',
    pts: [p(-0.7, 150), p(4.5, 250)],
    ref: 250,
  },
  spheroid: {
    label: 'Spheroidize: hold at 700 °C for days',
    pts: [p(6, 700)],
    ref: 700,
  },
};

function p(lt: number, T: number): Pt {
  return { lt, T };
}

const defaultParams: DemoParams = {
  ref: 650,
  show: true,
  follow: false,
  speed: 0.8,
  path: '',
};

const FONT = '-apple-system, BlinkMacSystemFont, sans-serif';

function num(v: string | undefined, lo: number, hi: number, fb: number): number {
  const x = parseFloat(v ?? '');
  return clamp(Number.isFinite(x) ? x : fb, lo, hi);
}

function decodePath(s: string): Pt[] {
  const out: Pt[] = [];
  for (const part of s.split(';')) {
    const [a, b] = part.split(':');
    const lt = parseFloat(a ?? '');
    const T = parseFloat(b ?? '');
    if (!Number.isFinite(lt) || !Number.isFinite(T)) continue;
    const q = {
      lt: clamp(lt, LT_MIN, LT_MAX),
      T: clamp(Math.round(T), T_MIN, A1 - 1),
    };
    out.push(q);
  }
  return out;
}

function encodePath(pts: Pt[]): string {
  return pts.map((q) => `${+q.lt.toFixed(2)}:${q.T}`).join(';');
}

function parseParams(src: Record<string, string>, q: DemoParams): void {
  if (src.ref !== undefined) q.ref = Math.round(num(src.ref, T_MIN, A1 - 1, defaultParams.ref));
  if (src.show !== undefined) q.show = src.show !== 'false';
  if (src.follow !== undefined) q.follow = src.follow === 'true';
  if (src.speed !== undefined) q.speed = num(src.speed, 0.2, 3, defaultParams.speed);
  if (src.path !== undefined) q.path = encodePath(decodePath(src.path));
}

function toRecord(q: DemoParams): Record<string, string> {
  return Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)]));
}

function fmtTime(t: number): string {
  if (t < 0.095) return '0';
  if (t < 60) return t.toPrecision(2) + ' s';
  if (t < 3600) return (t / 60).toPrecision(2) + ' min';
  if (t < 86400) return (t / 3600).toPrecision(2) + ' h';
  return (t / 86400).toPrecision(2) + ' d';
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  const params: DemoParams = { ...defaultParams };
  parseParams(options.getParams(), params);

  // ---- path and animation state -------------------------------------------------------
  let path: Pt[] = [START, ...decodePath(params.path)];
  let trace: TP[] = buildTrace(path);
  let seg = 0;
  let frac = 0;
  let playing = true;
  const engine = new Transformation();
  let picture = new SteelPicture(1 + Math.floor(Math.random() * 1e6));
  let history: Fractions[] = [engine.copy()];
  let segStart: Fractions = engine.copy();
  let hover: Pt | null = null;
  let isoKey = -1;
  let iso = isothermal(650);

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0b0e14', autoResize: true });
  const plotT = new Plot2D(canvas.ctx, {
    bounds: { xMin: LT_MIN, xMax: LT_MAX, yMin: T_MIN - 20, yMax: 850 },
    margins: { top: 28, right: 12, bottom: 44, left: 64 },
  });
  const plotS = new Plot2D(canvas.ctx, {
    bounds: { xMin: LT_MIN, xMax: LT_MAX, yMin: 0, yMax: 1 },
    margins: { top: 28, right: 14, bottom: 40, left: 64 },
  });
  const rects: Record<'ttt' | 's' | 'm' | 'tab' | 'hist', Rect> = {
    ttt: { x: 0, y: 0, w: 1, h: 1 },
    s: { x: 0, y: 0, w: 1, h: 1 },
    m: { x: 0, y: 0, w: 1, h: 1 },
    tab: { x: 0, y: 0, w: 1, h: 1 },
    hist: { x: 0, y: 0, w: 1, h: 1 },
  };
  const micro = document.createElement('canvas');
  micro.width = G;
  micro.height = G;
  const microCtx = micro.getContext('2d')!;
  const microImg = microCtx.createImageData(G, G);

  const disposables: Disposable[] = [];
  const sliders: Record<string, ReturnType<typeof createSlider>> = {};
  const selects: Record<string, ReturnType<typeof createSelect>> = {};
  const checks: Record<string, ReturnType<typeof createCheckbox>> = {};
  let playBtn: ReturnType<typeof createButton> | undefined;

  function updateUrl() {
    params.path = encodePath(path.slice(1));
    options.setParams(toRecord(params));
  }

  function pos(): Pt {
    const a = trace[seg]!;
    const b = trace[Math.min(seg + 1, trace.length - 1)]!;
    return { lt: a.lt + (b.lt - a.lt) * frac, T: a.T + (b.T - a.T) * frac };
  }

  function resetAnimation(newSeed = true) {
    trace = buildTrace(path);
    engine.reset();
    if (newSeed) picture = new SteelPicture(1 + Math.floor(Math.random() * 1e6));
    else picture.reset();
    seg = 0;
    frac = 0;
    history = [engine.copy()];
    segStart = engine.copy();
    picture.sync(engine.f);
  }

  function setPlaying(v: boolean) {
    playing = v;
    playBtn?.setLabel(v ? 'Pause' : 'Play');
  }

  function setPath(pts: Pt[]) {
    path = [START, ...pts];
    resetAnimation();
    setPlaying(true);
    updateUrl();
  }

  function applyPreset(id: string) {
    const pr = PRESETS[id];
    if (!pr) return;
    params.ref = pr.ref;
    sliders.ref?.setValue(pr.ref);
    setPath(pr.pts);
  }

  function addPoint(lt: number, Tin: number) {
    const last = path[path.length - 1]!;
    const T = clamp(Math.round(Tin), T_MIN, A1 - 1);
    let t = clamp(lt, LT_MIN, LT_MAX);
    if (t - LT_MIN < 0.05) t = LT_MIN; // a quench without a hold
    if (path.length > 1 && t === last.lt && T === last.T) return;
    path.push({ lt: t, T });
    trace = buildTrace(path);
    selects.preset?.setValue('custom');
    updateUrl();
  }

  if (controlsPanel) {
    const sec = createSection({ title: 'Heat-treatment path' });
    disposables.push(sec);
    sec.content.appendChild(
      createHelperText(
        'Click on the TTT diagram to add a step: the sample is quenched to the clicked temperature (the line goes back to the left edge, no time passes) and held for the clicked time.'
      )
    );
    selects.preset = createSelect({
      label: 'Example',
      options: [
        { value: 'custom', label: 'Custom (click the diagram)' },
        ...Object.entries(PRESETS).map(([value, v]) => ({ value, label: v.label })),
      ],
      value: 'custom',
      onChange: (v) => {
        if (v !== 'custom') applyPreset(v);
      },
    });
    playBtn = createButton({
      label: 'Pause',
      onClick: () => {
        if (!playing && seg >= trace.length - 1) resetAnimation();
        setPlaying(!playing);
      },
    });
    const restart = createButton({
      label: 'Restart animation',
      variant: 'secondary',
      onClick: () => {
        resetAnimation();
        setPlaying(true);
      },
    });
    const undo = createButton({
      label: 'Undo last point',
      variant: 'secondary',
      onClick: () => {
        if (path.length > 1) path.pop();
        resetAnimation();
        updateUrl();
      },
    });
    const clear = createButton({
      label: 'Clear path',
      variant: 'secondary',
      onClick: () => {
        path = [START];
        selects.preset?.setValue('custom');
        resetAnimation();
        updateUrl();
      },
    });
    sliders.speed = createSlider({
      label: 'Animation speed',
      min: 0.2,
      max: 3,
      step: 0.1,
      value: params.speed,
      format: (v) => v.toFixed(1) + ' decades / s',
      onChange: (v) => {
        params.speed = v;
        updateUrl();
      },
    });
    for (const c of [selects.preset, playBtn, restart, undo, clear, sliders.speed]) {
      disposables.push(c);
      sec.content.appendChild(c.element);
    }
    controlsPanel.appendChild(sec.element);

    const refSec = createSection({ title: 'S-curve' });
    disposables.push(refSec);
    sliders.ref = createSlider({
      label: 'Isothermal hold at',
      min: T_MIN,
      max: A1 - 1,
      step: 1,
      value: params.ref,
      format: (v) => v.toFixed(0) + ' °C',
      onChange: (v) => {
        params.ref = Math.round(v);
        updateUrl();
      },
    });
    checks.show = createCheckbox({
      label: 'Show the S-curve',
      checked: params.show,
      onChange: (v) => {
        params.show = v;
        updateRefVisibility();
        updateUrl();
      },
    });
    checks.follow = createCheckbox({
      label: 'Follow the path temperature',
      checked: params.follow,
      onChange: (v) => {
        params.follow = v;
        updateUrl();
      },
    });
    for (const c of [checks.show, sliders.ref, checks.follow]) {
      disposables.push(c);
      refSec.content.appendChild(c.element);
    }
    controlsPanel.appendChild(refSec.element);
    updateRefVisibility();
  }

  function updateRefVisibility() {
    for (const c of [sliders.ref, checks.follow]) {
      if (c) c.element.style.display = params.show ? '' : 'none';
    }
  }

  function syncControls() {
    checks.show?.setChecked(params.show);
    updateRefVisibility();
    sliders.ref?.setValue(params.ref);
    sliders.speed?.setValue(params.speed);
    checks.follow?.setChecked(params.follow);
    selects.preset?.setValue('custom');
  }

  resetAnimation(false);

  // ---- animation ------------------------------------------------------------------------

  function integrate(a: Pt, b: Pt, f0: number, f1: number, noTime = false) {
    const dl = (b.lt - a.lt) * (f1 - f0);
    const dT = Math.abs(b.T - a.T) * (f1 - f0);
    const n = Math.max(1, Math.ceil(Math.max(dl / 0.02, dT / 3)));
    for (let k = 1; k <= n; k++) {
      const u0 = f0 + ((f1 - f0) * (k - 1)) / n;
      const u1 = f0 + ((f1 - f0) * k) / n;
      const t0 = Math.pow(10, a.lt + (b.lt - a.lt) * u0);
      const t1 = Math.pow(10, a.lt + (b.lt - a.lt) * u1);
      engine.step(a.T + (b.T - a.T) * u1, noTime ? 0 : t1 - t0);
    }
  }

  function advance(dt: number) {
    if (!playing || seg >= trace.length - 1) return;
    let budget = dt;
    for (let guard = 0; budget > 0 && seg < trace.length - 1 && guard < 80; guard++) {
      const a = trace[seg]!;
      const b = trace[seg + 1]!;
      const dur = b.reset
        ? Math.max(
            Math.abs(b.lt - a.lt) / (2 * params.speed),
            Math.abs(b.T - a.T) / (250 * params.speed)
          )
        : Math.max((b.lt - a.lt) / params.speed, Math.abs(b.T - a.T) / (250 * params.speed));
      let nf: number;
      if (dur <= 1e-9) nf = 1;
      else {
        const need = (1 - frac) * dur;
        if (budget >= need) {
          nf = 1;
          budget -= need;
        } else {
          nf = frac + budget / dur;
          budget = 0;
        }
      }
      integrate(a, b, frac, nf, b.reset);
      frac = nf;
      if (frac >= 1) {
        seg++;
        frac = 0;
        if (b.end) {
          history.push(engine.copy());
          segStart = engine.copy();
        }
      }
    }
    picture.sync(engine.f);
  }

  // ---- rendering ------------------------------------------------------------------------

  function computeLayout() {
    const W = canvas.width;
    const H = canvas.height;
    if (W >= 900 && W >= H * 1.1) {
      const tw = W * 0.46;
      rects.ttt = { x: 0, y: 0, w: tw, h: H };
      const rw = W - tw;
      rects.s = { x: tw, y: 0, w: rw, h: params.show ? H * 0.32 : 0 };
      const ms = Math.max(80, Math.min(rw * 0.46, H * (params.show ? 0.36 : 0.5)));
      rects.m = { x: tw + 14, y: rects.s.h + 22, w: ms, h: ms };
      rects.tab = { x: rects.m.x + ms + 14, y: rects.m.y, w: rw - ms - 38, h: ms };
      const hy = rects.m.y + ms + 12;
      rects.hist = { x: tw + 14, y: hy, w: rw - 28, h: Math.max(40, H - hy - 6) };
    } else {
      const th = H * (params.show ? 0.38 : 0.55);
      rects.ttt = { x: 0, y: 0, w: W, h: th };
      rects.s = { x: 0, y: th, w: W, h: params.show ? H * 0.2 : 0 };
      const ms = Math.max(80, Math.min(W * 0.42, H * 0.26));
      rects.m = { x: 12, y: th + rects.s.h + 20, w: ms, h: ms };
      rects.tab = { x: ms + 26, y: rects.m.y, w: W - ms - 38, h: ms };
      const hy = rects.m.y + ms + 8;
      rects.hist = { x: 12, y: hy, w: W - 24, h: Math.max(30, H - hy - 4) };
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

  const lt2tick = (v: number) => {
    const names: Record<number, string> = {
      [-1]: '0.1',
      0: '1',
      1: '10',
      2: '10²',
      3: '10³',
      4: '10⁴',
      5: '10⁵',
      6: '10⁶',
    };
    return names[v] ?? String(v);
  };
  const xTicks = [-1, 0, 1, 2, 3, 4, 5, 6];

  function refTemperature(): number {
    const q = pos();
    if (params.follow && q.T < A1) return clamp(Math.round(q.T), T_MIN, A1 - 1);
    return params.ref;
  }

  function band(plot: Plot2D, x1: number, x2: number, Ta: number, Tb: number, color: string) {
    const ctx = canvas.ctx;
    const xa = plot.toCanvasX(clamp(x1, LT_MIN, LT_MAX));
    const xb = plot.toCanvasX(clamp(x2, LT_MIN, LT_MAX));
    if (xb <= xa) return;
    const ya = plot.toCanvasY(Ta);
    const yb = plot.toCanvasY(Tb);
    ctx.fillStyle = color;
    ctx.fillRect(xa, ya, xb - xa, yb - ya + 0.6);
  }

  function drawTTT() {
    const ctx = canvas.ctx;
    const r = rects.ttt;
    ctx.save();
    ctx.translate(r.x, r.y);
    plotT.setSize(r.w, r.h);
    const L = plotT.toCanvasX(LT_MIN);
    const Rr = plotT.toCanvasX(LT_MAX);

    // martensite region and spheroidite region
    ctx.fillStyle = 'rgba(88,166,255,0.10)';
    ctx.fillRect(L, plotT.toCanvasY(MS), Rr - L, plotT.toCanvasY(T_MIN - 20) - plotT.toCanvasY(MS));
    for (let T = A1 - 1; T > 560; T -= 2) {
      band(
        plotT,
        Math.log10(T0 + 0.693 * tauSpheroid(T)),
        LT_MAX,
        T,
        T - 2,
        'rgba(199,146,234,0.16)'
      );
    }
    // diffusional transformation: product colour between start and finish
    for (let T = A1 - 1; T > T_MIN; T -= 2) {
      const c = PHASE_COLOR[product(T)];
      band(plotT, startLt(T), finishLt(T), T, T - 2, c + '55');
    }
    plotT.drawGrid(xTicks, [-200, -100, 0, 100, 200, 300, 400, 500, 600, 700, 800]);
    plotT.drawAxes('time (s)', 'Temperature (°C)');
    plotT.drawTickLabels(
      xTicks,
      [-200, -100, 0, 100, 200, 300, 400, 500, 600, 700, 800],
      lt2tick,
      (v) => v.toFixed(0)
    );
    text('TTT diagram, 0.76 wt% C steel', r.w / 2, 13, '#e2e8f0', 13, 'center', 'middle', true);

    // curves
    const Ts: number[] = [];
    const sx: number[] = [];
    const fx: number[] = [];
    const hx: number[] = [];
    for (let T = A1 - 1; T >= T_MIN; T -= 2) {
      Ts.push(T);
      sx.push(startLt(T));
      fx.push(finishLt(T));
      hx.push(halfLt(T));
    }
    plotT.drawLine(sx, Ts, '#e2e8f0', 2);
    plotT.drawLine(fx, Ts, '#e2e8f0', 2);
    ctx.setLineDash([7, 4]);
    plotT.drawLine(hx, Ts, '#ffffff', 1.5);
    ctx.setLineDash([]);
    const spT: number[] = [];
    const spX: number[] = [];
    for (let T = A1 - 1; T > 560; T -= 2) {
      spT.push(T);
      spX.push(Math.log10(T0 + 0.693 * tauSpheroid(T)));
    }
    ctx.setLineDash([4, 4]);
    plotT.drawLine(spX, spT, PHASE_COLOR.S, 1.5);
    ctx.setLineDash([]);

    // horizontal reference lines
    const hline = (T: number, color: string, label: string, dash = [5, 4]) => {
      const y = plotT.toCanvasY(T);
      ctx.setLineDash(dash);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(L, y);
      ctx.lineTo(Rr, y);
      ctx.stroke();
      ctx.setLineDash([]);
      text(label, Rr - 4, y - 8, color, 11, 'right');
    };
    hline(A1, '#e2e8f0', `A1 = ${A1} °C`);
    hline(MS, PHASE_COLOR.M, `Ms = ${MS} °C`);
    hline(MS - Math.LN2 / KM, PHASE_COLOR.M, 'M50', [2, 4]);
    hline(MS - Math.LN10 / KM, PHASE_COLOR.M, 'M90', [2, 4]);
    hline(MS - Math.log(100) / KM, PHASE_COLOR.M, 'M99 ≈ Mf', [2, 4]);
    hline(650, 'rgba(226,232,240,0.25)', '', [2, 5]);
    hline(540, 'rgba(226,232,240,0.25)', '', [2, 5]);

    // region labels
    text(
      'Austenite (γ)',
      plotT.toCanvasX(LT_MIN + 0.1),
      plotT.toCanvasY(780),
      '#cbd5e1',
      12,
      'left',
      'middle',
      true
    );
    text(
      'γ',
      plotT.toCanvasX(-0.25),
      plotT.toCanvasY(430),
      '#cbd5e1',
      18,
      'center',
      'middle',
      true
    );
    text(
      'coarse pearlite',
      plotT.toCanvasX(finishLt(690) + 0.1),
      plotT.toCanvasY(690),
      PHASE_COLOR.Pc,
      12,
      'left',
      'middle',
      true
    );
    text(
      'fine pearlite',
      plotT.toCanvasX(finishLt(600) + 0.1),
      plotT.toCanvasY(600),
      PHASE_COLOR.Pf,
      12,
      'left',
      'middle',
      true
    );
    text(
      'bainite',
      plotT.toCanvasX(finishLt(420) + 0.1),
      plotT.toCanvasY(420),
      PHASE_COLOR.B,
      12,
      'left',
      'middle',
      true
    );
    text(
      'martensite',
      plotT.toCanvasX(LT_MIN + 0.1),
      plotT.toCanvasY(130),
      PHASE_COLOR.M,
      12,
      'left',
      'middle',
      true
    );
    text(
      'spheroidite',
      plotT.toCanvasX(LT_MAX) - 6,
      plotT.toCanvasY(640),
      PHASE_COLOR.S,
      12,
      'right',
      'middle',
      true
    );
    text(
      'start 1 %',
      plotT.toCanvasX(startLt(300)) - 5,
      plotT.toCanvasY(300) + 11,
      '#e2e8f0',
      11,
      'right'
    );
    text('50 %', plotT.toCanvasX(halfLt(300)), plotT.toCanvasY(300) + 11, '#ffffff', 11, 'center');
    text(
      'finish 99 %',
      plotT.toCanvasX(finishLt(300)) + 5,
      plotT.toCanvasY(300) + 11,
      '#e2e8f0',
      11,
      'left'
    );

    // reference temperature of the S-curve
    const Tr = refTemperature();
    if (params.show) {
      const yr = plotT.toCanvasY(Tr);
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(L, yr);
      ctx.lineTo(Rr, yr);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffd166';
      for (const x of [startLt(Tr), halfLt(Tr), finishLt(Tr)]) {
        if (x >= LT_MIN && x <= LT_MAX) {
          ctx.beginPath();
          ctx.arc(plotT.toCanvasX(x), yr, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      text(`S-curve at ${Tr} °C`, L + 6, yr - 8, '#ffd166', 11, 'left');
    }

    // path
    const cp = (q: Pt) => [plotT.toCanvasX(q.lt), plotT.toCanvasY(q.T)] as const;
    const cur = pos();
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    const strokeSegs = (solid: boolean) => {
      ctx.beginPath();
      for (let j = 0; j < trace.length - 1; j++) {
        const b = trace[j + 1]!;
        if (solid && j > seg) break;
        if (!solid && j < seg) continue;
        const from = !solid && j === seg ? cur : trace[j]!;
        const to = solid && j === seg ? cur : b;
        ctx.moveTo(...cp(from));
        ctx.lineTo(...cp(to));
      }
      ctx.stroke();
    };
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    strokeSegs(false);
    ctx.setLineDash([]);
    ctx.strokeStyle = '#ffffff';
    strokeSegs(true);
    // hover preview: diagonal back to the left edge at the new temperature, then a hold
    if (hover) {
      const last = path[path.length - 1]!;
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(...cp(last));
      ctx.lineTo(...cp({ lt: LT_MIN, T: hover.T }));
      ctx.lineTo(...cp({ lt: Math.max(hover.lt, LT_MIN), T: hover.T }));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // end of every step
    for (let i = 0; i < path.length; i++) {
      const [x, y] = cp(path[i]!);
      const reached = i < history.length;
      ctx.fillStyle = reached ? '#ffffff' : '#0b0e14';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      text(String(i), x, y + 0.5, reached ? '#0b0e14' : '#ffffff', 10, 'center', 'middle', true);
    }
    const [cx, cy] = cp(cur);
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawS() {
    const ctx = canvas.ctx;
    const r = rects.s;
    const Tr = refTemperature();
    if (Tr !== isoKey) {
      isoKey = Tr;
      iso = isothermal(Tr);
    }
    ctx.save();
    ctx.translate(r.x, r.y);
    plotS.setSize(r.w, r.h);
    const yt = [0, 0.25, 0.5, 0.75, 1];
    plotS.drawGrid(xTicks, yt);
    plotS.drawAxes('time (s)', 'Fraction of phase');
    plotS.drawTickLabels(xTicks, yt, lt2tick, (v) => v.toFixed(2));
    text(
      `S-curves of an isothermal hold at ${Tr} °C`,
      r.w / 2,
      13,
      '#e2e8f0',
      13,
      'center',
      'middle',
      true
    );
    // start and finish of the diffusional transformation, as in the TTT diagram
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(255,209,102,0.6)';
    ctx.lineWidth = 1;
    for (const x of [startLt(Tr), halfLt(Tr), finishLt(Tr)]) {
      if (x < LT_MIN || x > LT_MAX) continue;
      ctx.beginPath();
      ctx.moveTo(plotS.toCanvasX(x), plotS.toCanvasY(0));
      ctx.lineTo(plotS.toCanvasX(x), plotS.toCanvasY(1));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const ph of PHASES) {
      const ys = iso.f[ph];
      if (Math.max(...ys) < 0.004) continue;
      plotS.drawLine(iso.lt, ys, PHASE_COLOR[ph], ph === 'A' ? 2.5 : 2.2);
    }
    // current time on the path
    const cur = pos();
    if (cur.lt > LT_MIN) {
      const x = plotS.toCanvasX(cur.lt);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, plotS.toCanvasY(0));
      ctx.lineTo(x, plotS.toCanvasY(1));
      ctx.stroke();
      text('now', x + 4, plotS.toCanvasY(0.96), '#ffffff', 11, 'left');
    }
    ctx.restore();
  }

  function drawMicro() {
    const ctx = canvas.ctx;
    picture.paint(microImg.data);
    microCtx.putImageData(microImg, 0, 0);
    const r = rects.m;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(micro, r.x, r.y, r.w, r.h);
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    text('Microstructure', r.x, r.y - 8, '#e2e8f0', 12, 'left', 'middle', true);
    const cur = pos();
    const t = Math.max(0, Math.pow(10, cur.lt) - T0);
    text(
      `${Math.round(cur.T)} °C   hold ${fmtTime(t + T0)}`,
      r.x + r.w,
      r.y - 8,
      '#ffd166',
      12,
      'right',
      'middle',
      true
    );
  }

  function drawTable() {
    const r = rects.tab;
    const f = engine.f;
    const step = Math.min(24, r.h / 8);
    const head =
      path.length < 2
        ? 'Add a step to the path'
        : seg >= trace.length - 1
          ? 'Path finished'
          : `Step ${trace[seg + 1]!.step}`;
    text(head, r.x, r.y + step * 0.5, '#e2e8f0', 12, 'left', 'middle', true);
    text('now', r.x + r.w - 62, r.y + step * 0.5, '#94a3b8', 11, 'right');
    text('this step', r.x + r.w, r.y + step * 0.5, '#94a3b8', 11, 'right');
    let y = r.y + step * 1.5;
    for (const ph of PHASES) {
      const now = f[ph] * 100;
      const d = (f[ph] - segStart[ph]) * 100;
      canvas.ctx.fillStyle = PHASE_COLOR[ph];
      canvas.ctx.fillRect(r.x, y - 6, 12, 12);
      text(PHASE_NAME[ph], r.x + 18, y, '#cbd5e1', 12);
      text(now.toFixed(1) + ' %', r.x + r.w - 62, y, '#e2e8f0', 12, 'right', 'middle', true);
      const dc = Math.abs(d) < 0.05 ? '#64748b' : d > 0 ? '#7bd88f' : '#f08080';
      text(
        (d > 0.05 ? '+' : '') + (Math.abs(d) < 0.05 ? '0' : d.toFixed(1)),
        r.x + r.w,
        y,
        dc,
        12,
        'right',
        'middle',
        true
      );
      y += step;
    }
  }

  function drawHistory() {
    const r = rects.hist;
    text('Phase fractions after each step', r.x, r.y + 2, '#e2e8f0', 12, 'left', 'middle', true);
    const rows = history.length + (seg < trace.length - 1 ? 1 : 0);
    const maxRows = Math.max(1, Math.floor((r.h - 14) / 17));
    const first = Math.max(0, rows - maxRows);
    const labelW = 112;
    const bx = r.x + labelW;
    const bw = Math.max(40, r.w - labelW);
    let y = r.y + 18;
    for (let i = first; i < rows; i++) {
      const live = i >= history.length;
      const f = live ? engine.f : history[i]!;
      const wp = path[Math.min(i, path.length - 1)]!;
      const lab = live
        ? `step ${trace[Math.min(seg + 1, trace.length - 1)]!.step}…`
        : i === 0
          ? '0  γ at 800 °C'
          : `${i}  ${wp.T} °C, ${fmtTime(Math.pow(10, wp.lt) - T0)}`;
      text(lab, r.x, y + 7, live ? '#ffd166' : '#94a3b8', 11);
      let x = bx;
      for (const ph of PHASES) {
        const w = f[ph] * bw;
        if (w < 0.3) continue;
        canvas.ctx.fillStyle = PHASE_COLOR[ph];
        canvas.ctx.fillRect(x, y, w, 14);
        x += w;
      }
      y += 17;
    }
  }

  function render(dt = 0) {
    advance(dt);
    if (params.follow) {
      const t = refTemperature();
      if (t !== params.ref) sliders.ref?.setValue(t);
    }
    canvas.clear();
    computeLayout();
    drawTTT();
    if (params.show) drawS();
    drawMicro();
    drawTable();
    drawHistory();
  }

  const loop = new AnimationLoop((dt) => render(dt));

  // ---- pointer interaction on the TTT diagram -------------------------------------------

  function toData(e: PointerEvent): { pt: Pt; inside: boolean } {
    const rect = canvas.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left - rects.ttt.x;
    const py = e.clientY - rect.top - rects.ttt.y;
    const lt = plotT.toDataX(px);
    const T = plotT.toDataY(py);
    return {
      pt: { lt, T },
      inside:
        px >= 0 &&
        px <= rects.ttt.w &&
        py >= 0 &&
        py <= rects.ttt.h &&
        lt >= LT_MIN - 0.2 &&
        T >= 0 &&
        T <= 850,
    };
  }

  function onPointerDown(e: PointerEvent) {
    const d = toData(e);
    if (!d.inside) return;
    addPoint(d.pt.lt, d.pt.T);
  }

  function onPointerMove(e: PointerEvent) {
    const d = toData(e);
    hover = d.inside ? d.pt : null;
    canvas.canvas.style.cursor = d.inside ? 'crosshair' : 'default';
  }

  function onPointerLeave() {
    hover = null;
  }

  canvas.canvas.addEventListener('pointerdown', onPointerDown);
  canvas.canvas.addEventListener('pointermove', onPointerMove);
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
      canvas.canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.dispose();
    },
    getParams() {
      return toRecord(params);
    },
    setParams(q: Record<string, string>) {
      parseParams(q, params);
      path = [START, ...decodePath(params.path)];
      syncControls();
      resetAnimation();
      setPlaying(true);
    },
  };
}

export const tttSteelDemo: DemoDefinition = {
  id: 'ttt-steel',
  title: 'TTT diagram and microstructure of steel',
  description:
    'Draw a stepwise heat treatment on the TTT diagram of a eutectoid steel and watch austenite turn into coarse or fine pearlite, bainite, martensite and spheroidite, with the S-curve of an isothermal hold alongside.',
  category: 'Phase transformations',
  tags: [
    'TTT',
    'steel',
    'austenite',
    'pearlite',
    'bainite',
    'martensite',
    'spheroidite',
    'kinetics',
    'heat treatment',
  ],
  create,
};

export default tttSteelDemo;
