import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

await build({
  entryPoints: ["src/main.jsx"],
  bundle: true,
  minify: true,
  sourcemap: false,
  format: "iife",
  outfile: "dist/app.js",
  loader: { ".css": "css" },
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

await mkdir("dist", { recursive: true });
await cp("index.html", "dist/index.html");
