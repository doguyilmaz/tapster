import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

export default defineConfig({
  site: "https://tapster.doguyilmaz.com",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "tapster",
      description: "Sign, notarize and publish the releases of all your projects from one Homebrew tap.",
      logo: { src: "./src/assets/logo-128.webp", alt: "" },
      favicon: "/favicon-32.png",
      head: [
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
        { tag: "link", attrs: { rel: "preload", href: "/fonts/geist.woff2", as: "font", type: "font/woff2", crossorigin: "" } },
        { tag: "link", attrs: { rel: "preload", href: "/fonts/geist-mono.woff2", as: "font", type: "font/woff2", crossorigin: "" } },
      ],
      social: [{ icon: "github", label: "tapster on GitHub", href: "https://github.com/doguyilmaz/tapster" }],
      customCss: ["./src/styles/theme.css"],
      components: { Hero: "./src/components/Hero.astro" },
      sidebar: [
        { label: "Tutorial", items: [{ autogenerate: { directory: "tutorial" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
      ],
      credits: false,
      plugins: [starlightLinksValidator()],
    }),
  ],
});
