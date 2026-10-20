import type { Problem as ProblemView } from "../contract";
import { account, accountError, loadAccount } from "./state";
import { useEffect } from "preact/hooks";
import { Cmd, Note, Problem, Spinner } from "./ui";

export function Waiting({ text }: { text: string }) {
  return (
    <div class="gate">
      <div class="row muted" role="status">
        <Spinner />
        <span>{text}</span>
      </div>
    </div>
  );
}

function Frame({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <>
      <div class="stripe" />
      <div class="gate">
        <div class="card">
          <img class="mascot" src="/logo.webp" alt="" width="112" height="112" />
          <h1 class="title">{title}</h1>
          {children}
        </div>
      </div>
    </>
  );
}

export function NoSession({ problem }: { problem: ProblemView | null }) {
  return (
    <Frame title={problem ? "This link did not open tapster setup" : "Open tapster setup from your terminal"}>
      {problem && <Problem problem={problem} />}
      <p class="lead">
        Each link from the terminal works once, so a copy of it in your history or someone else's hands is worthless. To get a fresh one, press Enter in the terminal where tapster setup runs.
      </p>
      <p class="muted">If tapster setup is not running, start it again:</p>
      <Cmd text="bunx @doguyilmaz/tapster setup" />
    </Frame>
  );
}

export function Stopped() {
  return (
    <Frame title="tapster setup stopped">
      <p class="lead">Everything you did is stored on GitHub. To continue later, start it again; it picks up where you left off.</p>
      <Cmd text="bunx @doguyilmaz/tapster setup" />
    </Frame>
  );
}

export function AccountGate() {
  const acc = account.value;
  useEffect(() => {
    let wait = 3000;
    let timer = 0;
    const tick = async () => {
      if (!document.hidden) await loadAccount();
      wait = Math.min(wait * 1.4, 15000);
      timer = window.setTimeout(tick, wait);
    };
    timer = window.setTimeout(tick, wait);
    return () => clearTimeout(timer);
  }, []);
  const checking = (
    <p class="row muted small">
      <Spinner /> tapster checks again by itself every few seconds.
    </p>
  );
  if (accountError.value) {
    return (
      <Frame title="tapster could not reach GitHub">
        <Problem problem={accountError.value} />
        {checking}
      </Frame>
    );
  }
  if (acc?.state === "no-gh") {
    return (
      <Frame title="Install the GitHub CLI">
        <p class="lead">tapster talks to GitHub through the GitHub CLI, so your sign-in stays with it and tapster never sees a password.</p>
        <Cmd text="brew install gh" />
        <p class="muted small">
          Not on a Mac? See <a href="https://cli.github.com" target="_blank" rel="noopener noreferrer">cli.github.com</a>. Then sign in:
        </p>
        <Cmd text="gh auth login" />
        {checking}
      </Frame>
    );
  }
  if (acc?.state === "signed-out") {
    return (
      <Frame title="Sign in to GitHub">
        <p class="lead">Run this in a terminal and follow its steps. tapster uses that sign-in to set up your hub; it never sees your password.</p>
        <Cmd text="gh auth login" />
        {checking}
      </Frame>
    );
  }
  const missing = acc?.state === "ok" ? acc.missing : [];
  return (
    <Frame title="Allow gh to change workflows">
      <p class="lead">
        Your GitHub CLI sign-in lacks {missing.join(" and ")}. tapster needs it to write the hub's workflow file.
      </p>
      <Cmd text={`gh auth refresh -s ${missing.join(",")}`} />
      <Note tone="keys">
        <span>The sign-in stays in the GitHub CLI on this computer. tapster asks it for a token each time and keeps nothing.</span>
      </Note>
      {checking}
    </Frame>
  );
}

