import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Shiki ships hundreds of language grammars as separate chunks; the
    // default 500 kB warning floods the build output with noise we can't act
    // on without dropping syntax highlighting. 1500 kB silences it without
    // hiding genuine bundle regressions in our own code.
    chunkSizeWarningLimit: 1500,
  },
  resolve: {
    alias: {
      "@dashboard": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "../src/shared"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3333",
    },
  },
});
