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

## What the publish workflow now refuses

The trigger IS the credential (there is no npm token), so the workflow gates itself. Four things
will stop a tag from publishing, and each one is a *correct* refusal — do not work around them:

- **The tag must be in this repository and match `refs/tags/v*`.** A fork's tag, or any branch
  push, never starts the job.
- **The tag's commit must be contained in the default branch.** Tag `main` after the work is
  merged; a tag cut from a feature branch is refused with `compare status: diverged|ahead`.
- **The tag must equal `v<package.json version>`.** This is what `npm version` gives you for free
  and what hand-editing the version field breaks (see the known trap below).
- **The job runs in the `npm-publish` GitHub environment.** If that environment carries required
  reviewers, the run *waits for an approval* instead of failing — a release that looks stuck at
  step 5 is usually this. Approve it in the run's UI, or check
  Settings → Environments → npm-publish. ⚠ GitHub auto-creates the environment with **no** rules
  on first use, so its presence in the workflow is not itself proof of a gate; the reviewer and
  protected-tag rules have to be set in repo settings.

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
   npm view llm-relay version --prefer-online
   ```

   `--prefer-online` is not optional: a plain `npm view` answers from the local metadata cache and
   will happily report the *previous* version minutes after a successful publish, which looks exactly
   like a failed release. If it still disagrees, read the registry directly —
   `curl -s https://registry.npmjs.org/llm-relay` and check `dist-tags.latest`. The registry is the
   tie-breaker: when it already shows the new version, any disagreement is local cache, not a failure.

7. **Reinstall the global bin** so the installed `llm-relay` isn't silently older than the code:

   ```bash
   npm install -g llm-relay@latest --prefer-online && llm-relay --version
   ```

   `--prefer-online` is needed **here too**, for the same cache reason as step 6 — and it is easy to
   miss because the failure looks different. Right after a publish, `npm install -g llm-relay@latest`
   resolves from the cached packument and dies with `E404 notarget … version doesn't exist`, which
   reads as a broken publish even while `npm view --prefer-online` and the registry both already
   report the new version. Pin the exact version if it still refuses.

## Report

State the published version, the CI run URL, and the confirmed `npm view` output. If you stopped at
a gate, say which gate and exactly what has to happen before the release can resume.

## Known trap: `gh run list --limit 1` right after a push returns the PREVIOUS run

Met twice in one session (2026-09-01). GitHub has not registered the new run yet, so the "latest"
row is the run before it — and `gh run watch` on that id answers
`has already completed with 'success'` for work that never ran. Both readings looked like a green
release.

**Select the run by what identifies it, never by list position.** For a publish, that is the tag; for
a CI run, the SHA:

```bash
gh run list --workflow=publish.yml --limit 5 --json databaseId,headBranch --jq '.[] | select(.headBranch=="v0.0.0") | .databaseId'
```

```bash
gh run list --workflow=ci.yml --branch main --limit 5 --json databaseId,headSha --jq ".[] | select(.headSha==\"$(git rev-parse HEAD)\") | .databaseId"
```

Then confirm the verdict with `gh run view <id> --json status,conclusion,headSha` and check the SHA
in that same output. Poll for the row rather than assuming it is there — it can take a few seconds
to appear.

## Known trap: a SUCCESSFUL publish run prints `::error::tier-data.json missing or empty`

Observed on the v0.68.7 release (2026-09-01). `gh run watch` rendered a red `X tier-data.json
missing or empty` line while every step succeeded and the package published normally.

**That annotation is the workflow's own NEGATIVE CONTROL.** The "Smoke-test the packed artifact"
step deletes `docs/tier-data.json` from a throwaway copy and asserts the probe DETECTS the absence.
The probe emits `::error::` by design, GitHub renders it as an annotation, and the step then prints
`PASS-AS-EXPECTED: tier-data.json absent correctly detected`. The positive assertion runs too and
prints `tier-data.json: present, models=<n>`.

So do not abandon or re-cut a release on that line. Confirm the run instead:

```bash
gh run view <id> --json status,conclusion --jq '"\(.status)/\(.conclusion)"'
```

⚠ **And never read the verdict off a piped `gh run watch`.** `gh run watch --exit-status ... | tail`
reports `tail`'s exit code, not the watch's, so a genuinely failed run looks green — the same
pipe-masks-the-exit-code trap this repo records for suite runs. Ask for `conclusion` explicitly, and
treat the registry as the tie-breaker for whether the publish happened.

## Known trap: `--prefer-online` is not always enough

Observed on the v0.21.0 release (2026-08-07), minutes after a **successful** publish:

```
npm view llm-relay version --prefer-online   → 0.20.0        (previous version)
npm install -g llm-relay@latest --prefer-online → E404 notarget
npm install -g llm-relay@0.21.0                 → E404 notarget
curl -s https://registry.npmjs.org/llm-relay    → dist-tags.latest = 0.21.0, versions has 0.21.0
```

The registry already had it; npm's local metadata did not, and `--prefer-online` alone did not
revalidate. **The combination that worked was the exact version AND the flag together:**

```bash
npm install -g llm-relay@0.21.0 --prefer-online
```

So when step 6 or 7 disagrees with the registry, escalate in this order rather than concluding the
release failed: (1) `curl` the registry — it is the tie-breaker; (2) if it shows the new version,
retry the install pinned **and** with `--prefer-online`; (3) only if the registry itself lacks the
version is anything actually wrong. Do not delete or re-push the tag on the strength of an npm
error alone — the run's own conclusion (`gh run view <id> --json conclusion`) plus the registry are
what say whether the publish happened.

## Known trap

Versions can be committed but never released: `npm version` was skipped and the bump was hand-edited
into `package.json`, so no tag was ever pushed and CI never ran. Symptom is `npm view llm-relay
version` sitting several versions behind `package.json`. Check
`git describe --tags --abbrev=0` against `package.json` before assuming a release happened — and
prefer `npm version` over editing the field by hand, which is what prevents it.
