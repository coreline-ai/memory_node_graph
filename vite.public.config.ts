import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL("./public-app", import.meta.url)),
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  define: {
    __ATLAS_PUBLIC_STATIC_BUILD__: "true",
  },
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./dist-vercel", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    assetsDir: "assets",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/three/")) return "three-renderer";
          if (id.includes("/node_modules/d3-") || id.includes("/node_modules/d3-force-3d/")) {
            return "graph-layout";
          }
          return undefined;
        },
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": projectRoot,
    },
  },
});
