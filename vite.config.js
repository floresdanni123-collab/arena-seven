import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, open: false },
  build: { target: 'esnext', sourcemap: false },
  assetsInclude: ['**/*.glb', '**/*.gltf']
});
