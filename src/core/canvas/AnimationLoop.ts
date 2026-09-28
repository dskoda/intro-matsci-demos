/**
 * Animation Loop
 *
 * Manages requestAnimationFrame loop with delta time calculation
 * and pause/resume functionality.
 */

export type RenderCallback = (dt: number, time: number) => void;

export interface AnimationLoopOptions {
  /** Target FPS (default: unlimited, uses vsync) */
  targetFps?: number;
  /** Maximum delta time to prevent spiral of death (default: 100ms) */
  maxDeltaTime?: number;
  /** Fixed timestep for physics updates (default: none, use variable dt) */
  fixedTimestep?: number;
}

export class AnimationLoop {
  private renderCallback: RenderCallback;
  private updateCallback?: RenderCallback;

  private animationFrameId: number | null = null;
  private isRunning = false;
  private lastTime = 0;
  private accumulator = 0;
  private totalTime = 0;

  private targetFps: number | null;
  private maxDeltaTime: number;
  private fixedTimestep: number | null;
  private minFrameTime: number | null;

  constructor(renderCallback: RenderCallback, options: AnimationLoopOptions = {}) {
    this.renderCallback = renderCallback;
    this.targetFps = options.targetFps ?? null;
    this.maxDeltaTime = options.maxDeltaTime ?? 100;
    this.fixedTimestep = options.fixedTimestep ?? null;
    this.minFrameTime = this.targetFps ? 1000 / this.targetFps : null;
  }

  /**
   * Set a separate update callback for fixed timestep updates.
   */
  setUpdateCallback(callback: RenderCallback): void {
    this.updateCallback = callback;
  }

  /**
   * Start the animation loop.
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.scheduleNextFrame();
  }

  /**
   * Stop the animation loop.
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * Check if loop is running.
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Get total elapsed time.
   */
  get elapsed(): number {
    return this.totalTime;
  }

  /**
   * Reset the timer.
   */
  resetTime(): void {
    this.totalTime = 0;
    this.lastTime = performance.now();
    this.accumulator = 0;
  }

  /**
   * Schedule next animation frame.
   */
  private scheduleNextFrame(): void {
    this.animationFrameId = requestAnimationFrame((time) => this.loop(time));
  }

  /**
   * Main loop function.
   */
  private loop(currentTime: number): void {
    if (!this.isRunning) return;

    // Calculate delta time
    let dt = currentTime - this.lastTime;

    // Handle FPS throttling
    if (this.minFrameTime !== null && dt < this.minFrameTime) {
      this.scheduleNextFrame();
      return;
    }

    // Clamp delta time to prevent spiral of death
    if (dt > this.maxDeltaTime) {
      dt = this.maxDeltaTime;
    }

    this.lastTime = currentTime;
    this.totalTime += dt;

    // Convert to seconds
    const dtSeconds = dt / 1000;
    const timeSeconds = this.totalTime / 1000;

    // Fixed timestep updates
    if (this.fixedTimestep !== null && this.updateCallback) {
      this.accumulator += dt;
      const fixedDt = this.fixedTimestep / 1000;

      while (this.accumulator >= this.fixedTimestep) {
        this.updateCallback(fixedDt, timeSeconds);
        this.accumulator -= this.fixedTimestep;
      }
    }

    // Render callback (variable timestep)
    this.renderCallback(dtSeconds, timeSeconds);

    // Schedule next frame
    this.scheduleNextFrame();
  }

  /**
   * Dispose of the animation loop.
   */
  dispose(): void {
    this.stop();
  }
}

/**
 * Create an animation loop quickly.
 */
export function createAnimationLoop(
  renderCallback: RenderCallback,
  options?: AnimationLoopOptions
): AnimationLoop {
  return new AnimationLoop(renderCallback, options);
}
