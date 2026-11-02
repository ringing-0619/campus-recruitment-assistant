import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  publicDir: '../../public',
  build: { outDir: '../../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': `http://127.0.0.1:${process.env.PORT || 43111}` },
  },
});
