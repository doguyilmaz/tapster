import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { markdownToHtml, page } from "./markdown";

const md = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
const dist = join(import.meta.dir, "dist");
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "index.html"), page("tapster", markdownToHtml(md, "https://github.com/doguyilmaz/tapster/blob/main/")));
writeFileSync(join(dist, "404.html"), page("Not found", '<h1 id="not-found">Not found</h1>\n<p><a href="/">Back to tapster</a></p>'));
