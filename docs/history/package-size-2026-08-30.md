# Package size — root cause and the shipped-comment measurement (2026-08-30)

Closes two of the three open items in [backlog.md](../backlog.md) and answers the size question the
third one asks. Every figure here is measured, not estimated. The commands are stated so anyone
can repeat them.

## 1. The 9 unexplained package entries — CLOSED

The backlog asked what added 9 entries that a baseline regeneration absorbed without attribution.
The answer is three source modules, and the arithmetic closes with no residue.

| Commit | Date | `observed.packageEntries` | Ceiling then |
|---|---|---|---|
| `3081c22` | 2026-08-29 | **329** | 340 |
| *(not regenerated)* | — | *338 measured later* | 340 |
| `b5302f0` | 2026-08-29 | **341** | 352 |
| `b78ce26` | 2026-08-30 | **347** | 352 |

**What happened.** `ba3bd2a` — *"re-probe recorded lane quota deaths on the relay's own cadence"*,
released as v0.59.0 — added three modules:

- `src/dispatch-exhaustion-persistence.ts`
- `src/lane-cadence.ts`
- `src/lane-quota-probe.ts`

`tsc` emits exactly three build outputs per module (`.js`, `.d.ts`, `.js.map`), so three modules
add **9 entries**. That took the package from 329 to 338. The ceiling was 340, so `check:package`
passed and nobody regenerated the baseline. The growth was real and attributable, and it was
silent only because it stayed under the ceiling.

`b5302f0` then added a fourth module, `src/network-block.ts` (+3), reaching 341. That tripped the
340 ceiling and forced the regeneration which recorded 341 — absorbing all 12 at once, of which
only 3 belonged to that lap.

**The arithmetic closes exactly:** 329 + 9 + 3 = 341. No entry is unaccounted for.

**Independent confirmation.** The current 347 entries decompose with no remainder:

```
dist 335  +  skills 1  +  10 files named in package.json "files"  +  package.json 1  =  347
```

No file outside `dist/` was added to the `files` set during the interval
(`git diff --diff-filter=A 3081c22 b5302f0 -- skills docs/… scripts/… README.md …` is empty), so
`dist/` accounts for all of it.

**Why nothing was laundered.** A ratchet with a ceiling above the current value will always absorb
growth up to that ceiling without comment. That is the mechanism, and it is working as designed.
The lesson is about the GAP, not the ratchet: a ceiling set ~2 modules above the observed value
buys exactly one release of silence.

## 2. A stale `unpackedBytes` in the baseline — CORRECTED

Found while closing item 1, and it is the same defect class facing a different way.

The baseline recorded `observed.unpackedBytes: 5194760`. The committed tree measures **5205915** —
a difference of 11155 bytes — while `packBytes` (1113288) and `packageEntries` (347) both match
the recorded values exactly.

Identical gzip output from 11 KB of different content is not possible, so the recorded
`unpackedBytes` does not describe the committed tree.

**Proof that the tree did not change.** Every input to the packed set is byte-identical between
`b78ce26` (where the baseline was recorded) and HEAD:

```bash
git diff --stat b78ce26 HEAD -- src dashboard tsconfig.json dashboard/vite.config.ts skills docs/tier-data.json docs/dashboard-bundle-inventory.json scripts/install-skill.mjs scripts/sync-tiers.mjs scripts/tier-scoring.mjs README.md LICENSE THIRD_PARTY_NOTICES.md config.example.json
```

That diff is empty. The release commit `4fb835d` touched only `package.json` and
`package-lock.json`, and neither changes a shipped byte count.

**Independent confirmation of the true figure.** Summing the 347 packed files directly gives
5205915, byte for byte equal to what `npm pack --dry-run --json` reports. The measurement is sound;
the recorded value was not.

**Why it survived.** `unpackedBytes` is a CEILING metric, not an exact one, so the check never
compares it for equality — only against 5240300. A wrong `observed` value therefore has no way to
be caught. This is the same reason the 9 entries went unattributed.

Corrected to the measured 5205915. Headroom against the ceiling is 34385 bytes.

⚠ This is a provenance correction, not a ratchet raise. The repo invariant is that a guess must
never be labelled a measurement, and an `observed` field that describes no tree is exactly that.
The ceiling was NOT touched.

## 3. What shipped comment prose actually costs — MEASURED

The backlog asks *"whether shipping this much comment prose to npm is worth its size"*. Here is the
number. `removeComments` is unset in `tsconfig.json`, so every doc comment is emitted into
`dist/*.js`, and `.d.ts` files carry them too.

Two `tsc` emits of the same source, declarations and source maps off, isolate the comment cost in
JavaScript alone:

| Emit | `.js` bytes |
|---|---|
| with comments | 1958465 |
| without comments | 1379808 |
| **comment prose** | **578657 = 29.5% of `dist/*.js`** |

Measured against the real tarball, four variants:

