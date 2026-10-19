import { expect, test } from "bun:test";
import { commitToHub } from "../src/hubcommit";
import { GitHub } from "../src/github";

function hubFake(conflicts: number) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let left = conflicts;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const path = new URL(url).pathname + new URL(url).search;
    if (path.startsWith("/repos/o/hub/git/ref/heads/main")) return Response.json({ object: { sha: "head1" } });
    if (path.startsWith("/repos/o/hub/git/commits/head1")) return Response.json({ tree: { sha: "tree1" } });
    if (path.startsWith("/repos/o/hub/contents/")) return new Response(null, { status: 404 });
    if (path === "/repos/o/hub/git/trees") return Response.json({ sha: "tree2" }, { status: 201 });
    if (path === "/repos/o/hub/git/commits") return Response.json({ sha: "commit2" }, { status: 201 });
    if (path === "/repos/o/hub/git/refs/heads/main") {
      if (left-- > 0) return new Response(null, { status: 422 });
      return Response.json({ object: { sha: "commit2" } });
    }
    return new Response(null, { status: 500 });
  };
  return { gh: new GitHub("t", fetchImpl, async () => {}), calls };
}

test("commits through the Git Data API and retries a moved branch", async () => {
  const f = hubFake(1);
  const result = await commitToHub(f.gh, "o/hub", "aims v1.0.0", async (read) => {
    expect(await read(".tapster/state.json")).toBeNull();
    return [{ path: "Casks/aims.rb", content: "cask" }];
  });
  expect(result).toBe("committed");
  const patches = f.calls.filter((c) => c.method === "PATCH");
  expect(patches.length).toBe(2);
  expect(patches[1]!.body).toEqual({ sha: "commit2", force: false });
});

test("no changes, no commit", async () => {
  const f = hubFake(0);
  expect(await commitToHub(f.gh, "o/hub", "x", async () => [])).toBe("unchanged");
  expect(f.calls.some((c) => c.method === "POST")).toBe(false);
});
