import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the build also works under a GitHub Pages subpath.
  base: './',
})
