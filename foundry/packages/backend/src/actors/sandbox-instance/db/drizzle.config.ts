import { defineConfig } from "rivetkit/db/drizzle";

export default defineConfig({
  out: "./src/actors/sandbox-instance/db/drizzle",
  schema: "./src/actors/sandbox-instance/db/schema.ts",
});
