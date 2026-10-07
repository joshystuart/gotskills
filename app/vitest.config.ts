import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const gitIntegrationTestTimeoutMs = 30_000

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.test.ts'],
    testTimeout: gitIntegrationTestTimeoutMs,
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/junit.xml' },
  },
})
