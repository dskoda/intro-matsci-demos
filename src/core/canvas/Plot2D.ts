/**
 * Plot2D
 *
 * 2D plotting utilities for drawing axes, grids, lines, and labels
 * on a canvas context.
 */

export interface PlotBounds {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface PlotMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PlotStyle {
  axisColor: string;
  gridColor: string;
  textColor: string;
  lineWidth: number;
  gridLineWidth: number;
  fontSize: number;
  fontFamily: string;
}

export interface Plot2DOptions {
  bounds: PlotBounds;
  margins?: Partial<PlotMargins>;
  style?: Partial<PlotStyle>;
}

const defaultMargins: PlotMargins = {
  top: 20,
  right: 20,
  bottom: 40,
  left: 50,
};

const defaultStyle: PlotStyle = {
  axisColor: '#888',
  gridColor: '#333',
  textColor: '#aaa',
  lineWidth: 1.5,
  gridLineWidth: 0.5,
  fontSize: 12,
  fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
};

export class Plot2D {
  private ctx: CanvasRenderingContext2D;
  private _width = 0;
  private _height = 0;
  private bounds: PlotBounds;
  private margins: PlotMargins;
  private style: PlotStyle;

  // Computed plot area
  private plotX = 0;
  private plotY = 0;
  private plotWidth = 0;
  private plotHeight = 0;

  constructor(ctx: CanvasRenderingContext2D, options: Plot2DOptions) {
    this.ctx = ctx;
    this.bounds = { ...options.bounds };
    this.margins = { ...defaultMargins, ...options.margins };
    this.style = { ...defaultStyle, ...options.style };
  }

  /** Update canvas dimensions */
  setSize(width: number, height: number): void {
    this._width = width;
    this._height = height;
    this.computePlotArea();
  }

  /** Update plot bounds */
  setBounds(bounds: Partial<PlotBounds>): void {
    this.bounds = { ...this.bounds, ...bounds };
  }

  /** Get current bounds */
  getBounds(): PlotBounds {
    return { ...this.bounds };
  }

  /** Compute the plot area from margins */
  private computePlotArea(): void {
    this.plotX = this.margins.left;
    this.plotY = this.margins.top;
    this.plotWidth = this._width - this.margins.left - this.margins.right;
    this.plotHeight = this._height - this.margins.top - this.margins.bottom;
  }

  /** Convert data X to canvas X */
  toCanvasX(dataX: number): number {
    const { xMin, xMax } = this.bounds;
    const t = (dataX - xMin) / (xMax - xMin);
    return this.plotX + t * this.plotWidth;
  }

  /** Convert data Y to canvas Y (note: Y is inverted) */
  toCanvasY(dataY: number): number {
    const { yMin, yMax } = this.bounds;
    const t = (dataY - yMin) / (yMax - yMin);
    return this.plotY + this.plotHeight - t * this.plotHeight;
  }

  /** Convert canvas X to data X */
  toDataX(canvasX: number): number {
    const { xMin, xMax } = this.bounds;
    const t = (canvasX - this.plotX) / this.plotWidth;
    return xMin + t * (xMax - xMin);
  }

  /** Convert canvas Y to data Y */
  toDataY(canvasY: number): number {
    const { yMin, yMax } = this.bounds;
    const t = (this.plotY + this.plotHeight - canvasY) / this.plotHeight;
    return yMin + t * (yMax - yMin);
  }

  /** Clear the plot area */
  clear(backgroundColor?: string): void {
    this.ctx.save();
    if (backgroundColor) {
      this.ctx.fillStyle = backgroundColor;
      this.ctx.fillRect(0, 0, this._width, this._height);
    } else {
      this.ctx.clearRect(0, 0, this._width, this._height);
    }
    this.ctx.restore();
  }

