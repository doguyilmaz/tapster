import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { join, normalize } from "node:path";

const [certPath, keyPath, root, port] = process.argv.slice(2) as [string, string, string, string];
createServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "https://github.com").pathname));
  if (path.includes("..")) return res.writeHead(400).end();
  try {
    const data = readFileSync(join(root, path));
    res.writeHead(200, { "content-type": "application/octet-stream" }).end(data);
  } catch {
    res.writeHead(404).end();
  }
}).listen(Number(port));
