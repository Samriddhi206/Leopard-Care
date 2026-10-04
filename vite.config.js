import { defineConfig } from 'vite';

const apiProxy = {
  '/api': {
    target: 'http://localhost:3001',
    changeOrigin: true,
    // Forward the browser's address so the API's rate limits are per client.
    xfwd: true,
  },
};

export default defineConfig({
  server: {
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
});
