#!/usr/bin/env bun
import { TapsterError } from "../errors";
import { add } from "./add";
import { doctor } from "./doctor";
import { init } from "./init";

const usage = `tapster: publish your projects' releases from one Homebrew tap

  tapster init                 set up this hub clone (run once)
  tapster init --rotate app|certificate|notary
  tapster add                  prepare this project clone for the hub
  tapster doctor               check the hub's setup`;

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "init") await init(args);
  else if (cmd === "add") await add(args);
  else if (cmd === "doctor") process.exitCode = await doctor(args);
  else {
    console.log(usage);
    process.exitCode = cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0;
  }
} catch (e) {
  console.error(e instanceof TapsterError ? `tapster: ${e.reason}\n  ${e.fix}` : "tapster: unexpected error");
  process.exitCode = 1;
}
