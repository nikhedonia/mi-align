import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages project site: https://nikhedonia.net/mi-align/
// The deploy workflow sets VITE_BASE; a local .env file can set it too.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const base = process.env.VITE_BASE || env.VITE_BASE || '/';

  return {
    base,
    plugins: [react()],
    server: { port: 5173 },
    build: { target: 'es2022' },
  };
});
