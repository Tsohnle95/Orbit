import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const isReleaseBuild = process.env.ORBIT_RELEASE_BUILD === "1";

export default defineConfig({
  main: {
    define: {
      __ORBIT_RELEASE_BUILD__: JSON.stringify(isReleaseBuild)
    },
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
    worker: {
      format: "es"
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
