import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import fs from 'fs';
import path from 'path';

export default defineConfig({
  plugins: [
    cesium(),
    {
      name: 'pipeline-entry',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/' || req.url === '/index.html') {
            const pipelinePath = path.join(process.cwd(), 'pipeline-inspection.html');
            if (fs.existsSync(pipelinePath)) {
              req.url = '/pipeline-inspection.html';
            }
          }
          next();
        });
      }
    }
  ],
  server: {
    allowedHosts: true,
    port: 5173,
    host: '0.0.0.0',
    cors: true
  }
});