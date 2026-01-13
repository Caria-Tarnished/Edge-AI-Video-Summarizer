import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: {
      outDir: "dist/main",
      rollupOptions: {
        input: "src/main/index.ts"
      }
    }
  },
  preload: {
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        input: "src/preload/index.ts",
        output: {
          format: "cjs",
          entryFileNames: "index.js"
        }
      }
    }
  },
  renderer: {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true
    },
    resolve: {
      alias: {
        '@renderer': 'src/renderer/src'
      }
    },
    build: {
      outDir: "dist/renderer"
    }
  }
})
