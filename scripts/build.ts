import { basename, dirname } from "node:path";
import type { BunPlugin } from "bun";
import { clientBundle } from "../src/web/bundle";

const [what, target, outfile] = process.argv.slice(2);
const script = await clientBundle();
const inline: BunPlugin = {
  name: "tapster-web-script",
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]web[\\/]assets\.ts$/ }, () => ({ contents: `export const webScript = async (): Promise<string> => ${JSON.stringify(script)};`, loader: "ts" }));
  },
};
const entry = "src/cli/main.ts";
const cliOut = target ?? "dist/cli.js";
const result =
  what === "cli"
    ? await Bun.build({ entrypoints: [entry], target: "bun", minify: true, outdir: dirname(cliOut), naming: basename(cliOut), plugins: [inline] })
    : what === "compile" && target && outfile
      ? await Bun.build({ entrypoints: [entry], minify: true, plugins: [inline], compile: { target: target as never, outfile } } as Parameters<typeof Bun.build>[0])
      : null;
if (!result) {
  console.error("usage: bun scripts/build.ts cli [outfile] | compile <bun-target> <outfile>");
  process.exit(2);
}
if (!result.success) {
  console.error(result.logs.map(String).join("\n"));
  process.exit(1);
}
console.log(result.outputs.map((o) => o.path).join("\n"));
