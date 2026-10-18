import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  clearScreen: false,
  plugins: [react()],
  server: { port: 1420, strictPort: true },
  build: {
    outDir: resolve(__dirname, 'out/renderer'),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
  },
})
