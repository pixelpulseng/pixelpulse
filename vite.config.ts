import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src',
  // Relative asset paths so the build works at any mount point
  // (GitHub Pages project sites serve from /<repo>/)
  base: './',
  // Static assets (icons, dsp.js, favicon) copied verbatim into dist/
  publicDir: resolve(__dirname, 'public'),
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        pixelpulse: resolve(__dirname, 'src/pixelpulse.html'),
        bodeplot: resolve(__dirname, 'src/bodeplot.html'),
        curvetrace: resolve(__dirname, 'src/curvetrace.html'),
        fwupdate: resolve(__dirname, 'src/fwupdate.html'),
        calibrate: resolve(__dirname, 'src/calibrate.html'),
        debuginfo: resolve(__dirname, 'src/debuginfo.html'),
        editsenseresistor: resolve(__dirname, 'src/editsenseresistor.html'),
        setup: resolve(__dirname, 'src/setup.html'),
        m1k_advanced: resolve(__dirname, 'src/m1k_advanced.html'),
        m1k_calibrate: resolve(__dirname, 'src/m1k_calibrate.html'),
        battery: resolve(__dirname, 'src/battery.html'),
        smudemo: resolve(__dirname, 'src/smudemo.html'),
      },
    },
  },
  css: {
    lightningcss: {
      errorRecovery: true,
    },
  },
  server: {
    port: 8000,
  },
});
