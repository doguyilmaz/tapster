import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  upload(selector: string, path: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  errors: string[];
  close(): Promise<void>;
};

export async function launch(): Promise<Page> {
  const bin = CHROME.find((p) => Bun.file(p).size > 0);
  if (!bin) throw new Error("no Chrome found");
  const profile = mkdtempSync(join(tmpdir(), "tapster-qa-"));
  // This profile contains synthetic test data only. In particular, a temporary HOME
  // must never make Chrome ask to reset the user's real macOS login keychain.
  const proc = spawn(bin, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--disable-background-networking", "--disable-sync", ...(process.platform === "darwin" ? ["--use-mock-keychain"] : ["--password-store=basic"]), "about:blank"], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let ws: WebSocket | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (proc.pid) try { process.kill(-proc.pid, signal); } catch { /* already closed */ }
  };
  const cleanup = () => {
    kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  };
  const interrupted = () => { cleanup(); process.exit(1); };
  process.once("exit", cleanup);
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    ws?.close();
    kill("SIGTERM");
    await Bun.sleep(150);
    cleanup();
    process.off("exit", cleanup);
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
  })();
  try {
    const wsUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("Chrome did not start")), 15000);
      let buf = "";
      const done = (error?: Error, url?: string) => {
        clearTimeout(timer);
        proc.stderr.off("data", data);
        proc.off("error", failed);
        proc.off("exit", exited);
        error ? reject(error) : resolve(url!);
      };
      const failed = () => done(new Error("Chrome could not be launched"));
      const exited = () => done(new Error("Chrome exited before it was ready"));
      const data = (d: Buffer) => {
        buf = (buf + d.toString()).slice(-32_000);
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
        if (m) done(undefined, m[1]!);
      };
      proc.stderr.on("data", data);
      proc.once("error", failed);
      proc.once("exit", exited);
    });
    const port = new URL(wsUrl).port;
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(10000) })).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const target = targets.find((t) => t.type === "page");
    if (!target) throw new Error("Chrome has no test page");
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome debugger did not connect")), 10000);
      ws!.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws!.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Chrome debugger could not connect")); }, { once: true });
    });
    return await connect(ws, close);
  } catch (e) {
    await close();
    throw e;
  }
}

async function connect(ws: WebSocket, close: () => Promise<void>): Promise<Page> {
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
  ws.addEventListener("close", () => {
    for (const w of waiting.values()) w.reject(new Error("Chrome debugger closed"));
    waiting.clear();
  });
  const send = <T,>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => { waiting.delete(n); reject(new Error(`Chrome debugger timed out: ${method}`)); }, 15000);
      waiting.set(n, { resolve: (value) => { clearTimeout(timer); resolve(value as T); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      if (ws.readyState !== WebSocket.OPEN) { waiting.get(n)!.reject(new Error("Chrome debugger is not connected")); waiting.delete(n); }
      else ws.send(JSON.stringify({ id: n, method, params }));
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
    async upload(selector, path) {
      const { root } = await send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: -1 });
      const { nodeId } = await send<{ nodeId: number }>("DOM.querySelector", { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error(`no ${selector}`);
      await send("DOM.setFileInputFiles", { nodeId, files: [path] });
      await Bun.sleep(200);
    },
    async type(selector, text) {
      await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); })()`);
      await send("Input.insertText", { text });
      await Bun.sleep(100);
    },
    async scheme(dark) {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    },
    close,
  };
}
