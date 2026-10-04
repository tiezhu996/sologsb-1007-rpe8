import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid({ ssr: true })],
  build: {
    ssr: "scripts/test-component.tsx",
    outDir: ".tmp/ssr-test",
    emptyOutDir: true,
    rollupOptions: { external: ["jsdom"] },
  },
  define: {
    "import.meta.env.SSR": "true",
  },
});
