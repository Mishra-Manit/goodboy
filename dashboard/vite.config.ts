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
    // Shiki language chunks are unavoidably large; raised to silence noise.
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
