# Decisions log

Calls made while building the isometric 3D version, newest step last. Each entry says what was decided and why,
so a later session (human or agent) doesn't undo working code. Mirrored into Entire as brain memories
(`entire brain recall "<topic>"`).

## Step 0 — setup

- **Branch:** all work is on `iso-3d`, cut from `main` at `ba8b5f2`.
- **Baseline is reproducible here.** Before changing anything, `npm run experiment` was run on a clean export of
  `ba8b5f2` (Node 22) and its `results/` compared byte-for-byte with the committed files. That is the reference
  the `--legacy` check in step 3 is measured against.
- **Entire** was not installed in the cloud container, and `entire.io` / `docs.entire.io` are blocked by its
  network policy, so the CLI (v0.13.4) was installed from the Go module proxy
  (`go install github.com/entireio/cli/cmd/entire@v0.13.4`) and its usage read from `entire agent-help`.
  - `entire enable --agent claude-code --telemetry=false`: anonymous usage analytics are **off** by default.
    Turn them on with `entire configure --telemetry` if the team wants them.
  - Plugin commands have moved since the brief was written: `entire graph init-agents` is now
    `entire graph setup`, and code search is `entire graph query --query "..."`. "Brain checkpoints" are
    `entire brain remember "<text>" --kind decision` from the official `brain` plugin.
  - `entire brain setup --no-backfill --no-daemon`: built the local brain without spending agent tokens or
    installing a background service (pointless in a throwaway container).
  - Checkpoints (full agent transcripts) upload to `origin` on push. The repo is private, so only collaborators
    can read them. **If the repo is made public for judging, the `refs/entire/*` checkpoint refs become public
    too** — review with `entire checkpoint explain` first, or move them with
    `entire configure --local --checkpoint-remote github:<owner>/<private-repo>`.
  - **Checkpoint backend is `git-branch`, not the default `git-refs`.** The cloud session's git gateway only
    accepts pushes to `refs/heads/*`: `refs/entire/checkpoints/*` (and tags, see step 1) are refused with a 403.
    `entire configure --checkpoint-backend branch` stores checkpoints on the `entire/checkpoints/v1` branch,
    which does get through. Once nobody needs to push from a cloud session, move back with
    `entire configure --checkpoint-backend refs`.
  - This session started before the hooks existed, so it is linked to commits with
    `entire session attach <session-id> --force` on the newest *unpushed* commit (which adds the
    `Entire-Checkpoint` trailer), followed by `git commit --amend --no-edit` to restore the environment's
    commit signature, then `git push`.

## Step 1 — freeze the 2D version

- `Project Overview:` → `PROJECT_OVERVIEW.md` (a colon in a filename breaks checkout on Windows).
- `BASIC/` is an exact copy of the app at `ba8b5f2` (`index.html`, `src/`, `scripts/`, `results/`,
  `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `README.md`). The only edit is the
  "frozen snapshot" note at the top of `BASIC/README.md`. It keeps its own `package.json` so
  `cd BASIC && npm install && npm run dev` works standalone.
- `npm run dev:basic` is `vite BASIC --port 5174 --strictPort`. Vite is the root install; BASIC has no runtime
  dependencies, so nothing needs installing inside it. `--strictPort` makes a port clash fail loudly instead of
  silently moving the 2D app to another port mid-demo. Vite looks for its config in the directory it is
  pointed at, so the root `vite.config.ts` (proxy, extra pages) never applies to BASIC.
- `npm run experiment:basic` is `cd BASIC && tsx scripts/experiment.ts`: the script writes to `results/`
  relative to the working directory, so output lands in `BASIC/results/` and the root results are untouched
  (checked with checksums).
- Added `npm run typecheck:basic` so the snapshot can be type-checked from the root.
- Tag `v-2d-basic` points at the step 1 commit (`d2fdf0c`). **It exists only in the cloud container:** the
  session's git gateway refuses tag pushes. Publish it from any normal clone with
  `git fetch origin && git tag -a v-2d-basic d2fdf0c -m "Frozen top-down 2D version (BASIC/)" && git push origin v-2d-basic`.
