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
    headers: {
      "Content-Security-Policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; form-action 'self'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  },
  resolve: {
    alias: {
      "@": projectRoot,
    },
  },
});
