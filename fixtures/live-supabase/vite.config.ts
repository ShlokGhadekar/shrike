import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react({ exclude: /\.tsx$/ })], // exact React _debugSource lines, as in fixtures/todo-app
  server: { port: Number(process.env.APP_PORT ?? 5173), strictPort: true }, // Shrike sets APP_PORT per worktree (W2)
});
