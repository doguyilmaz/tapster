import { frame, rel, type NavItem } from "./layout";

const CSS = `
.home { max-width: 1180px; margin: 0 auto; padding: 0 clamp(16px, 3vw, 32px) 4rem; }
.hero { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.95fr); gap: clamp(2.5rem, 6vw, 5.5rem); align-items: center; padding: clamp(3rem, 8vw, 6.5rem) 0 clamp(3.5rem, 7vw, 6rem); }
.hero h1 { font-size: clamp(2.6rem, 5.4vw, 4.6rem); font-stretch: 125%; font-weight: 850; line-height: 0.96; letter-spacing: -0.03em; margin: 0 0 1.5rem; }
.lead { font-size: 1.22rem; line-height: 1.55; color: var(--muted); max-width: 31em; margin: 0 0 2rem; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 1rem 1.6rem; }
.actions a:not(.button) { font-weight: 650; }

.parcel { position: relative; padding: 8.2rem 1.4rem 3rem 0; }
.label { --l-ink: #17204a; --l-muted: #5d6585; --l-rule: #cdd3e6; position: relative; color: var(--l-ink); background: #fffefa; border: 11px solid transparent; border-image: repeating-linear-gradient(-45deg, #c4312b 0 13px, #fffefa 13px 19px, #17204a 19px 32px, #fffefa 32px 38px) 11; transform: rotate(-2.2deg); box-shadow: 0 30px 60px -28px rgba(10, 18, 52, 0.55), 0 2px 6px rgba(10, 18, 52, 0.12); }
.sheet { border: 1.5px solid var(--l-ink); padding: 1rem 1.2rem 1.1rem; }
.sheet header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 0.7rem; margin-bottom: 0.3rem; border-bottom: 2px solid var(--l-ink); font-weight: 850; font-stretch: 122%; font-size: 1.05rem; }
.sheet dl { display: grid; grid-template-columns: 6.6rem minmax(0, 1fr); margin: 0; }
.sheet dt, .sheet dd { margin: 0; padding: 0.5rem 0; border-bottom: 1px dashed var(--l-rule); }
.sheet dt { color: var(--l-muted); font-stretch: 92%; font-weight: 600; font-size: 0.9rem; }
.sheet dd { font-weight: 650; font-size: 0.98rem; overflow-wrap: anywhere; }
.sheet dd code { font-size: 0.86rem; background: none; border: 0; padding: 0; color: var(--l-ink); }
.code-bar { margin-top: 0.9rem; }
.code-bar svg { display: block; width: 100%; height: 46px; }
.code-bar p { margin: 0.35rem 0 0; font-stretch: 90%; font-size: 0.8rem; color: var(--l-muted); letter-spacing: 0.06em; }
.courier { position: absolute; width: 29%; max-width: 180px; right: 2%; top: 0; border-radius: 22%; transform: rotate(5deg); box-shadow: 0 22px 40px -20px rgba(10, 18, 52, 0.6); }
.seal { position: absolute; width: 104px; right: 13%; bottom: 0; transform: rotate(-9deg); filter: drop-shadow(0 6px 8px rgba(80, 10, 10, 0.35)); animation: stamp 0.55s cubic-bezier(0.2, 0.9, 0.25, 1) 0.4s both; }
@keyframes stamp { from { transform: scale(1.7) rotate(-26deg); opacity: 0; } to { transform: scale(1) rotate(-9deg); opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .seal { animation: none; } }

.band { padding: clamp(3rem, 7vw, 5.5rem) 0; border-top: 1px solid var(--line); }
.band h2 { font-size: clamp(1.9rem, 3.6vw, 2.7rem); font-stretch: 120%; font-weight: 850; letter-spacing: -0.02em; margin: 0 0 1rem; }
.band > p, .band .intro { color: var(--muted); font-size: 1.1rem; max-width: 36em; }

.travels { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 0.95fr); gap: clamp(2.5rem, 6vw, 5rem); align-items: center; }
.route { list-style: none; padding: 0; margin: 2rem 0 0; }
.route li { position: relative; margin: 0; padding: 0 0 1.5rem 2.6rem; }
.route li::before { content: ""; position: absolute; left: 0; top: 0.3rem; width: 16px; height: 16px; border-radius: 50%; background: var(--navy); box-shadow: 0 0 0 4px var(--page); }
.route li::after { content: ""; position: absolute; left: 7px; top: 1.3rem; bottom: 0.1rem; width: 2px; background: var(--line); }
.route li:last-child { padding-bottom: 0; }
.route li:last-child::before { background: var(--orange); }
.route li:last-child::after { display: none; }
.route strong { display: block; font-size: 1.12rem; font-stretch: 112%; }
.route span { color: var(--muted); }
.route em { display: block; font-style: normal; font-size: 0.88rem; color: var(--link); font-weight: 600; margin-top: 0.15rem; }
.travels img { width: 100%; height: auto; border-radius: 28px; box-shadow: 0 30px 60px -32px rgba(10, 18, 52, 0.55); }

.keys { display: grid; grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr); gap: clamp(2rem, 6vw, 5rem); }
.keys dl { margin: 0; display: grid; gap: 1.5rem; }
.keys dt { font-size: 1.12rem; font-weight: 750; font-stretch: 112%; padding-left: 1rem; border-left: 3px solid var(--wax); }
.keys dd { margin: 0.3rem 0 0; padding-left: calc(1rem + 3px); color: var(--muted); }

.dest { list-style: none; padding: 0; margin: 2rem 0 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border-top: 2px solid var(--navy); }
.dest li { margin: 0; padding: 1rem 1.2rem 0.4rem 0; }
.dest li + li { padding-left: 1.2rem; border-left: 1px solid var(--line); }
.dest strong { display: block; font-size: 1.1rem; font-stretch: 112%; margin-bottom: 0.2rem; }
.dest span { color: var(--muted); font-size: 0.95rem; }

.start { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 1.5rem 3rem; }
.start h2 { margin-bottom: 0.4rem; }
.start p { margin: 0; color: var(--muted); max-width: 38em; }

@media (max-width: 900px) {
  .hero, .travels, .keys { grid-template-columns: minmax(0, 1fr); }
  .parcel { max-width: 560px; }
  .dest { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dest li, .dest li + li { padding: 1rem 0.8rem 0.6rem 0; border-left: 0; border-bottom: 1px solid var(--line); }
}
@media (max-width: 520px) {
  .sheet dl { grid-template-columns: 5.6rem minmax(0, 1fr); }
  .courier { width: 38%; top: -4%; }
  .seal { width: 84px; }
}
`;

