import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { page, renderReadme } from "./page";

const md = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
const dist = join(import.meta.dir, "dist");
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "index.html"), page("tapster", renderReadme(md, "https://github.com/doguyilmaz/tapster/blob/main/")));
writeFileSync(join(dist, "404.html"), page("Not found", '<h1 id="not-found">Not found</h1>\n<p><a href="/">Back to tapster</a></p>'));
