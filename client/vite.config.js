import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { win7Renderer } from "./scripts/win7-renderer.js";

export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react(), ...(mode === "win7" ? [win7Renderer()] : [tailwindcss()])],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  build: {
    outDir: mode === "win7" ? "dist-win7" : "dist",
    ...(mode === "win7" ? { target: "chrome108", cssTarget: "chrome108" } : {}),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        minutes: path.resolve(import.meta.dirname, "minutes.html"),
      },
    },
  },
}));
