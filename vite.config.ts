import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Electron loads from disk, so modulepreload polyfill is dead weight.
    modulePreload: { polyfill: false },
    target: 'chrome140',
    rolldownOptions: {
      output: {
        // Stable vendor chunks: app-code edits don't invalidate the heavy
        // terminal/renderer code, and each chunk stays under the 500kB warning.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 20 },
            { name: 'xterm-webgl', test: /node_modules[\\/]@xterm[\\/]addon-webgl[\\/]/, priority: 15 },
            { name: 'xterm', test: /node_modules[\\/]@xterm[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
});
