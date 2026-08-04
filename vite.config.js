const { defineConfig } = require('vite');

module.exports = defineConfig({
  publicDir: 'assets',
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
