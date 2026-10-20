---
title: "Use tapster with an AI assistant"
description: "Connect tapster's MCP server and skills so an assistant can read your hub and explain a stuck release."
sidebar:
  order: 10
---

An AI assistant such as Claude Code can read your hub, its runs and your projects' releases through tapster's MCP
server. It can explain why a draft waits and start a hub run. It cannot set up a hub or touch your keys: those steps
need your clicks and your files, in `tapster setup`.

## The MCP server

`tapster mcp` serves tapster's tools on stdin and stdout. Add it to Claude Code:

```sh
claude mcp add tapster -- bunx @doguyilmaz/tapster mcp
```

Other assistants take the same command in their MCP settings: the command is `bunx` with the arguments
`@doguyilmaz/tapster mcp`.

| Tool | What it does |
| --- | --- |
| `hub_status` | Where the hub's setup stands, the projects it publishes and the open health issue. |
| `doctor` | The checks of `tapster doctor`, each with its fix. |
| `hub_runs` | The hub's latest runs with their result and log link. |
| `release_status` | A project's latest releases and drafts and what the hub wrote on a draft it will not publish. |
| `local_projects` | The clones of your repositories on this computer and whether the hub publishes them. |
| `run_hub` | Starts a hub run now. The only tool that changes anything. |

The tools use your GitHub CLI sign-in, like every tapster command. They find your hub from the folder the assistant runs
in or from your only hub; pass `hub` to pick another one.

## Skills

Two skills teach an assistant how tapster works: one to set up a hub or add a project, one to find out why a release
did not appear. Install them with:

```sh
bunx skills add doguyilmaz/tapster
```

Both tell the assistant never to ask you for a key or a password. Every step that needs one runs in tapster's own page
or prompts.
