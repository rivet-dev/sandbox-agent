import { defineConfig } from "rivetkit/db/drizzle";

export default defineConfig({
  out: "./src/actors/project/db/drizzle",
  schema: "./src/actors/project/db/schema.ts",
});
