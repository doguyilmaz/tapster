export class TapsterError extends Error {
  constructor(readonly reason: string, readonly fix: string) {
    super(reason);
    this.name = "TapsterError";
  }
}

export class GitHubError extends TapsterError {
  constructor(reason: string, fix: string, readonly status: number) {
    super(reason, fix);
    this.name = "GitHubError";
  }
}
