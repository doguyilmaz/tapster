import { LOGO_URI } from "../src/ui/page";
import { frame, rel, type NavItem } from "./layout";

const CSS = `
.home { max-width: 1040px; margin: 0 auto; padding: 0 clamp(16px, 3vw, 32px) 4rem; }
.hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 3rem; padding: clamp(2.5rem, 7vw, 5.5rem) 0 clamp(2rem, 5vw, 3.5rem); }
.hero h1 { font-size: clamp(2rem, 4.6vw, 3.1rem); line-height: 1.12; letter-spacing: -0.03em; margin: 0 0 1.1rem; max-width: 16em; }
.hero p { font-size: 1.15rem; color: var(--muted); max-width: 34em; margin: 0 0 1.8rem; }
.hero img { width: clamp(120px, 18vw, 200px); height: auto; }
.actions { display: flex; flex-wrap: wrap; gap: 0.8rem 1.4rem; align-items: center; }
.actions a:not(.button) { font-weight: 600; text-decoration: none; }
.flow { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; counter-reset: flow; margin: 0 0 3.5rem; }
.flow div { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 1.2rem 1.3rem; position: relative; }
.flow h3 { margin: 0 0 0.4rem; font-size: 1.05rem; }
.flow h3::before { counter-increment: flow; content: counter(flow); display: inline-grid; place-items: center; width: 1.6rem; height: 1.6rem; margin-right: 0.55rem; border-radius: 50%; background: var(--button); color: var(--button-fg); font-size: 0.85rem; }
.flow p { margin: 0; color: var(--muted); font-size: 0.97rem; }
.home h2 { font-size: 1.5rem; margin: 0 0 1rem; }
.trust { background: var(--keys-bg); border: 1px solid color-mix(in srgb, var(--keys) 22%, transparent); border-radius: 16px; padding: 1.6rem 1.7rem; margin: 0 0 3.5rem; }
.trust ul { list-style: none; padding: 0; margin: 0 0 1rem; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.4rem; }
.trust li strong { display: block; margin-bottom: 0.25rem; }
.trust li { color: var(--muted); font-size: 0.97rem; margin: 0; }
.trust li strong { color: var(--fg); }
.covers { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 0.8rem; list-style: none; padding: 0; margin: 0 0 3.5rem; }
.covers li { border: 1px solid var(--line); border-radius: 12px; padding: 0.9rem 1rem; margin: 0; background: var(--surface); }
.covers li span { display: block; color: var(--muted); font-size: 0.9rem; }
.start { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 1rem; border-top: 1px solid var(--line); padding-top: 2rem; }
.start p { margin: 0; color: var(--muted); max-width: 36em; }
@media (max-width: 760px) {
  .hero { grid-template-columns: 1fr; gap: 1.5rem; }
  .hero img { order: -1; width: 88px; }
  .flow, .trust ul { grid-template-columns: 1fr; }
}
`;

export function homePage(nav: NavItem[]): string {
  const at = (id: string) => rel("", id);
  const first = nav.find((n) => n.step === 1)!;
  return frame({
    id: "",
    title: "tapster: sign, notarize and publish your releases from one Homebrew tap",
    description: "tapster turns your Homebrew tap into the one place that signs, notarizes and publishes the releases of all your projects.",
    css: CSS,
    nav,
    side: false,
    main: `<main class="home">
<section class="hero">
<div>
<h1>Sign, notarize and publish every release from your Homebrew tap</h1>
<p>Your projects build their files and open a draft release. Your tap signs them, has Apple notarize them and publishes the release with its Homebrew cask. Your signing keys stay in your own accounts.</p>
<div class="actions"><a class="button" href="${at(first.id)}">Start the tutorial</a><a href="${at("reference/security")}">How your keys are kept</a></div>
</div>
<img src="${LOGO_URI}" alt="">
</section>

<section class="flow" aria-label="How a release travels">
<div><h3>Your project</h3><p>You push a tag. The project's workflow builds the files, attests them and opens a draft release. It holds no keys.</p></div>
<div><h3>Your hub</h3><p>Your tap checks every file the project built. Then it signs, notarizes and publishes the release.</p></div>
<div><h3>Your users</h3><p>They install with Homebrew, Scoop, apt or dnf. People who use your Mac app get the update inside it.</p></div>
</section>

<section class="trust">
<h2>Your keys stay in your accounts</h2>
<ul>
<li><strong>No tapster server</strong>tapster is a command you run and a GitHub Action that runs in your hub. The optional doorbell runs in your own Cloudflare account.</li>
<li><strong>One place for keys</strong>Your Apple certificate, notary key and App key are secrets of your hub. Only its main branch can open them.</li>
<li><strong>A stolen key is not enough</strong>Only you can create or move tags in your projects. The hub signs only drafts that your project's own workflow built.</li>
</ul>
<a href="${at("reference/security")}">Read the security model</a>
</section>

<h2>What it publishes</h2>
<ul class="covers">
<li><strong>Go tools</strong><span>built with GoReleaser</span></li>
<li><strong>Bun tools</strong><span>compiled for five platforms</span></li>
<li><strong>Mac apps</strong><span>with Sparkle updates and a DMG</span></li>
<li><strong>apt and dnf</strong><span>from your hub's GitHub Pages</span></li>
<li><strong>Scoop</strong><span>for Windows builds</span></li>
</ul>

<section class="start">
<p>You need a GitHub account, Bun and the GitHub CLI. Signing for macOS also needs an Apple Developer account. The tutorial walks you from an empty tap to an installed release.</p>
<a class="button" href="${at(first.id)}">Start the tutorial</a>
</section>
</main>`,
  });
}
