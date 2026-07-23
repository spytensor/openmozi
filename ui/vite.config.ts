import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "node:fs";

// Serve/copy pdfjs CJK CMaps + standard fonts so the PDF/office viewer renders
// Chinese (and other CID-font) text — without them pdfjs drops CJK glyphs and a
// Chinese PDF previews with the text replaced by blanks/dots.
function pdfjsFontAssets(): Plugin {
  const pkgDir = path.resolve(__dirname, "node_modules/pdfjs-dist");
  const dirs = ["cmaps", "standard_fonts"];
  return {
    name: "pdfjs-font-assets",
    apply: () => true,
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        for (const dir of dirs) {
          if (url.startsWith(`/${dir}/`)) {
            const file = path.join(pkgDir, decodeURIComponent(url.replace(/^\//, "")));
            if (fs.existsSync(file) && fs.statSync(file).isFile()) {
              res.setHeader("Content-Type", "application/octet-stream");
              fs.createReadStream(file).pipe(res);
              return;
            }
          }
        }
        next();
      });
    },
    closeBundle() {
      for (const dir of dirs) {
        const src = path.join(pkgDir, dir);
        if (fs.existsSync(src)) {
          fs.cpSync(src, path.resolve(__dirname, "dist", dir), { recursive: true });
        }
      }
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    manifest: true,
    rollupOptions: {
      output: {
        // Split the Radix UI primitives (and their positioning / scroll-lock
        // deps) into a cacheable vendor chunk. They are shared across dialogs,
        // popovers, dropdowns, selects, etc.; keeping them out of the entry
        // chunk keeps app-code updates from re-downloading the primitives and
        // keeps the entry lean as more components adopt them.
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (
              id.includes("@radix-ui") ||
              id.includes("react-remove-scroll") ||
              id.includes("@floating-ui") ||
              id.includes("aria-hidden")
            ) {
              return "radix";
            }
          }
        },
      },
    },
  },
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
    proxy: {
      "/api": {
        target: "http://localhost:9210",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:9210",
        ws: true,
      },
    },
  },
  plugins: [react(), pdfjsFontAssets()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
});
