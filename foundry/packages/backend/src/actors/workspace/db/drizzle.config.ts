import { defineConfig } from "rivetkit/db/drizzle";

export default defineConfig({
  out: "./src/actors/workspace/db/drizzle",
  schema: "./src/actors/workspace/db/schema.ts",
});
