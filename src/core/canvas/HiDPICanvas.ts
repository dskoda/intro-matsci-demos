/**
 * HiDPI Canvas
 *
 * Canvas wrapper that handles devicePixelRatio scaling for crisp rendering
 * on high-DPI displays (Retina, etc.).
 */

export interface HiDPICanvasOptions {
  /** Initial width (CSS pixels). If not set, uses container width */
  width?: number;
  /** Initial height (CSS pixels). If not set, uses container height */
  height?: number;
  /** Background color (default: transparent) */
  backgroundColor?: string;
  /** Whether to auto-resize with container */
  autoResize?: boolean;
}

export class HiDPICanvas {
  public readonly canvas: HTMLCanvasElement;
  public readonly ctx: CanvasRenderingContext2D;

  private container: HTMLElement;
  private _width = 0;
  private _height = 0;
  private _dpr = 1;
  private backgroundColor: string;
  private resizeObserver: ResizeObserver | null = null;
  private onResizeCallback: (() => void) | null = null;

  constructor(container: HTMLElement, options: HiDPICanvasOptions = {}) {
    this.container = container;
    this.backgroundColor = options.backgroundColor ?? 'transparent';

    // Create canvas element
    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';

    // Get 2D context
    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D canvas context');
    }
    this.ctx = ctx;

    // Append to container
    container.appendChild(this.canvas);

    // Initial sizing
    const width = options.width ?? container.clientWidth;
    const height = options.height ?? container.clientHeight;
    this.resize(width, height);

    // Auto-resize if enabled
    if (options.autoResize !== false) {
      this.setupAutoResize();
    }
  }

  /** Current width in CSS pixels */
  get width(): number {
    return this._width;
  }

  /** Current height in CSS pixels */
  get height(): number {
    return this._height;
  }

  /** Current device pixel ratio */
  get dpr(): number {
    return this._dpr;
  }

  /** Physical canvas width (actual pixels) */
  get physicalWidth(): number {
    return this.canvas.width;
  }

  /** Physical canvas height (actual pixels) */
  get physicalHeight(): number {
    return this.canvas.height;
  }

  /**
   * Resize the canvas to new dimensions.
   */
  resize(width?: number, height?: number): void {
    this._dpr = window.devicePixelRatio || 1;
    this._width = width ?? this.container.clientWidth;
    this._height = height ?? this.container.clientHeight;

    // Set physical canvas size (actual pixels)
    this.canvas.width = Math.floor(this._width * this._dpr);
    this.canvas.height = Math.floor(this._height * this._dpr);

    // Set display size (CSS pixels)
    this.canvas.style.width = `${this._width}px`;
    this.canvas.style.height = `${this._height}px`;

    // Scale context for HiDPI
    this.ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);

    // Notify callback if set
    if (this.onResizeCallback) {
      this.onResizeCallback();
    }
  }

  /**
   * Set resize callback.
   */
  onResize(callback: () => void): void {
    this.onResizeCallback = callback;
  }

  /**
   * Clear the canvas.
   */
  clear(): void {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.backgroundColor !== 'transparent') {
      this.ctx.fillStyle = this.backgroundColor;
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    this.ctx.restore();
  }

  /**
   * Set up auto-resize observer.
   */
  private setupAutoResize(): void {
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === this.container) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0) {
            this.resize(width, height);
          }
        }
      }
    });
    this.resizeObserver.observe(this.container);
  }

  /**
   * Dispose of the canvas and clean up.
   */
  dispose(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.onResizeCallback = null;

    if (this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
  }
}

/**
 * Create a HiDPI canvas quickly.
 */
export function createHiDPICanvas(
  container: HTMLElement,
  options?: HiDPICanvasOptions
): HiDPICanvas {
  return new HiDPICanvas(container, options);
}
