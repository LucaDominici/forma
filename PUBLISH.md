# Publishing Forma

The repository and `forma-arch` package are public. This is the release checklist; a release is
ready only when its source commit, tarball and retained acceptance evidence agree byte for byte.

## 0. Repository bootstrap (historical)

The repository, public metadata and `main` branch already exist. The following bullets are retained
only as bootstrap constraints for a future transfer or fork.

- Replace `OWNER` with your GitHub user/org in `package.json`
  (`homepage`/`bugs`/`repository`), `lib/schema/c4-model.schema.json` (`$id`), and the
  `CHANGELOG`/`README` links.
- **Default branch:** this repo may be on `master` (the sandbox that created it could not
  rename the ref). Either rename to `main` (`git branch -m master main` before first push)
  or leave it — CI triggers on **both** `main` and `master`. Branch protection in step 2
  must target whichever is the default.

## 1. Release prerequisites — required

- [ ] Confirm `SECURITY.md` names the intended public contact and GitHub private vulnerability
      reporting is enabled. A public security contact is not an accidental personal-data leak.
- [ ] Confirm GitHub secret scanning + push protection are enabled and the open secret-alert count
      is zero. Do not keyword-grep history for `token|password|@gmail`: release documentation and
      the intentional security contact contain those words, so that test is red by construction.
- [ ] Confirm the tarball is clean: `npm pack --dry-run` → the reviewed 38 runtime files, no
      `.fuse_hidden*` or editor artifacts. `prepack` enforces the exact allowlist and count.
- [ ] Install that tarball into an empty temporary prefix and run the no-edit acceptance chain on
      a clean representative multi-stack repository: `init`, `gen`, `check`, `verify`, `room init`,
      `room update`, then `room-presentable`. Retain the topology, model, complete issue snapshot,
      room HTML and command log from the same commit.
- [ ] Run `scripts/browser-gate.mjs` at 3440×1440, 1920×900, 1366×768 and 390×844 plus print,
      over both the dogfood and the 2,500-issue fixture. The
      selected screen must mount at most one 40-row issue page, body width must not overflow, Axe
      WCAG A/AA findings must be zero and print length must not scale with closed issue count. In the
      embedded map, traverse L1→L3 with Enter/Space and confirm the mobile SVG pans at readable
      scale instead of shrinking the whole graph into the viewport.
- [ ] Confirm the package name is `forma-arch`; never reuse a version already present on npm.
- [ ] Pin the GitHub Actions in `release.yml` to full commit SHAs — the
      `release` job has `id-token: write`, so a moved third-party tag there is a real
      supply-chain risk. Dependabot then bumps the SHAs. (CI-only actions are lower risk.)

## 2. Public repository controls

The repository is public. Keep `main` protected (PR + `ci-required`, including browser evidence)
and release tags immutable. The solo tier requires no fabricated second approver.

> Do **not** cut a release while the repo is still private: npm provenance is not
> generated for private source repos and the publish will abort.

## 3. npm trusted publishing

npm **trusted publishing (OIDC) cannot perform a package's _first_ publish** — the npm
side requires the package to already exist before a Trusted Publisher can be attached.
So bootstrap once, then hand off to the workflow:

1. **Bootstrap (one time, local) — DONE for 0.1.0 (2026-07-24):** publish the first version
   manually. **Do not use an npm token** — npm's 2025 policy changes broke classic/automation
   tokens. Log in with the web flow (a passkey / security key works in the browser; no OTP
   needed) and publish:
   ```sh
   npm login --auth-type=web      # browser -> passkey, then `npm whoami`
   npm publish                     # completes 2FA via the auth/cli URL npm prints (passkey)
   ```
   Gotcha: use a clean npm — a corepack-corrupted npm 12 threw `Cannot find module 'sigstore'`;
   `corepack prepare npm@11.16.0 --activate` fixes it. Run in a real TTY (npm's web-auth wait
   does not work through non-interactive wrappers).
2. **Attach the Trusted Publisher:** on npmjs.com → package → Settings → Trusted Publisher,
   point it at this repo's `release.yml` workflow. Requires npm CLI ≥ 11.5.1 (the workflow
   upgrades it).
3. **Bootstrap complete:** `v1.0.0` exists and `forma-arch@1.0.0` is immutable on npm. Never
   republish that version; every later candidate goes through the versioned Release Please PR.
4. **From then on**, releases are automatic and token-free with provenance. Conventional commits
   merged to `main` make Release Please open a versioned release PR; review and merge that PR.
   The `release` workflow then checks out the tag it created, proves it belongs to `main`, runs the
   complete source/browser/print gates, packs and installs that exact candidate, and replays the
   customer path. Only after that no-OIDC job succeeds may the separate OIDC job call
   `npm publish`. Provenance (Sigstore) is generated automatically because the repo is public.
5. **Repository settings:** permit GitHub Actions to create pull requests, protect `v*` tags from
   deletion/non-fast-forward updates, and protect `main` with the aggregate CI gate.
6. **Recovery only:** an already-reviewed exact tag can still publish directly:
   ```sh
   git tag v1.0.1 && git push origin v1.0.1
   ```
   The same tag/package assertion and OIDC gate applies. Apart from the 1.0 bootstrap, do not use
   this route for normal releases: it bypasses the reviewable Release Please PR.

## Notes
- The engine has **no runtime dependencies** and makes **no network calls** in
  `gen`/`check` — the review surface is deliberately tiny.
- `dependabot` watches the GitHub Actions weekly (it bumps versions; SHA-pinning per §1 is
  what actually hardens them).
