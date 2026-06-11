import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
  base: './',
  plugins: [
    react(),
    babel({
      include: /\.[jt]sx?$/,
      presets: [reactCompilerPreset()],
    }),
  ],
  build: {
    outDir: 'dist/client',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
    },
    watch: {
      // Keep the file watcher off non-source trees: dist/release payloads,
      // runtime state (.chill-vibe), and ad-hoc .tmp* scratch dirs add up to
      // 100k+ files, which can OOM the dev server's watcher on Windows.
      ignored: [
        '**/dist/**',
        '**/.chill-vibe/**',
        '**/.tmp*/**',
        '**/tmp/**',
        '**/test-results/**',
        '**/.codex-artifacts/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
