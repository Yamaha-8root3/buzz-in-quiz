import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
export default defineConfig({
  server: {
    host: true, // または '0.0.0.0'
    port: 5173
  }, // 必要に応じてポート指定
  plugins: [cloudflare()]
});