  /** Draw grid lines */
  drawGrid(xTicks?: number[], yTicks?: number[]): void {
    const ctx = this.ctx;
    const { gridColor, gridLineWidth } = this.style;

    ctx.save();
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = gridLineWidth;

    // Clip to plot area
    ctx.beginPath();
    ctx.rect(this.plotX, this.plotY, this.plotWidth, this.plotHeight);
    ctx.clip();

    // X grid lines
    if (xTicks) {
      for (const x of xTicks) {
        const cx = this.toCanvasX(x);
        ctx.beginPath();
        ctx.moveTo(cx, this.plotY);
        ctx.lineTo(cx, this.plotY + this.plotHeight);
        ctx.stroke();
      }
    }

    // Y grid lines
    if (yTicks) {
      for (const y of yTicks) {
        const cy = this.toCanvasY(y);
        ctx.beginPath();
        ctx.moveTo(this.plotX, cy);
        ctx.lineTo(this.plotX + this.plotWidth, cy);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /** Draw axes */
  drawAxes(xLabel?: string, yLabel?: string): void {
    const ctx = this.ctx;
    const { axisColor, lineWidth, textColor, fontSize, fontFamily } = this.style;

    ctx.save();
    ctx.strokeStyle = axisColor;
    ctx.lineWidth = lineWidth;
    ctx.fillStyle = textColor;
    ctx.font = `${fontSize}px ${fontFamily}`;

    // Draw X axis at y=0 if visible
    if (this.bounds.yMin <= 0 && this.bounds.yMax >= 0) {
      const y0 = this.toCanvasY(0);
      ctx.beginPath();
      ctx.moveTo(this.plotX, y0);
      ctx.lineTo(this.plotX + this.plotWidth, y0);
      ctx.stroke();
    }

    // Draw Y axis at x=0 if visible
    if (this.bounds.xMin <= 0 && this.bounds.xMax >= 0) {
      const x0 = this.toCanvasX(0);
      ctx.beginPath();
      ctx.moveTo(x0, this.plotY);
      ctx.lineTo(x0, this.plotY + this.plotHeight);
      ctx.stroke();
    }

    // Draw axis box
    ctx.strokeRect(this.plotX, this.plotY, this.plotWidth, this.plotHeight);

    // X axis label
    if (xLabel) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(
        xLabel,
        this.plotX + this.plotWidth / 2,
        this.plotY + this.plotHeight + this.margins.bottom - fontSize - 5
      );
    }

    // Y axis label
    if (yLabel) {
      ctx.save();
      ctx.translate(15, this.plotY + this.plotHeight / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(yLabel, 0, 0);
      ctx.restore();
    }

    ctx.restore();
  }

  /** Draw tick labels */
  drawTickLabels(
    xTicks: number[],
    yTicks: number[],
    formatX?: (v: number) => string,
    formatY?: (v: number) => string
  ): void {
    const ctx = this.ctx;
    const { textColor, fontSize, fontFamily, axisColor } = this.style;

    ctx.save();
    ctx.fillStyle = textColor;
    ctx.strokeStyle = axisColor;
    ctx.font = `${fontSize}px ${fontFamily}`;

    // X tick labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const x of xTicks) {
      const cx = this.toCanvasX(x);
      const label = formatX ? formatX(x) : String(x);

      // Tick mark
      ctx.beginPath();
      ctx.moveTo(cx, this.plotY + this.plotHeight);
      ctx.lineTo(cx, this.plotY + this.plotHeight + 5);
      ctx.stroke();

      // Label
      ctx.fillText(label, cx, this.plotY + this.plotHeight + 8);
    }

    // Y tick labels
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const y of yTicks) {
      const cy = this.toCanvasY(y);
      const label = formatY ? formatY(y) : String(y);

      // Tick mark
      ctx.beginPath();
      ctx.moveTo(this.plotX, cy);
      ctx.lineTo(this.plotX - 5, cy);
      ctx.stroke();

      // Label
      ctx.fillText(label, this.plotX - 8, cy);
    }

    ctx.restore();
  }

  /** Draw a line from arrays */
  drawLine(
    xData: ArrayLike<number>,
    yData: ArrayLike<number>,
    color: string,
    lineWidth?: number
  ): void {
    const ctx = this.ctx;
    const len = Math.min(xData.length, yData.length);
    if (len < 2) return;

    ctx.save();

    // Clip to plot area
    ctx.beginPath();
    ctx.rect(this.plotX, this.plotY, this.plotWidth, this.plotHeight);
    ctx.clip();

    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth ?? this.style.lineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const x0 = xData[0];
    const y0Start = yData[0];
    if (x0 === undefined || y0Start === undefined) return;

    ctx.beginPath();
    ctx.moveTo(this.toCanvasX(x0), this.toCanvasY(y0Start));

    for (let i = 1; i < len; i++) {
      const xi = xData[i];
      const yi = yData[i];
      if (xi !== undefined && yi !== undefined) {
        ctx.lineTo(this.toCanvasX(xi), this.toCanvasY(yi));
      }
    }

    ctx.stroke();
    ctx.restore();
  }

  /** Draw a filled area under a line */
  drawFilledLine(
    xData: ArrayLike<number>,
    yData: ArrayLike<number>,
    fillColor: string,
    strokeColor?: string,
    lineWidth?: number
  ): void {
    const ctx = this.ctx;
    const len = Math.min(xData.length, yData.length);
    if (len < 2) return;

    ctx.save();

    // Clip to plot area
    ctx.beginPath();
    ctx.rect(this.plotX, this.plotY, this.plotWidth, this.plotHeight);
    ctx.clip();

    const y0 = this.toCanvasY(0);

    const x0 = xData[0];
    const y0Start = yData[0];
    const xLast = xData[len - 1];
    if (x0 === undefined || y0Start === undefined || xLast === undefined) return;

    ctx.beginPath();
    ctx.moveTo(this.toCanvasX(x0), y0);
    ctx.lineTo(this.toCanvasX(x0), this.toCanvasY(y0Start));

    for (let i = 1; i < len; i++) {
      const xi = xData[i];
      const yi = yData[i];
      if (xi !== undefined && yi !== undefined) {
        ctx.lineTo(this.toCanvasX(xi), this.toCanvasY(yi));
      }
    }

    ctx.lineTo(this.toCanvasX(xLast), y0);
    ctx.closePath();

    ctx.fillStyle = fillColor;
    ctx.fill();

    if (strokeColor) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = lineWidth ?? this.style.lineWidth;
      ctx.stroke();
    }

    ctx.restore();
  }

