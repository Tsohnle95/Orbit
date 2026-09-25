import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "src/shared")
      }
    },
    plugins: [externalizeDepsPlugin({ exclude: ["@opencode/client"] })]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    css: {
      devSourcemap: true
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
        "@shared": resolve(__dirname, "src/shared")
      }
    },
    plugins: [react()]
  }
});
