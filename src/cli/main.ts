#!/usr/bin/env bun
import { TapsterError } from "../errors";
import { add } from "./add";
import { doctor } from "./doctor";
import { init } from "./init";
import { TAPSTER } from "../version";
import { PORT, setup } from "../web/start";
import { mcp } from "../mcp/server";

const usage = `tapster: publish your projects' releases from one Homebrew tap

  tapster setup       open the setup in your browser: the hub, your projects and their health
  tapster init        set up this hub clone; run it again to finish or repair the setup
  tapster add         prepare this project clone and propose it to the hub
  tapster doctor      check the hub's setup and name the fix for each finding
  tapster mcp         serve tapster's tools to an AI assistant over MCP (stdio)
  tapster --version   show this tapster and the commit it pins hubs to

Run tapster <command> --help for the options: Sparkle and Linux keys, the doorbell, rotations and more.`;

const help: Record<string, string> = {
  setup: `tapster setup: set up the hub and add your projects in your browser

  tapster setup [--no-open] [--port <port>] [--tapster <commit>]
    --no-open    print the link instead of opening the browser
    --port       listen on this port instead of ${PORT}
    --tapster    pin the hub workflow to this commit (for a tapster built from a checkout)

  The page runs on this computer only and works until you stop tapster setup with Ctrl+C.`,
  init: `tapster init: set up the hub in this clone; every step can run again and skips what is done

  tapster init [--every <minutes>] [--tapster <commit>]
  tapster init --rotate app|certificate|notary|doorbell|linux
  tapster init --rotate linux --finish   stop signing with the previous Linux key
  tapster init --sparkle <label> [--account <account>]
                               store a Sparkle key from your keychain in the hub
  tapster init --sparkle <label> --new
                               make a Sparkle key, keep it in your keychain and store it in the hub
  tapster init --doorbell      deploy the Worker that starts the hub when a project releases
  tapster init --linux         make the key for the apt and dnf repositories
  tapster init --workflow [--every <minutes>] [--tapster <commit>]
                               rewrite the hub workflow, pinned to this tapster

  The doorbell asks for a Cloudflare API token with a hidden prompt. Set CLOUDFLARE_API_TOKEN to skip it.`,
  add: `tapster add: prepare this project clone and propose it to the hub

  tapster add [--hub owner/repo] [--workflow file.yml] [--auto-tag] [--allow-dependabot] [--force]
    --hub               the hub that publishes this project (remembered in git config)
    --workflow          the workflow that runs GoReleaser, if not release.yml
    --auto-tag          let the project's release workflow push tags with a deploy key
    --allow-dependabot  leave branches named dependabot/... open so Dependabot can open pull requests
    --force             replace an existing release workflow`,
  doctor: `tapster doctor: check the hub's setup on GitHub and name the command that fixes each finding

  tapster doctor`,
  mcp: `tapster mcp: serve tapster's tools to an AI assistant over MCP, on stdin and stdout

  claude mcp add tapster -- bunx @doguyilmaz/tapster mcp

  The tools read the hub, its runs, a project's releases and the projects on this computer. One of them starts a hub run.
  They use your GitHub CLI sign-in and never touch your keys.`,
};

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "--version" || cmd === "-v") {
    console.log(`tapster ${TAPSTER.version} (${TAPSTER.sha ? TAPSTER.sha.slice(0, 12) : "built from a checkout; init --workflow needs --tapster <commit>"})`);
  } else if (cmd && help[cmd] && (args[0] === "--help" || args[0] === "-h")) console.log(help[cmd]);
  else if (cmd === "setup") await setup(args);
  else if (cmd === "mcp") await mcp(args);
  else if (cmd === "init") await init(args);
  else if (cmd === "add") await add(args);
  else if (cmd === "doctor") {
    if (args.length) throw new TapsterError(`unknown option ${args.join(" ")}`, "tapster doctor takes no options.");
    process.exitCode = await doctor(args);
  } else {
    console.log(usage);
    process.exitCode = cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0;
  }
} catch (e) {
  console.error(e instanceof TapsterError ? `tapster: ${e.reason}\n  ${e.fix}` : "tapster: unexpected error");
  process.exitCode = 1;
}
