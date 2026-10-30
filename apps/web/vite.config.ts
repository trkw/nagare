import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // `bun run dev` in apps/api serves the Worker on 8787.
    proxy: { "/api": "http://localhost:8787" },
  },
});
