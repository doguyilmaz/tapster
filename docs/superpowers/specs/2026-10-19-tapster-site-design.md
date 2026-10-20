# tapster site and setup pages

## Goal

A person who has never heard of tapster can set up a hub and ship a signed release by following the site step by
step. Every page that touches a key says where it goes: nothing leaves the user's own GitHub, Apple, Cloudflare and npm
accounts. No one else ever receives it. The pages tapster opens in the browser during setup say what just happened
and what comes next.

## Rules

- Each step says what to do, what you should see and what tapster just did. Every wait the CLI has is described.
- Short pages. No marketing, no filler, no repeated explanations: a page links to the one place that explains a thing.
- Public text follows the writing rules: no em dashes, no comma before "and" or "or", no exaggeration.
- No framework and no dependency. Pages work without JavaScript.

## One look for both

`src/ui/` holds the logo, the colour tokens, the CSS and a page shell. The site builder and the CLI both import it, so
the setup pages look like the site. The logo is one SVG in `src/ui/logo.ts`; replacing it changes every page. Light
theme by default, dark when the system asks for it.

## Setup pages (served by the CLI on 127.0.0.1)

- `/start` explains the App GitHub is about to create: its name, what it may do (from the manifest), that its key comes
  back only to this terminal and is stored in the user's own hub. One button posts the manifest to GitHub. No script.
- `/callback` shows success with the next step from the terminal (install the App, which repositories to pick). When the answer does not match (state or missing code) it shows a
  failure page with what to run again.
- Responses carry a strict Content-Security-Policy (no scripts, forms only to github.com, no outside resources) and
  `Cache-Control: no-store`.

## Site

Markdown files in `site/content/` with a small header (`title`, `section`, `order`). The builder renders them with
`Bun.markdown`, adds the sidebar, the step counter and the links to the previous and next page. Marked quotes become callouts:
`[!SEE]` what you should see, `[!WAIT]` tapster waits here, `[!KEYS]` where a key goes, `[!NOTE]`, `[!WARN]`. The build
fails on a link to a page that does not exist.

Sections and pages:

- Start here: Home; Tutorial in five steps (Before you start, Apple credentials, Create the hub, Add a project, First
  release).
- Guides: Move a GoReleaser project, Bun projects, macOS apps with Sparkle, apt and dnf, Faster releases (doorbell),
  Releases tagged by a workflow, Dependabot, Rotate a key, Upgrade tapster.
- Reference: Commands, tapster.yml, Security, Troubleshooting.

The README becomes the short version (what it is, install, quick start, links into the site). It is also the GitHub
Marketplace page.

## Later

Logo final pick, GitHub Marketplace listing, the tapster.doguyilmaz.com domain, the local setup web UI.
