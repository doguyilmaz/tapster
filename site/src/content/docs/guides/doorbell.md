---
title: "Faster releases"
description: "Deploy the doorbell so the hub starts within a minute of each release."
sidebar:
  order: 5
---

The hub looks for new drafts every 10 minutes. GitHub runs these schedules best-effort, so a release can wait
longer. The **doorbell** starts the hub as soon as a project opens its draft. It is a small Cloudflare Worker on the free
plan, deployed to your own Cloudflare account.

## What you need

- A Cloudflare account with a `workers.dev` subdomain. Create the subdomain once in the Cloudflare dashboard under
  **Workers & Pages**.
- Node.js 20 or newer, which Cloudflare's Wrangler needs.

## Deploy it

In an up-to-date clone of your hub, so tapster sees every project in `tapster.yml`:

```sh
git pull
bunx @doguyilmaz/tapster init --doorbell
```

1. If Wrangler is not signed in, Cloudflare's sign-in page opens. Sign in and allow Wrangler.
2. tapster opens a page that explains the **doorbell App**, a second GitHub App that may only start the hub's workflow
   and turn it back on.
   Click **Continue to GitHub**, then **Create GitHub App**.
3. On the install page, choose **Only select repositories** and pick the hub, only the hub. Click **Install**.

:::caution[tapster waits here]{icon="clock"}
`Waiting until the App is installed on you/homebrew-tap (only that repository); tapster continues by itself.`

tapster checks for up to 10 minutes. If it stops before you install, install the App on the hub and run
`tapster init --doorbell` again. It continues with the App it already created and asks you for a new private key from
the App's settings page.
:::

tapster then deploys the Worker, stores the App's key in it and tells every project in `tapster.yml` the doorbell's
address.

:::tip[You should see]{icon="approve-check-circle"}
`The doorbell answers at https://tapster-doorbell.<subdomain>.workers.dev. Projects ring it after opening a draft.`
:::

:::note[Where your keys go]{icon="padlock"}
The doorbell App's private key goes from your terminal to the Worker in your own Cloudflare account and nowhere else.
The Worker uses it only to start the hub's workflow and to turn it back on when GitHub pauses it.
:::

## How a project rings it

`tapster add` puts a step named **Ring the tapster hub** in every release workflow. It runs only when the project has
the doorbell's address, so projects you added before the doorbell ring it without a change. The step sends a
short-lived token from GitHub that proves which repository and tag it comes from. The Worker checks that token and
starts the hub.

The Worker also starts the hub on its own schedule when no run started in that time. When GitHub pauses the hub's
workflow for inactivity, the Worker turns it back on. A workflow you disabled yourself stays off.

## Rotate its key

```sh
bunx @doguyilmaz/tapster init --rotate doorbell
```

tapster asks for a new private key from the doorbell App's settings page and deploys the Worker again with it. Delete
every older key on that page afterwards. Run the same command after [upgrading tapster](/guides/upgrade/), so the Worker
runs the same version and schedule as the hub.

## Limits

- The Worker is always named `tapster-doorbell`, so one Cloudflare account serves the doorbell of one hub.