| Variant | `packBytes` | Saving | Entries | Cost |
|---|---|---|---|---|
| **A.** Ship as today | 1113288 | — | 347 | 1712 bytes of headroom left |
| **B.** `removeComments: true` | 739390 | **−373898 (33.6%)** | 347 | `.d.ts` loses its doc comments, so consumers lose IntelliSense text |
| **C.** Strip `.js` comments, keep `.d.ts` docs | 861480 | −251808 (22.6%) | 347 | A second `tsc` pass in `build:server` |
| **D.** Drop source maps, keep every comment | 870204 | −243084 (21.8%) | 237 | No stack-trace mapping for users |

C and D are orthogonal and can combine.

**Repeat it with:**

```bash
npx tsc -p tsconfig.json --removeComments --declaration false --declarationMap false && npm pack --dry-run --json --ignore-scripts
```

⚠ Restore the normal build afterwards with `npm run build`, or the next check measures the variant.

## 3.1 DECIDED: variant C, built and merged — but NOT PUBLISHED (2026-08-30)

⚠ **Read this before quoting the numbers below as what users get.** Variant C is on `main` and
green, but the owner decided to leave it **unreleased**. The npm registry therefore still serves
the PRE-variant-C package: `dist-tags.latest` is 0.62.0 at `packBytes` 1113288, while this tree
builds 861516. The 22.6% reduction reaches users only when someone cuts the next release.


The owner chose **C** — strip the comments from `dist/*.js`, keep the `.d.ts` doc comments — so
consumers keep their IntelliSense text. `build:server` now runs `tsc` twice:

```
node scripts/clean-dist.mjs && tsc -p tsconfig.json && tsc -p tsconfig.json --removeComments --declaration false --declarationMap false
```

Pass 1 emits the declarations with their docs. Pass 2 re-emits only the JavaScript, overwriting
`dist/*.js` and `dist/*.js.map` and leaving pass 1's `.d.ts` files untouched.

**Measured result**, before → after:

| | before | after | change |
|---|---|---|---|
| `packBytes` | 1113288 | **861516** | **−251772 (22.6%)** |
| `unpackedBytes` | 5205915 | 4578538 | −627377 |
| `packageEntries` | 347 | 347 | unchanged |
| `dist/*.js` bytes | 2203448 | 1624791 | −578657, exactly the measured comment prose |
| `dist/*.d.ts` bytes | 511895 | 511895 | **unchanged — the point of C** |

Verified directly rather than inferred: `dist/network-block.d.ts` still carries its full 43-line
doc block, and `dist/network-block.js` contains exactly one `//` line — its
`//# sourceMappingURL=` directive, which must stay.

⚠ The 36-byte gap against the 861480 measured in §3 is fully explained: `package.json` ships, and
the `build:server` script string grew when the second pass was added.

**Ceilings ratcheted DOWN with it** — `packBytes` 1115000 → 866000 and `unpackedBytes` 5240300 →
4602000, each keeping the ~0.5% headroom the baseline carried before. A ceiling left at the old
figure after a 22.6% reduction would be decoration, not a ratchet. `packageEntries` stays at 352,
because it bounds module growth and the count did not move.

⚠ **Do not "simplify" the two passes into one.** A single `removeComments: true` in
`tsconfig.json` is variant B: it strips the `.d.ts` docs as well, and buys only a further ~122k.
It was rejected for exactly that reason.

### 3.2 Two things that look like failures and are not

Both were raised by an independent audit of the change. Recorded so nobody re-derives them.

- ⚠ **`dist/claude-hook.js` still contains comment TEXT, and that is correct.** Lines 23-61 hold
  the body of the `.mjs` hook script that `src/claude-hook.ts` WRITES TO DISK, carried in a
  template literal. `--removeComments` strips syntactic comments, not string data, so the
  generated hook keeps its own comments — which is what you want, since an operator reads that
  file. Every other `//` match across `dist/*.js` is inside a quoted string too (URLs in `cli.js`,
  `presets.js`, `server.js`, `dashboard-static.js`, `responses-request.js`). A full sweep of all
  335 files found no genuine stray comment in any file's own code.
- ⚠ **`dist/sse.d.ts` has no doc blocks, and that is not stripping.** `src/sse.ts` has none to
  begin with. It is the only one of 91 top-level `.d.ts` files without them; the other 90 carry
  theirs intact.

Two structural facts confirmed at the same time: nothing in `src/` or `test/` reads a comment out
of `dist/*.js` at run time, and the second pass leaves no stale output — every top-level
`dist/*.js` has a matching `.d.ts` and `.js.map`, with no orphan in either direction. The 111 `.js`
against 110 `.d.ts` is the Vite dashboard bundle, which correctly has neither pair.

## 4. Friction

- `npm pack --dry-run --json` returns an OBJECT keyed by package name on the npm major installed
  here, not the array that older documentation and several scripts assume. `JSON.parse(s)[0]` is
  `undefined`. Read `parsed["llm-relay"]`.
- A ceiling metric with a wrong `observed` value is undetectable by construction. Both findings
  above are instances. If the exact/ceiling split is ever revisited, that is the reason to.
