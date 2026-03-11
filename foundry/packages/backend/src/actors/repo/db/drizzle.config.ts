import { defineConfig } from "rivetkit/db/drizzle";

export default defineConfig({
  out: "./src/actors/repo/db/drizzle",
  schema: "./src/actors/repo/db/schema.ts",
});
