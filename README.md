# ci-cache-action

GitHub Action that configures Evanion CI Cache for a job. For Nx (the only tool so far) it exports `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` and `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`, which Nx reads in later steps. The cache server is self-hosted; this repository holds only the action.

## Usage

```yaml
permissions:
  contents: read
  id-token: write

jobs:
  main:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Evanion/ci-cache-action@v0.3.0
        with:
          tool: nx
          server: ${{ vars.CI_CACHE_SERVER }}
          read-token: ${{ secrets.CI_CACHE_READ_TOKEN }}
      - run: pnpm install --frozen-lockfile
      - run: pnpm nx affected -t lint test build
```

Pin a full commit SHA (`Evanion/ci-cache-action@<40-char sha> # v0.3.0`) or an exact version tag. The action receives a write token, so a pinned SHA guarantees the code that sees it. The major tag `v0` is a convenience: it moves to each new `v0.x.y` release, so a job on `@v0` runs new code without a change on your side.

Versions continue from `Evanion/nx-cache-action`: v0.3.0 is v0.2.0 under the new name, plus the `tool` input.

The repository variable `CI_CACHE_SERVER` holds the server origin and the repository secret `CI_CACHE_READ_TOKEN` holds the project's read token.

## Inputs

- `tool` (optional, default `nx`): the build tool to configure. Only `nx` is supported. `turbo` and `generic` are reserved and fail the step until they ship. An empty value means `nx`.
- `server` (required): cache server origin, `https://` with no path. It is also the audience of the OIDC token.
- `read-token` (required): the project's read token. If it is empty (fork PRs, Dependabot), the action prints a warning and the run has no remote cache.
- `large-upload-threshold` (optional, default `99614720`): bytes. In write mode a cache upload over this goes through the local gateway's upload slot.

## Modes

- `push`, `workflow_dispatch` and `schedule` runs on the default branch, or on a branch the project trusts and GitHub protects, with `id-token: write` exchange the job's OIDC token at `POST <server>/v1/oidc/github` for a 1-hour write token for the shared cache.
- Before the exchange the action asks `GET <server>/v1/oidc/github/eligibility` (with `read-token`) whether this event and ref may write. The server holds the rules; the action keeps none. A `404` from an older server means the action exchanges and lets the server decide.
- `pull_request` runs on `refs/pull/<n>/merge` with `id-token: write` get a 1-hour write token confined to the PR's namespace `pr-<n>`. The action prints `mode: write (pr-<n>)`. That token reads the PR namespace and then the shared cache, and writes only the PR namespace.
- Every other run (`pull_request_target`, untrusted branches, tags, a failed eligibility check, a refused or failed exchange) uses `read-token`. A failure never fails the job.

## Security model

- The action stores no secrets. It reads `read-token` from the job and asks GitHub for an OIDC token, which the server verifies (repository id, owner id, ref, ref type, event) before it mints a write token. The eligibility answer only decides whether the action asks; the exchange checks the signed claims again. Every token is masked in the log.
- No token appears in a process argument list: headers and bodies go to `curl` through stdin.
- The action starts `gateway.mjs` on `127.0.0.1` and points Nx at it. The gateway forwards each request to the server with the `Authorization` header Nx sends and holds no token of its own; it starts with the read token and the OIDC request token removed from its environment. A request that goes 30 s without progress ends as a miss (`404`) for a read or `403` for a write, so Nx never waits on a dropped connection until the job times out. In read mode it answers cache writes with `403` itself. In write mode, for a `PUT` over `large-upload-threshold` it asks the server for an upload slot, sends the body to the presigned object storage URL the server returns, and confirms the upload. This gets artifacts past Cloudflare's 100 MB request body limit.
- When a large upload fails, the gateway answers Nx `403`, which Nx ignores, and the task is not cached. The post step stops the gateway and copies each "not cached" line into the job summary as a warning, and up to 20 failed or stalled requests into the job log.
- When the server does not answer the eligibility check or the exchange within 15 s, or the gateway does not start, the action exports nothing and prints `CI cache mode: off`. The job builds without a remote cache.
- Steps after the action can read the write token from the job environment. Do not run untrusted code later in a job that can get write access.

## Requirements

- `id-token: write` in the job's permissions for write mode. Without it the action reads only.
- `bash`, `curl`, `jq` and Node 20 or later on the runner (GitHub-hosted Ubuntu runners have them).
- Write tokens expire after 1 hour. Jobs longer than that lose write access for later tasks.

## License

MIT