  /** Draw a point/marker */
  drawPoint(x: number, y: number, radius: number, color: string): void {
    const ctx = this.ctx;
    const cx = this.toCanvasX(x);
    const cy = this.toCanvasY(y);

    // Only draw if within plot area
    if (
      cx < this.plotX ||
      cx > this.plotX + this.plotWidth ||
      cy < this.plotY ||
      cy > this.plotY + this.plotHeight
    ) {
      return;
    }

    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Draw text at a data position */
  drawText(
    text: string,
    x: number,
    y: number,
    options?: {
      color?: string;
      fontSize?: number;
      align?: CanvasTextAlign;
      baseline?: CanvasTextBaseline;
    }
  ): void {
    const ctx = this.ctx;
    const cx = this.toCanvasX(x);
    const cy = this.toCanvasY(y);

    ctx.save();
    ctx.fillStyle = options?.color ?? this.style.textColor;
    ctx.font = `${options?.fontSize ?? this.style.fontSize}px ${this.style.fontFamily}`;
    ctx.textAlign = options?.align ?? 'left';
    ctx.textBaseline = options?.baseline ?? 'middle';
    ctx.fillText(text, cx, cy);
    ctx.restore();
  }

  /** Generate nice tick values for an axis */
  static generateTicks(min: number, max: number, targetCount = 5): number[] {
    const range = max - min;
    if (range <= 0) return [min];

    // Find nice step size
    const roughStep = range / targetCount;
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const residual = roughStep / magnitude;

    let niceStep: number;
    if (residual <= 1.5) niceStep = 1 * magnitude;
    else if (residual <= 3) niceStep = 2 * magnitude;
    else if (residual <= 7) niceStep = 5 * magnitude;
    else niceStep = 10 * magnitude;

    // Generate ticks
    const ticks: number[] = [];
    const start = Math.ceil(min / niceStep) * niceStep;

    for (let t = start; t <= max; t += niceStep) {
      // Round to avoid floating point issues
      ticks.push(Math.round(t * 1e10) / 1e10);
    }

    return ticks;
  }
}

/**
 * Create a Plot2D instance.
 */
export function createPlot2D(ctx: CanvasRenderingContext2D, options: Plot2DOptions): Plot2D {
  return new Plot2D(ctx, options);
}
