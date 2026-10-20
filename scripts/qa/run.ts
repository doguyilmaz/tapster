import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { demo } from "../demo";
import { launch } from "./cdp";

const out = process.argv[2] ?? join(process.cwd(), "qa-shots");
const only = process.argv[3] ?? "";
mkdirSync(out, { recursive: true });
const links: string[] = [];
const { fake } = await demo(8299, (line) => {
  const m = /http:\/\/127\.0\.0\.1:\d+\/#c=[0-9a-f]+/.exec(line);
  if (m) links.push(m[0]);
});
while (!links.length) await Bun.sleep(50);
const page = await launch();
const shots: string[] = [];
const shot = async (name: string) => {
  const path = join(out, `${name}.png`);
  await page.shot(path);
  shots.push(path);
};
try {
  await page.size(1280, 860);
  await page.scheme(false);
  await page.goto(links[0]!);
  await page.waitFor("document.querySelector('h1')");
  await shot("01-choose-hub");
  await page.clickText("octo/homebrew-tap", ".choice");
  await page.waitFor("document.querySelector('.route')");
  await shot("02-protect");
  if (only === "start") throw new Error("stop");
  await page.clickText("Protect octo/homebrew-tap");
  await page.waitFor("document.body.textContent.includes('is protected')");
  await page.waitFor("document.querySelector('form[action^=\"https://github.com/settings/apps/new\"]')");
  await shot("03-app");
  const state = await page.eval<string>("new URL(document.querySelector('form').action).searchParams.get('state')");
  await page.goto(`http://127.0.0.1:8299/app/callback?code=democode&state=${state}`);
  await page.waitFor("document.body.textContent.includes('Install it on your projects')");
  await shot("04-app-created");
  fake.installation = { id: 9, repos: ["octo/ebb"] };
  await page.waitFor("document.body.textContent.includes('The App is installed')", 15000);
  await shot("05-installed");
  await page.clickText("macOS or not", ".route button");
  await page.waitFor("document.body.textContent.includes('Will this hub sign macOS software')");
  await shot("06-macos");
  await page.clickText("Yes, sign macOS software");
  await page.clickText("Apple certificate", ".route button");
  await shot("07-certificate");
  await page.clickText("Notarization key", ".route button");
  await shot("08-notary");
  await page.clickText("Hub files", ".route button");
  await page.waitFor("document.body.textContent.includes('changes for main')");
  await page.clickText("Remove .github/workflows/tests.yml", "label");
  await Bun.sleep(600);
  await shot("09-files");
  await page.clickText("to main", "button");
  await page.waitFor("document.body.textContent.includes('git pull')");
  await shot("10-files-written");
  await page.clickText("Optional extras", ".route button");
  await shot("10b-extras");
  await page.clickText("Projects", "nav a");
  await page.waitFor("document.body.textContent.includes('Ready to add')");
  await shot("11-projects");
  await page.clickText("octo/ebb", ".item button.link");
  await page.waitFor("document.body.textContent.includes('Options')");
  await shot("12-sheet");
  await page.clickText("Add to octo/homebrew-tap");
  await page.waitFor("document.body.textContent.includes('Review and commit the changes')", 20000);
  await Bun.sleep(400);
  await shot("13-added");
  await page.clickText("Commit these files");
  await page.waitFor("document.body.textContent.includes('Committed')");
  await page.eval("document.querySelector('.sheet-back').click()");
  await page.clickText("Health", "nav a");
  await page.waitFor("document.querySelector('.card.list')", 15000);
  await shot("14-health");
  await page.size(390, 844, true);
  await page.clickText("Setup", "nav a");
  await page.waitFor("document.querySelector('.route')");
  await shot("15-phone-setup");
  await page.scheme(true);
  await shot("16-phone-dark");
  await page.size(1280, 860);
  await page.clickText("Projects", "nav a");
  await page.waitFor("document.body.textContent.includes('Merge the entry')");
  await shot("17-projects-dark");
} catch (e) {
  if ((e as Error).message !== "stop") {
    console.error("QA FAILED:", (e as Error).message);
    await shot("zz-failure");
    process.exitCode = 1;
  }
} finally {
  console.log(shots.join("\n"));
  console.log(page.errors.length ? `CONSOLE ERRORS:\n${page.errors.join("\n")}` : "no console errors");
  page.close();
  process.exit();
}
