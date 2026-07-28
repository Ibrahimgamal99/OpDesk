import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone config so the harness never affects the app build.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: { port: 5199, strictPort: true },
});
