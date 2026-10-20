import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"];

export type Page = {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  eval<T = unknown>(expr: string): Promise<T>;
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  clickText(text: string, selector?: string): Promise<void>;
  waitFor(expr: string, timeoutMs?: number): Promise<void>;
  shot(path: string, full?: boolean): Promise<void>;
  size(width: number, height: number, mobile?: boolean): Promise<void>;
  scheme(dark: boolean): Promise<void>;
  errors: string[];
  close(): void;
};

export async function launch(): Promise<Page> {
  const bin = CHROME.find((p) => Bun.file(p).size > 0);
  if (!bin) throw new Error("no Chrome found");
  const profile = mkdtempSync(join(tmpdir(), "tapster-qa-"));
  const proc = spawn(bin, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buf = "";
    proc.stderr.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) resolve(m[1]!);
    });
    setTimeout(() => reject(new Error("Chrome did not start")), 15000);
  });
  const port = new URL(wsUrl).port;
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const ws = new WebSocket(targets.find((t) => t.type === "page")!.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const errors: string[] = [];
  const events = new Map<string, ((p: unknown) => void)[]>();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
    if (msg.id !== undefined) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) w?.reject(new Error(msg.error.message));
      else w?.resolve(msg.result);
    } else if (msg.method) {
      for (const f of events.get(msg.method) ?? []) f(msg.params);
    }
  });
  const on = (name: string, f: (p: unknown) => void) => events.set(name, [...(events.get(name) ?? []), f]);
  const send = <T,>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const n = ++id;
      waiting.set(n, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  on("Runtime.consoleAPICalled", (p) => {
    const e = p as { type: string; args: { value?: unknown; description?: string }[] };
    if (e.type === "error" || e.type === "warning") errors.push(`console.${e.type}: ${e.args.map((a) => a.value ?? a.description).join(" ")}`);
  });
  on("Runtime.exceptionThrown", (p) => errors.push(`exception: ${JSON.stringify((p as { exceptionDetails: unknown }).exceptionDetails).slice(0, 400)}`));
  on("Log.entryAdded", (p) => {
    const e = (p as { entry: { level: string; text: string; url?: string } }).entry;
    if (e.level === "error") errors.push(`log: ${e.text} ${e.url ?? ""}`);
  });
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  const evaluate = async <T,>(expr: string): Promise<T> => {
    const r = await send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${expr.slice(0, 120)}: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result.value;
  };
  const waitFor = async (expr: string, timeoutMs = 10000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await evaluate<boolean>(`Boolean(${expr})`).catch(() => false)) return;
      await Bun.sleep(100);
    }
    throw new Error(`timed out waiting for ${expr}`);
  };
  return {
    send,
    eval: evaluate,
    errors,
    async goto(url) {
      await send("Page.navigate", { url });
      await Bun.sleep(300);
      await waitFor("document.readyState === 'complete'");
    },
    async click(selector) {
      await waitFor(`document.querySelector(${JSON.stringify(selector)})`);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
      await Bun.sleep(250);
    },
    async clickText(text, selector = "button, a, summary, label") {
      const find = `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.replace(/\\s+/g, " ").trim().includes(${JSON.stringify(text)}))`;
      await waitFor(find);
      await evaluate(`${find}.click()`);
      await Bun.sleep(250);
    },
    waitFor,
    async shot(path, full = true) {
      const { data } = await send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: full });
      writeFileSync(path, Buffer.from(data, "base64"));
    },
    async size(width, height, mobile = false) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile });
    },
    async scheme(dark) {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    },
    close() {
      ws.close();
      proc.kill();
    },
  };
}
