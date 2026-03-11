import { defineConfig } from "rivetkit/db/drizzle";

export default defineConfig({
  out: "./src/actors/handoff/db/drizzle",
  schema: "./src/actors/handoff/db/schema.ts",
});
