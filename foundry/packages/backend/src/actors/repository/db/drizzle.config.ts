import { defineConfig } from "rivetkit/db/drizzle";

export default defineConfig({
  out: "./src/actors/repository/db/drizzle",
  schema: "./src/actors/repository/db/schema.ts",
});
