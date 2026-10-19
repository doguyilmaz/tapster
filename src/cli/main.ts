#!/usr/bin/env bun
import { TapsterError } from "../errors";
import { add } from "./add";
import { doctor } from "./doctor";
import { init } from "./init";
import { TAPSTER } from "../version";

const usage = `tapster: publish your projects' releases from one Homebrew tap

  tapster init                 set up this hub clone (run once)
  tapster init --sparkle <label> [--account <account>]
                               store a Sparkle key from the login keychain
  tapster init --doorbell      deploy the Worker that starts the hub when a project releases
  tapster init --linux         make the key for the apt and dnf repositories
  tapster init --workflow [--tapster <commit>]
                               rewrite the hub workflow, pinned to this tapster
  tapster init --rotate app|certificate|notary|doorbell|linux
  tapster add                  prepare this project clone for the hub
  tapster doctor               check the hub's setup
  tapster --version            show this tapster and the commit it pins hubs to`;

const help: Record<string, string> = {
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
                               rewrite the hub workflow, pinned to this tapster`,
  add: `tapster add: prepare this project clone and propose it to the hub

  tapster add [--hub owner/repo] [--workflow file.yml] [--auto-tag] [--allow-dependabot] [--force]
    --hub               the hub that publishes this project (remembered in git config)
    --workflow          the workflow that runs GoReleaser, if not release.yml
    --auto-tag          let the project's release workflow push tags with a deploy key
    --allow-dependabot  leave branches named dependabot/... open so Dependabot can open pull requests
    --force             replace an existing release workflow`,
  doctor: `tapster doctor: check the hub's setup on GitHub and name the command that fixes each finding

  tapster doctor`,
};

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "--version" || cmd === "-v") {
    console.log(`tapster ${TAPSTER.version} (${TAPSTER.sha ? TAPSTER.sha.slice(0, 12) : "built from a checkout; init --workflow needs --tapster <commit>"})`);
  } else if (cmd && help[cmd] && (args[0] === "--help" || args[0] === "-h")) console.log(help[cmd]);
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
