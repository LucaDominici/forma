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

1. **Bootstrap (one time, local):** with the repo already **public**, publish the first
   version manually using a granular npm token:
   ```sh
   npm publish --access public   # from a local checkout, authed with a granular token
   ```
   (Alternatively publish a throwaway `0.0.0` placeholder, then continue.)
2. **Attach the Trusted Publisher:** on npmjs.com → package → Settings → Trusted Publisher,
   point it at this repo's `release.yml` workflow. Requires npm CLI ≥ 11.5.1 (the workflow
   upgrades it).
3. **From then on**, releases are automatic and token-free with provenance:
   ```sh
   git tag v0.1.1 && git push origin v0.1.1
   ```
   The `release` workflow asserts the tag matches `package.json`, runs lint + test, then
   `npm publish` — provenance (Sigstore) is generated automatically because the repo is
   public and the job has `id-token: write`.

## Notes
- The engine has **no runtime dependencies** and makes **no network calls** in
  `gen`/`check` — the review surface is deliberately tiny.
- `dependabot` watches the GitHub Actions weekly (it bumps versions; SHA-pinning per §1 is
  what actually hardens them).
