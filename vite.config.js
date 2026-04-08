import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium'; // 需要先 npm install vite-plugin-cesium -D

export default defineConfig({
  plugins: [cesium()],
  server: {
    allowedHosts: true
  }
});