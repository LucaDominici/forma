# Publishing Forma (private now → public later)

This repo is built to flip from **private** to **public** by changing one setting,
once the checklist below is green. Nothing here assumes it is public yet.

## 0. Create the private repo

```sh
# from the forma/ directory (already git-initialized with commits)
gh repo create forma --private --source=. --remote=origin --push
```

- Replace `OWNER` with your GitHub user/org in `package.json`
  (`homepage`/`bugs`/`repository`), `lib/schema/c4-model.schema.json` (`$id`), and the
  `CHANGELOG`/`README` links.
- **Default branch:** this repo may be on `master` (the sandbox that created it could not
  rename the ref). Either rename to `main` (`git branch -m master main` before first push)
  or leave it — CI triggers on **both** `main` and `master`. Branch protection in step 2
  must target whichever is the default.

## 1. Before going PUBLIC — required

- [ ] Fill the `<CONTACT: ...>` placeholders in `CODE_OF_CONDUCT.md` and `SECURITY.md`
      (a real email or GitHub private reporting). Intentionally blank so no personal email
      leaks by default.
- [ ] Confirm no secrets or personal data are tracked:
      `git log -p | grep -iE "token|secret|password|@gmail"` → empty.
- [ ] Confirm the tarball is clean: `npm pack --dry-run` → exactly the runtime files, no
      `.fuse_hidden*` or editor artifacts (the `prepack` guard also enforces this).
- [ ] Install that tarball into an empty temporary prefix and run the no-edit acceptance chain on
      a clean representative multi-stack repository: `init`, `gen`, `check`, `verify`, `room init`,
      `room update`, then `room-presentable`. Retain the topology, model, complete issue snapshot,
      room HTML and command log from the same commit.
- [ ] Run the generated Room at 1920 px and 390 px plus print with at least 2,500 issues. The
      selected screen must mount at most one 40-row issue page, body width must not overflow, Axe
      serious findings must be zero and print length must not scale with closed issue count. In the
      embedded map, traverse L1→L3 with Enter/Space and confirm the mobile SVG pans at readable
      scale instead of shrinking the whole graph into the viewport.
- [ ] Enable GitHub secret scanning + push protection (Settings → Code security).
- [ ] Decide the final npm package name (`forma` is taken; `forma-arch` is free and is the
      default here).
- [ ] (Recommended) Pin the GitHub Actions in `release.yml` to full commit SHAs — the
      `release` job has `id-token: write`, so a moved third-party tag there is a real
      supply-chain risk. Dependabot then bumps the SHAs. (CI-only actions are lower risk.)

## 2. Flip to public

Settings → General → Danger Zone → **Change visibility → Public**.
Enable branch protection on the default branch (require PR + CI green).

> Do **not** cut a release while the repo is still private: npm provenance is not
> generated for private source repos and the publish will abort.

## 3. First npm release

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
3. **Bootstrap this automation once:** after the reviewed 1.0 branch is merged, push its exact
   `v1.0.0` tag. Release Please intentionally waits for a `v1.*` tag so it cannot reinterpret the
   pre-1.0 history as a 0.x release.
4. **From then on**, releases are automatic and token-free with provenance. Conventional commits
   merged to `main` make Release Please open a versioned release PR; review and merge that PR.
   The `release` workflow then checks out the tag it created, asserts it matches `package.json`,
   runs lint + test + `npm pack --dry-run`, then calls `npm publish`. Provenance (Sigstore) is
   generated automatically because the repo is public and the job has `id-token: write`.
5. **One-time repository settings:** permit GitHub Actions to create pull requests if the default
   setting blocks the release PR; protect release tags; and protect `main` with the CI gate. These
   are account settings, deliberately not changes the workflow can make to itself.
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
