import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  plugins: [cesium()],
  server: {
    allowedHosts: true,
    port: 5175,
    host: '0.0.0.0',
    cors: true
  }
});