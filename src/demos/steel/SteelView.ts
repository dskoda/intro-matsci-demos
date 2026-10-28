/**
 * Drawing and state for the Fe–Fe₃C (steel) mode of the phase-diagram demo.
 * The demo owns the canvas, layout, pointer handling and controls; this class owns
 * the tabulated diagram, the grain/lamella microstructure and the steel readout.
 */

import type { Plot2D } from '@core/canvas/Plot2D';
import {
  ALPHA,
  BOUNDARIES,
  CEMENTITE,
  CMAX,
  C_ALPHA_MAX,
  C_EUTD,
  C_EUTEC,
  C_GMAX,
  DELTA,
  GAMMA,
  L,
  LABELS,
  PHASE_LONG,
  PHASE_NAMES,
  T_EUTD,
  T_EUTEC,
  T_MAX,
  T_PERI,
  classify,
  equilibrium,
  type Equilibrium,
} from './steel';
import { COLORS, G, SteelMicro } from './steelMicro';

export interface SteelLayout {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  mx: number;
  my: number;
  ms: number;
  ry: number;
  wide: boolean;
}

export interface SteelState {
  c: number;
  T: number;
  tie: boolean;
  /** −1 cooling, +1 heating, 0 idle */
  ramp: number;
  /** Cooling/heating path; `x` is wt% C */
  path: { x: number; T: number }[];
  /** Hover point; `x` is wt% C */
  hover: { x: number; T: number } | null;
  dragging: boolean;
}