function barcode(hex: string): string {
  let x = 0;
  const bars: string[] = [];
  for (const ch of hex) {
    const v = Number.parseInt(ch, 16);
    const w = 1 + (v % 3);
    bars.push(`<rect x="${x}" width="${w}" height="46"/>`);
    x += w + 1 + ((v >> 2) % 2);
  }
  return `<svg viewBox="0 0 ${x} 46" preserveAspectRatio="none" aria-hidden="true"><g fill="#17204a">${bars.join("")}</g></svg>`;
}

function seal(): string {
  const n = 120;
  let d = "";
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    const r = 46 + 3.2 * Math.sin(5 * t + 0.7) + 1.8 * Math.sin(8 * t + 2.1) + 1 * Math.sin(13 * t);
    d += `${i ? "L" : "M"}${(50 + r * Math.cos(t)).toFixed(1)},${(50 + r * Math.sin(t)).toFixed(1)}`;
  }
  return `<svg class="seal" viewBox="0 0 100 100" role="img" aria-label="Wax seal: signed">
<defs><radialGradient id="wax" cx="0.36" cy="0.3" r="0.8"><stop offset="0" stop-color="#ef6a55"/><stop offset="0.6" stop-color="#c4312b"/><stop offset="1" stop-color="#8e1f1a"/></radialGradient></defs>
<path d="${d}Z" fill="url(#wax)"/>
<circle cx="50" cy="50" r="31" fill="#b02a24"/>
<circle cx="50" cy="50" r="31" fill="none" stroke="#f08872" stroke-opacity="0.55" stroke-width="1.6" transform="translate(-0.8 -1)"/>
<path d="M36 51 l9 9 l19 -21" fill="none" stroke="#ffd6cc" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

export function homePage(nav: NavItem[]): string {
  const at = (id: string) => rel("", id);
  const first = nav.find((n) => n.step === 1)!;
  const sha = "9f2c41d07b3ea1655c0de8f4b2a97e31c6d58f0a2b4e7c913d6af05e8b21e41a";
  return frame({
    id: "",
    title: "tapster: your releases, signed and sealed",
    description: "tapster turns your Homebrew tap into the one place that signs, notarizes and publishes the releases of all your projects. Your keys stay in your own accounts.",
    css: CSS,
    nav,
    side: false,
    main: `<main class="home">
