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
        input: "src/preload/index.ts"
      }
    }
  },
  renderer: {
    plugins: [react()],
    server: {
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
