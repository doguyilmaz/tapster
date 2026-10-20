import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { demo } from "../demo";
import { launch } from "./cdp";

const out = join(import.meta.dir, "..", "..", "site", "src", "assets", "setup");
const tmp = process.argv[2] ?? "/tmp";
mkdirSync(out, { recursive: true });
const links: string[] = [];
const { fake } = await demo(8297, (line) => {
  const m = /http:\/\/127\.0\.0\.1:\d+\/#c=[0-9a-f]+/.exec(line);
  if (m) links.push(m[0]);
});
while (!links.length) await Bun.sleep(50);
const page = await launch();
const sharp = (await import(join(import.meta.dir, "..", "..", "site", "node_modules", "sharp"))).default as (input: string) => { resize(o: { width: number }): { webp(o: { quality: number }): { toFile(p: string): Promise<unknown> } } };
const shot = async (name: string) => {
  await page.eval("document.querySelectorAll('.toast').forEach((t) => t.remove()); window.scrollTo(0, 0)");
  await Bun.sleep(150);
  const png = join(tmp, `${name}.png`);
  await page.shot(png, false);
  await sharp(png).resize({ width: 1600 }).webp({ quality: 82 }).toFile(join(out, `${name}.webp`));
};
try {
  await page.size(1280, 820);
  await page.scheme(false);
  await page.goto(links[0]!);
  await page.waitFor("document.querySelector('h1')");
  await shot("hub");
  await page.clickText("octo/homebrew-tap", ".choice");
  await page.waitFor("document.querySelector('.route')");
  await shot("protect");
  await page.clickText("Protect octo/homebrew-tap");
  await page.waitFor("document.querySelector('form[action^=\"https://github.com/settings/apps/new\"]')");
  await shot("app");
  const state = await page.eval<string>("new URL(document.querySelector('form').action).searchParams.get('state')");
  fake.installation = { id: 9, repos: ["octo/ebb"] };
  await page.goto(`http://127.0.0.1:8297/app/callback?code=democode&state=${state}`);
  await page.waitFor("document.body.textContent.includes('The App is installed')", 15000);
  await shot("install");
  await page.clickText("Continue: macOS or not");
  await page.clickText("Yes, sign macOS software");
  await page.clickText("Apple certificate", ".route button");
  await page.eval("document.querySelector('details[open]')?.removeAttribute('open')");
  await shot("certificate");
  await page.clickText("Hub files", ".route button");
  await page.waitFor("document.body.textContent.includes('changes for main')");
  await shot("files");
  await page.clickText("to main", "button");
  await page.waitFor("document.body.textContent.includes('git pull')");
  await page.clickText("Projects", "nav a");
  await page.waitFor("document.body.textContent.includes('Ready to add')");
  await shot("projects");
  await page.clickText("octo/ebb", ".item button.link");
  await page.waitFor("document.body.textContent.includes('Options')");
  await shot("project");
  await page.clickText("Add to octo/homebrew-tap");
  await page.waitFor("document.body.textContent.includes('Review and commit the changes')", 20000);
  await page.eval("document.querySelector('.sheet').scrollTop = document.querySelector('.sheet h3')?.offsetTop - 80");
  await page.eval("document.querySelector('.toast')?.remove()");
  const png = join(tmp, "added.png");
  await page.shot(png, false);
  await sharp(png).resize({ width: 1600 }).webp({ quality: 82 }).toFile(join(out, "added.webp"));
  await page.eval("document.querySelector('.sheet-back').click()");
  await page.clickText("Health", "nav a");
  await page.waitFor("document.querySelector('.card.list')", 15000);
  await shot("health");
  console.log("docs shots written to", out);
} catch (e) {
  console.error("FAILED:", (e as Error).message);
  process.exitCode = 1;
} finally {
  if (page.errors.length) console.log(page.errors.join("\n"));
  page.close();
  process.exit();
}
