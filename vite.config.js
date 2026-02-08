import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VERCEL ? '/' : '/viewer3d-threejs/dist/',
  server: {
    port: 3001,
    open: true
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false
  }
});
