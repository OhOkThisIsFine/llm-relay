---
name: release
description: Build, verify, tag and publish llm-relay to npm. Use when asked to release, publish, ship, cut a version, or push a new llm-relay version to npm — and at the end of any sprint whose work should reach users.
---

# Release llm-relay

Publishing is **not** a local `npm publish`. The package is published by
[.github/workflows/publish.yml](../../../.github/workflows/publish.yml) using npm **Trusted
Publishing** (OIDC, `id-token: write`) — there is no npm token anywhere, and no npm login is needed
or useful. CI is triggered by **pushing a `v*` tag**. A local `npm publish` will fail with a
misleading `E401`/`E404`; if you see that, you are on the wrong path, not missing a credential.

The whole job is therefore: get `main` green and clean, bump, tag, push the tag, then watch CI and
confirm the version actually landed.

## Gate: the tree must be clean

Non-negotiable, and check it **first** — a dirty tree means the tag would point at a commit that
doesn't contain the work you think you're shipping.

```bash
git status --porcelain
```

Any output at all → **stop** and report what's uncommitted. Do not stash, do not `git add -A`, do
not "just commit it" — the user decides what ships. Also confirm you are on `main` and level with
the remote (`git fetch && git status -sb` showing no ahead/behind).

## Steps

1. **Clean + on main + synced with origin** (above). Stop on any failure.

2. **Verify green before bumping** — on the exact tree that will be tagged:

   ```bash
   npm run build && npm test && npm run typecheck
   ```

   Any failure ends the release. CI re-runs all three, so a local failure is a guaranteed CI failure;
   fix it and start over rather than tagging hopefully.

3. **Pick the version.** Read the current one from `package.json`, then look at what's changed since
   the last tag (`git log $(git describe --tags --abbrev=0)..HEAD --oneline`) and pick patch/minor
   yourself — this project is pre-1.0 and patch is the norm. State the choice; only ask when a
   change is plainly breaking. Then:

   ```bash
   npm version patch -m "chore: release v%s"
   ```

   `npm version` bumps `package.json`, commits, and creates the annotated tag in one step. It refuses
   to run on a dirty tree, which is a second safety net rather than a substitute for step 1.

4. **Push the commit, then the tag.** Order matters — a tag whose commit isn't on the remote yet
   produces a CI run against a commit nobody can see.

   ```bash
   git push && git push --tags
   ```

5. **Watch the publish run.** The tag push is what starts it:

   ```bash
   gh run watch --exit-status $(gh run list --workflow=publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')
   ```

   On failure, `gh run view --log-failed` shows the failing step. Fix forward with a new patch
   version; do not delete and re-push a tag, since a version already on npm cannot be republished.

6. **Verify it is actually live** — CI going green is not proof the registry updated:

   ```bash
   npm view llm-relay version
   ```

   It must equal the version you just tagged. Give the registry a moment and re-check once if it
   still shows the old one.

7. **Reinstall the global bin** so the installed `llm-relay` isn't silently older than the code:

   ```bash
   npm install -g llm-relay@latest && llm-relay --version
   ```

## Report

State the published version, the CI run URL, and the confirmed `npm view` output. If you stopped at
a gate, say which gate and exactly what has to happen before the release can resume.

## Known trap

Versions can be committed but never released: `npm version` was skipped and the bump was hand-edited
into `package.json`, so no tag was ever pushed and CI never ran. Symptom is `npm view llm-relay
version` sitting several versions behind `package.json`. Check
`git describe --tags --abbrev=0` against `package.json` before assuming a release happened — and
prefer `npm version` over editing the field by hand, which is what prevents it.
