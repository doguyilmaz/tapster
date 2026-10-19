import { expect, test } from "bun:test";
import { appRoutes, permissionLines, type AppCopy } from "../src/cli/appflow";
import { TapsterError } from "../src/errors";

const copy: AppCopy = {
  what: "your tapster App",
  title: "Create your tapster App",
  lead: "GitHub asks you to confirm a private App.",
  key: "tapster stores its key in o/homebrew-tap.",
  done: "Your tapster App is created",
  next: ["tapster opens the install page.", "Pick your projects, never o/homebrew-tap."],
  again: "tapster init",
};

const manifest = (redirect: string) => ({ name: "tapster-o-tap", redirect_url: redirect, default_permissions: { contents: "write", metadata: "read" } });

function routes() {
  const results: ({ code: string } | { error: TapsterError })[] = [];
  const handle = appRoutes({ manifest, copy, state: "s3cret", port: 4123, settle: (r) => results.push(r) });
  const get = (path: string, host = "127.0.0.1:4123") => handle(new Request(`http://127.0.0.1:4123${path}`, { headers: { host } }));
  return { results, get };
}

test("every permission in both manifests has a sentence and unknown ones fail closed", () => {
  expect(permissionLines({ default_permissions: { contents: "write", attestations: "read", metadata: "read" } })).toHaveLength(3);
  expect(permissionLines({ default_permissions: { actions: "write", metadata: "read" } })[0]).toContain("Actions");
  expect(() => permissionLines({ default_permissions: { administration: "write" } })).toThrow(TapsterError);
});

test("the start page explains the App and posts the manifest to GitHub without a script", async () => {
  const { get } = routes();
  const res = get("/start");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-security-policy")).toContain("form-action https://github.com");
  expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(res.headers.get("cache-control")).toBe("no-store");
  const html = await res.text();
  expect(html).toContain('action="https://github.com/settings/apps/new?state=s3cret"');
  expect(html).toContain("http://127.0.0.1:4123/callback");
  expect(html).toContain("Create your tapster App");
  expect(html).toContain("Contents, read and write");
  expect(html).toContain("tapster stores its key in o/homebrew-tap.");
  expect(html).not.toMatch(/<script|\son[a-z]+=/i);
});

test("the manifest is escaped inside the form", async () => {
  const handle = appRoutes({ manifest: () => ({ name: `a"<b>&`, default_permissions: {} }), copy, state: "s", port: 1, settle: () => {} });
  const html = await handle(new Request("http://127.0.0.1:1/start", { headers: { host: "127.0.0.1:1" } })).text();
  expect(html).toContain("a\\&quot;&lt;b&gt;&amp;");
  expect(html).not.toContain("<b>");
});

test("requests for another host are refused", () => {
  const { get, results } = routes();
  expect(get("/start", "evil.example:4123").status).toBe(403);
  expect(get("/callback?state=s3cret&code=c", "evil.example:4123").status).toBe(403);
  expect(results).toHaveLength(0);
});

test("the callback hands over the code and says what comes next", async () => {
  const { get, results } = routes();
  const html = await get("/callback?state=s3cret&code=abc").text();
  expect(results).toEqual([{ code: "abc" }]);
  expect(html).toContain("Your tapster App is created");
  expect(html).toContain("Pick your projects, never o/homebrew-tap.");
  expect(html).toContain("You can close this tab");
});

test("a callback with the wrong state or no code shows a failure and settles once", async () => {
  const wrong = routes();
  const html = await wrong.get("/callback?state=other&code=abc").text();
  expect("error" in wrong.results[0]!).toBe(true);
  expect(html).toContain("tapster init");
  expect(html).not.toContain("Your tapster App is created");
  wrong.get("/callback?state=s3cret&code=abc");
  expect(wrong.results).toHaveLength(1);

  const empty = routes();
  await empty.get("/callback?state=s3cret").text();
  expect("error" in empty.results[0]!).toBe(true);
});

test("other paths are not found", () => {
  expect(routes().get("/favicon.ico").status).toBe(404);
});
