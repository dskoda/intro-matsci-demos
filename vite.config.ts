import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@app': resolve(__dirname, 'src/app'),
      '@core': resolve(__dirname, 'src/core'),
      '@demos': resolve(__dirname, 'src/demos'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          core: [
            resolve(__dirname, 'src/core/canvas/HiDPICanvas.ts'),
            resolve(__dirname, 'src/core/canvas/AnimationLoop.ts'),
            resolve(__dirname, 'src/core/canvas/Plot2D.ts'),
          ],
          three: ['three'],
        },
      },
    },
  },
  server: {
    port: 3000,
    open: true,
  },
});