<section class="hero">
<div>
<h1>Your releases, signed and sealed.</h1>
<p class="lead">tapster turns your Homebrew tap into the one place that signs, notarizes and publishes the releases of all your projects. Your keys stay in your own accounts.</p>
<div class="actions"><a class="button" href="${at(first.id)}">Start the tutorial</a><a href="${at("reference/security")}">How your keys are kept</a></div>
</div>
<div class="parcel">
<div class="label">
<div class="sheet">
<header><span>tapster</span></header>
<dl>
<dt>From</dt><dd>you/my-tool</dd>
<dt>To</dt><dd><code>brew install you/tap/my-tool</code></dd>
<dt>Contents</dt><dd>my-tool 1.4.0, five archives</dd>
<dt>Signed</dt><dd>Developer ID Application: You</dd>
<dt>Notarized</dt><dd>Accepted by Apple</dd>
</dl>
<div class="code-bar">${barcode(sha)}<p>sha256 ${sha.slice(0, 8)} ${sha.slice(8, 16)} ${sha.slice(-8)}</p></div>
</div>
</div>
<img class="courier" src="assets/courier.webp" width="260" height="260" alt="The tapster octopus in a courier cap, carrying sealed parcels">
${seal()}
</div>
</section>

<section class="band travels">
<div>
<h2>How a release travels</h2>
<p class="intro">Each project keeps building its own release. The hub does everything that needs a key.</p>
<ol class="route">
<li><strong>Tag pushed</strong><span>You push v1.4.0 in the project.</span><em>In your project</em></li>
<li><strong>Draft opened</strong><span>The project's workflow builds the archives, attests them and opens a draft release.</span><em>In your project, which holds no keys</em></li>
<li><strong>Checked</strong><span>The hub matches every file against <code>checksums.txt</code> and its build attestation.</span><em>In your hub</em></li>
<li><strong>Signed and notarized</strong><span>The hub signs the macOS code with your Developer ID. Apple notarizes it.</span><em>In your hub</em></li>
<li><strong>Delivered</strong><span>The release is published and the cask is written. <code>brew install</code> gets the signed build.</span><em>On your users' machines</em></li>
</ol>
</div>
<img src="assets/hero.webp" width="600" height="600" loading="lazy" alt="The tapster octopus takes builds from several projects and sends them out as sealed parcels">
</section>

<section class="band keys">
<div>
<h2>Your keys stay in your accounts</h2>
<p class="intro">Your keys go from your computer to your own GitHub repository and nowhere else. No one else, including tapster's author, ever receives them.</p>
<a href="${at("reference/security")}">Read the security model</a>
</div>
<dl>
<div><dt>No tapster server</dt><dd>tapster is a command you run and an Action that runs in your hub. The optional doorbell runs in your own Cloudflare account.</dd></div>
<div><dt>One place for keys</dt><dd>Your Apple certificate, notary key and App key are secrets of your hub. Only its main branch can open them.</dd></div>
<div><dt>A stolen key is not enough</dt><dd>Only you can tag your projects. The hub signs only drafts that your own workflows built.</dd></div>
</dl>
</section>

<section class="band">
<h2>Where it delivers</h2>
<ul class="dest">
<li><strong>Homebrew</strong><span>Casks with signed, notarized builds</span></li>
<li><strong>Scoop</strong><span>Manifests for Windows builds</span></li>
<li><strong>apt</strong><span>Signed packages from your Pages site</span></li>
<li><strong>dnf</strong><span>Signed rpms from the same site</span></li>
<li><strong>Sparkle</strong><span>Updates inside your Mac app</span></li>
</ul>
</section>

<section class="band start">
<div>
<h2>Set up your hub</h2>
<p>You need a GitHub account, Bun and the GitHub CLI. Signing for macOS also needs an Apple Developer account.</p>
</div>
<a class="button" href="${at(first.id)}">Start the tutorial</a>
</section>
</main>`,
  });
}
