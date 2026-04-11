import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8791",
      "/ws": {
        target: "ws://localhost:8791",
        ws: true,
      },
    },
  },
  build: {
    // Split the production bundle so the main chunk stays lean and slow-changing
    // third-party code can be cached independently from app code. This removes
    // the "Some chunks are larger than 500 kB" warning and speeds up cold loads
    // (react-markdown + remark pulls in a surprisingly large dependency graph).
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-router"],
          "markdown-vendor": ["react-markdown", "remark-gfm"],
          icons: ["lucide-react"],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