const BG: [number, number, number] = [11, 14, 20];
const rgb = (c: [number, number, number], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** Text "base_sub rest" centred at (x, y), with a real subscript */
function drawSub(
  ctx: CanvasRenderingContext2D,
  base: string,
  s: string,
  rest: string,
  x: number,
  y: number
) {
  const font = ctx.font;
  const wb = ctx.measureText(base).width;
  const wr = ctx.measureText(rest).width;
  ctx.font = '10px sans-serif';
  const ws = ctx.measureText(s).width;
  ctx.textAlign = 'left';
  let ox = x - (wb + ws + wr) / 2;
  ctx.font = font;
  ctx.fillText(base, ox, y);
  ox += wb;
  ctx.font = '10px sans-serif';
  ctx.fillText(s, ox, y + 4);
  ox += ws;
  ctx.font = font;
  ctx.fillText(rest, ox, y);
  ctx.textAlign = 'center';
}

const sub = (name: string) => '_' + name;
const wt = (c: number) => (c < 0.1 ? c.toFixed(3) : c.toFixed(2)) + ' wt%';

export class SteelView {
  private micro: SteelMicro;
  private readonly img = document.createElement('canvas');
  private readonly imgCtx: CanvasRenderingContext2D;
  private readonly imgData: ImageData;
  private regionImg: HTMLCanvasElement | null = null;
  eq: Equilibrium;

  constructor(seed: number, c: number, T: number) {
    this.micro = new SteelMicro(seed);
    this.img.width = G;
    this.img.height = G;
    this.imgCtx = this.img.getContext('2d')!;
    this.imgData = this.imgCtx.createImageData(G, G);
    this.eq = equilibrium(c, T);
    this.micro.update(c, T, 0, true);
  }

  /** New grain structure; `equilibrate` gives the finished microstructure at (c, T). */
  reset(seed: number, c: number, T: number, equilibrate = true) {
    this.micro = new SteelMicro(seed);
    this.set(c, T, equilibrate);
  }

  /** Move the state point. Without `equilibrate`, the pearlite kinetics carries on from before. */
  set(c: number, T: number, equilibrate: boolean) {
    this.eq = equilibrium(c, T);
    this.micro.update(c, T, 0, equilibrate);
  }

  /** Advance the kinetics by `steps` at the current state */
  step(c: number, T: number, steps: number) {
    this.eq = equilibrium(c, T);
    this.micro.update(c, T, steps);
  }

  get pearlite(): number {
    return this.micro.pearl;
  }

  /** Background tint of the diagram by region, rendered once */
  private regions(): HTMLCanvasElement {
    if (this.regionImg) return this.regionImg;
    const w = 334;
    const h = 200;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d')!;
    const im = g.createImageData(w, h);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const c = (px / (w - 1)) * CMAX;
        const T = (1 - py / (h - 1)) * T_MAX;
        const ph = equilibrium(c, T).phases;
        const a = ph.length === 1 ? 0.3 : 0.14;
        const o = (py * w + px) * 4;
        for (let k = 0; k < 3; k++) {
          const col = ph.reduce((s, p) => s + COLORS[p.phase]![k]!, 0) / ph.length;
          im.data[o + k] = BG[k]! * (1 - a) + col * a;
        }
        im.data[o + 3] = 255;
      }
    }
    g.putImageData(im, 0, 0);
    this.regionImg = cv;
    return cv;
  }

  drawDiagram(ctx: CanvasRenderingContext2D, plot: Plot2D, layout: SteelLayout, st: SteelState) {
    ctx.save();
    ctx.translate(layout.dx, layout.dy);
    plot.setSize(layout.dw, layout.dh);
    plot.setBounds({ xMin: 0, xMax: CMAX, yMin: 0, yMax: T_MAX });
    const X = (c: number) => plot.toCanvasX(c);
    const Y = (T: number) => plot.toCanvasY(T);
    const x0 = X(0);
    const x1 = X(CMAX);
    const y0 = Y(T_MAX);
    const y1 = Y(0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.regions(), x0, y0, x1 - x0, y1 - y0);
    const xt = [0, 1, 2, 3, 4, 5, 6, CMAX];
    const yt = [0, 200, 400, 600, 800, 1000, 1200, 1400, 1600];
    plot.drawGrid(xt, yt);
    plot.drawAxes('Carbon content (wt% C)', 'Temperature (°C)');
    plot.drawTickLabels(
      xt,
      yt,
      (v) => (v === CMAX ? '6.67' : v.toFixed(0)),
      (v) => v.toFixed(0)
    );

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();

    ctx.strokeStyle = '#e8ecf2';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (const b of BOUNDARIES) {
      ctx.beginPath();
      b.forEach(([c, T], k) => (k === 0 ? ctx.moveTo(X(c), Y(T)) : ctx.lineTo(X(c), Y(T))));
      ctx.stroke();
    }

    // Invariant points and reactions
    ctx.font = '11px sans-serif';
    ctx.fillStyle = 'rgba(232,236,242,0.85)';
    ctx.textAlign = 'left';
    ctx.fillText(`peritectic ${T_PERI} °C`, X(0.62), Y(T_PERI) - 4);
    ctx.fillText(`eutectic ${T_EUTEC} °C`, X(4.55), Y(T_EUTEC) + 14);
    ctx.fillText(`eutectoid ${T_EUTD} °C`, X(4.55), Y(T_EUTD) + 14);
    ctx.fillStyle = '#e8ecf2';
    for (const [c, T] of [
      [C_EUTEC, T_EUTEC],
      [C_EUTD, T_EUTD],
      [0.53, T_PERI],
    ] as const) {
      ctx.beginPath();
      ctx.arc(X(c), Y(T), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = '11px sans-serif';
    ctx.fillText(`${C_EUTD}`, X(C_EUTD) + 5, Y(T_EUTD) - 6);
    ctx.fillText(`${C_EUTEC}`, X(C_EUTEC) + 5, Y(T_EUTEC) - 6);
    ctx.fillText(`${C_GMAX}`, X(C_GMAX) - 12, Y(T_EUTEC) - 6);

    // Region labels
    const cx = X(st.c);
    const cy = Y(st.T);
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tie: [number, number] | null =
      this.eq.phases.length === 2 ? [this.eq.phases[0]!.x, this.eq.phases[1]!.x] : null;
    for (const lab of LABELS) {
      const lx = X(lab.c);
      const ly = Y(lab.T);
      if (Math.hypot(lx - cx, ly - cy) < 30) continue;
      if (st.tie && tie && Math.abs(ly - cy) < 24 && lx > X(tie[0]) - 30 && lx < X(tie[1]) + 30) continue;
      if (lab.ac !== undefined && lab.aT !== undefined) {
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(lx, ly + (lab.aT < lab.T ? 8 : -8));
        ctx.lineTo(X(lab.ac), Y(lab.aT));
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(lab.name, lx, ly);
    }
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = rgb(COLORS[CEMENTITE]!);
    ctx.fillText('Fe₃C', X(CMAX) - 5, Y(1262));

    // Cooling/heating path
    if (st.path.length > 1) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      st.path.forEach((q, k) => (k === 0 ? ctx.moveTo(X(q.x), Y(q.T)) : ctx.lineTo(X(q.x), Y(q.T))));
      ctx.stroke();
      ctx.restore();
    }

    // Tie line and lever rule
    if (st.tie && this.eq.phases.length === 2) {
      const [a, b] = this.eq.phases as [Equilibrium['phases'][0], Equilibrium['phases'][0]];
      const xa = X(a.x);
      const xb = X(b.x);
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      for (const xp of [xa, xb]) {
        ctx.beginPath();
        ctx.moveTo(xp, cy);
        ctx.lineTo(xp, y1);
        ctx.stroke();
      }
      ctx.restore();
      ctx.lineCap = 'round';
      ctx.lineWidth = 6;
      ctx.strokeStyle = rgb(COLORS[b.phase]!);
      ctx.beginPath();
      ctx.moveTo(xa, cy);
      ctx.lineTo(cx, cy);
      ctx.stroke();
      ctx.strokeStyle = rgb(COLORS[a.phase]!);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(xb, cy);
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xa, cy);
      ctx.lineTo(xb, cy);
      ctx.stroke();
      for (const [ph, xp] of [
        [a, xa],
        [b, xb],
      ] as const) {
        ctx.fillStyle = rgb(COLORS[ph.phase]!);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(xp, cy, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      const nameA = PHASE_NAMES[a.phase]!;
      const nameB = PHASE_NAMES[b.phase]!;
      ctx.fillStyle = '#fff';
      drawSub(ctx, 'C', nameA, '', xa - 4, cy - 10);
      drawSub(ctx, 'C', nameB, '', Math.min(xb + 4, x1 - 14), cy - 10);
      // Weight fractions beside the arms, away from the crowded left edge
      const lw = Math.max(xb, xa + 60) + 6;
      const room = lw + 70 < x1;
      const tx = room ? lw + 40 : Math.min(cx + 40, x1 - 40);
      ctx.fillStyle = rgb(COLORS[b.phase]!);
      drawSub(ctx, 'W', nameB, ` = ${b.w.toFixed(2)}`, tx, cy + (room ? 6 : 24));
      ctx.fillStyle = rgb(COLORS[a.phase]!);
      drawSub(ctx, 'W', nameA, ` = ${a.w.toFixed(2)}`, tx, cy + (room ? 22 : 40));
    }

    // State point
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.fillText('C₀', cx + 8, cy - 8);

    // Hover crosshair
    if (st.hover && !st.dragging && Math.hypot(X(st.hover.x) - cx, Y(st.hover.T) - cy) > 30) {
      const hx = X(st.hover.x);
      const hy = Y(st.hover.T);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, y0);
      ctx.lineTo(hx, y1);
      ctx.moveTo(x0, hy);
      ctx.lineTo(x1, hy);
      ctx.stroke();
      const r = equilibrium(st.hover.x, st.hover.T).region;
      const text = `${r} · ${st.hover.x.toFixed(2)} wt% C · ${st.hover.T.toFixed(0)} °C`;
      ctx.font = '12px sans-serif';
      const tw = ctx.measureText(text).width;
      const tx = Math.min(hx + 10, x1 - tw - 8);
      const ty = Math.max(hy - 10, y0 + 16);
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(tx - 4, ty - 13, tw + 8, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, tx, ty);
    }
    ctx.restore();

    // Legend
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';
    let ly = y0 + 16;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('Fe–Fe₃C phase diagram', x1 - 8, ly);
    if (layout.dh > 300) {
      for (const p of [L, DELTA, GAMMA, ALPHA, CEMENTITE]) {
        ly += 16;
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillText(`${PHASE_NAMES[p]} ${PHASE_LONG[p]}`, x1 - 24, ly);
        ctx.fillStyle = rgb(COLORS[p]!);
        ctx.fillRect(x1 - 20, ly - 10, 12, 12);
      }
    }
    ctx.restore();
  }

  drawMicro(ctx: CanvasRenderingContext2D, layout: SteelLayout, st: SteelState) {
    const { mx, my, ms } = layout;
    this.micro.paint(this.imgData.data);
    this.imgCtx.putImageData(this.imgData, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.img, mx, my, ms, ms);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(mx, my, ms, ms);

    ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';
    const label = `Microstructure · T = ${st.T.toFixed(0)} °C`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(mx + ms - tw - 12, my + 4, tw + 8, 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, mx + ms - 8, my + 17);

    // Legend
    const ly = my + ms + 18;
    let lx = mx;
    ctx.textAlign = 'left';
    const swatch = (code: number, text: string) => {
      ctx.fillStyle = rgb(COLORS[code]!);
      ctx.fillRect(lx, ly - 10, 12, 12);
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.strokeRect(lx, ly - 10, 12, 12);
      lx += 17;
      ctx.fillStyle = '#ccc';
      ctx.fillText(text, lx, ly);
      lx += ctx.measureText(text).width + 12;
    };
    const present = new Set<number>();
    const code = this.micro.code;
    for (let i = 0; i < code.length; i += 7) present.add(code[i]!);
    const names: [number, string][] = [
      [0, 'L'],
      [1, 'δ'],
      [2, 'γ'],
      [3, 'α'],
      [4, 'Fe₃C'],
      [5, 'ledeburite'],
      [6, 'pearlite (α + Fe₃C)'],
      [7, 'ledeburite + pearlite'],
    ];
    for (const [k, n] of names) if (present.has(k)) swatch(k, n);
  }

  caption(st: SteelState): string {
    const prefix = st.ramp < 0 ? 'Cooling. ' : st.ramp > 0 ? 'Heating. ' : '';
    const { c, T } = st;
    const region = this.eq.region;
    const cls = classify(c);
    switch (region) {
      case 'L':
        return `${prefix}Liquid Fe–C alloy: carbon is dissolved in the melt.`;
      case 'L + δ':
        return `${prefix}δ-ferrite (bcc) solidifies first from the melt.`;
      case 'δ':
        return `${prefix}δ-ferrite: bcc iron with at most 0.09 wt% C.`;
      case 'δ + γ':
        return `${prefix}Peritectic reaction at ${T_PERI} °C: L (0.53) + δ (0.09) → γ (0.17). Austenite grows around the δ grains.`;
      case 'γ + L':
        return `${prefix}Austenite (fcc) solidifies from the melt as the liquid gets richer in carbon.`;
      case 'L + Fe₃C':
        return `${prefix}Primary cementite crystallises from the carbon-rich melt. The eutectic L → γ + Fe₃C follows at ${T_EUTEC} °C.`;
      case 'γ':
        return `${prefix}Austenite γ (fcc) dissolves up to ${C_GMAX} wt% C in its octahedral sites. Cooling below the A₃/Acm line starts the transformation.`;
      case 'α + γ':
        return `${prefix}Proeutectoid ferrite nucleates on austenite grain boundaries; the remaining austenite is enriched in C towards ${C_EUTD} wt%.`;
      case 'γ + Fe₃C':
        if (c > C_GMAX)
          return `${prefix}${cls.name}: ledeburite (eutectic γ + Fe₃C) fills the space between primary ${c <= C_EUTEC ? 'austenite' : 'cementite'}.`;
        return `${prefix}Proeutectoid cementite forms along austenite grain boundaries; the austenite loses C towards ${C_EUTD} wt%.`;
      case 'α':
        return `${prefix}Ferrite α (bcc): at most ${C_ALPHA_MAX} wt% C, so almost pure iron.`;
      case 'Fe₃C':
        return `${prefix}Cementite Fe₃C: a hard, brittle compound with fixed composition (6.67 wt% C).`;
      default: {
        const done = this.micro.pearl;
        if (T < T_EUTD && done < 0.999 && c > C_ALPHA_MAX)
          return `${prefix}Eutectoid reaction γ (${C_EUTD}) → α (${C_ALPHA_MAX}) + Fe₃C (6.67): pearlite colonies grow into the austenite from its boundaries (${(100 * done).toFixed(0)} % done). Lamellae get finer with undercooling.`;
        if (c > C_GMAX) return `${prefix}${cls.name}: ledeburite transformed, pearlite + cementite.`;
        if (cls.pro === 'α')
          return `${prefix}${cls.name}: proeutectoid ferrite (${(100 * cls.wPro).toFixed(0)} %) plus pearlite (${(100 * cls.wPearlite).toFixed(0)} %).`;
        if (cls.pro === 'Fe₃C')
          return `${prefix}${cls.name}: proeutectoid cementite network (${(100 * cls.wPro).toFixed(0)} %) plus pearlite (${(100 * cls.wPearlite).toFixed(0)} %).`;
        return `${prefix}${cls.name}: fully pearlitic, alternating lamellae of ferrite and cementite.`;
      }
    }
  }

  drawReadout(ctx: CanvasRenderingContext2D, W: number, layout: SteelLayout, h: number, st: SteelState) {
    const y = layout.ry;
    const x = 14;
    const wide = layout.wide;
    const barW = wide ? Math.min(220, W * 0.25) : Math.min(260, W - 120);
    const textW = wide ? W - barW - 90 : W - 28;
    const barY = wide ? y + 4 : y + 66;
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(6, y - 4, W - 12, h - 6);
    ctx.textAlign = 'left';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = '#fff';
    const cls = classify(st.c);
    ctx.fillText(
      `${this.eq.region}   ·   C₀ = ${st.c.toFixed(2)} wt% C (${cls.name})   ·   T = ${st.T.toFixed(0)} °C`,
      x,
      y + 14,
      textW
    );
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#ccd3dd';
    let line2: string;
    if (this.eq.phases.length === 2) {
      const [a, b] = this.eq.phases as [Equilibrium['phases'][0], Equilibrium['phases'][0]];
      const na = PHASE_NAMES[a.phase]!;
      const nb = PHASE_NAMES[b.phase]!;
      line2 = `Tie line: C${sub(na)} = ${wt(a.x)}, C${sub(nb)} = ${wt(b.x)}.  Lever rule: W${sub(nb)} = (C₀ − C${sub(na)}) / (C${sub(nb)} − C${sub(na)}) = ${b.w.toFixed(2)},  W${sub(na)} = ${a.w.toFixed(2)}`;
    } else {
      line2 = `One phase (${this.eq.region}): W = 1 and its composition equals C₀ = ${wt(st.c)} C.`;
    }
    ctx.fillText(line2, x, y + 34, textW);
    ctx.fillStyle = '#aab3c0';
    let line3 = '';
    if (st.c > C_ALPHA_MAX && st.c < 6.6) {
      line3 = `Slow cooled to room temperature: W${sub('α')} = ${cls.wAlpha.toFixed(2)}, W${sub('Fe₃C')} = ${cls.wCem.toFixed(2)} in total`;
      if (cls.pro && st.c <= C_GMAX)
        line3 += `;  proeutectoid ${cls.pro} ${(100 * cls.wPro).toFixed(0)} %, pearlite ${(100 * cls.wPearlite).toFixed(0)} %`;
      else if (st.c <= C_GMAX) line3 += ';  pearlite 100 %';
    }
    ctx.fillText(line3, x, y + 54, textW);
    ctx.fillStyle = '#e6e9ef';
    ctx.fillText(this.caption(st), x, wide ? y + 78 : y + 122, W - 28);

    // Lever-rule phase fractions
    const bx = wide ? W - barW - 18 : x + 80;
    ctx.fillStyle = '#aab3c0';
    ctx.textAlign = 'right';
    ctx.font = '11px sans-serif';
    ctx.fillText('lever rule', bx - 6, barY + 10);
    let ox = bx;
    for (const p of this.eq.phases) {
      const w = p.w * barW;
      ctx.fillStyle = rgb(COLORS[p.phase]!);
      ctx.fillRect(ox, barY, w, 13);
      ox += w;
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.strokeRect(bx, barY, barW, 13);
    ctx.textAlign = 'left';
  }
}
