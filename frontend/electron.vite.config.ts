import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {},
  preload: {},
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
    }
  }
})
