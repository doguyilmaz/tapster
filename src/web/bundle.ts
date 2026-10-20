import { join } from "node:path";

export async function clientBundle(): Promise<string> {
  const out = await Bun.build({ entrypoints: [join(import.meta.dir, "client", "main.tsx")], target: "browser", minify: true });
  if (!out.success || !out.outputs[0]) throw new Error(`the setup app's script did not build: ${out.logs.map(String).join("\n")}`);
  return out.outputs[0].text();
}
