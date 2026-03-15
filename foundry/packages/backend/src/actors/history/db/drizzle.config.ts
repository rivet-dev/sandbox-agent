import { defineConfig } from "rivetkit/db/drizzle";

export default defineConfig({
  out: "./src/actors/history/db/drizzle",
  schema: "./src/actors/history/db/schema.ts",
});
