import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { Config, ProviderConfig } from "./config.js";
import {
  curatedEnvNames,
  resolveCredential,
  type CredentialResolution,
} from "./authEnv.js";
import {
  providerCredentialSlots,
  resolveCredentialSlot,
  type CredentialSlot,
} from "./credential-fleet.js";
import {
  CREDENTIAL_LABEL_PATTERN,
  makeCredentialId,
  parseCredentialId,
  type CredentialId,
} from "./credential-id.js";
import {
  addEntry,
  createEncryptedKeystoreExport,
  decryptEncryptedKeystoreExport,
  isEncryptedKeystoreExport,
  keystoreStatus,
  keystoreWrapMode,
  keyIsPresent,
  listEntries,
  removeEntry,
  restoreEntryFromExport,
  revokeEntry,
  rotateEntry,
  setDisabled,
  verifyKeystoreUnlock,
  KeystoreEntryExistsError,
  type KeystoreEntryDescriptor,
  type KeystoreOptions,
} from "./keystore.js";
import {
  KeyringPassphraseRequiredError,
  KeyringUnavailableError,
} from "./os-keyring.js";
import { matchCredentialImportName, parseCredentialImport } from "./key-import.js";
import { defaultEnvPath } from "./dotenv.js";
import { validateProviderKeys, type KeyCheckResult } from "./key-checker.js";
import {
  createControlAuthorization,
  resolveControlAuthorizationConfigDir,
} from "./control-authorization.js";
import { isCooldownClearResult } from "./cooldown-clear.js";
import { restrictSecretFileOnWindowsSync } from "./secret-file-acl.js";

export type KeysSecretPurpose =
  | "credential"
  | "keystore-passphrase"
  | "export-passphrase"
  | "import-passphrase"
  | "unlock-passphrase";

export type KeysSecretReader = (
  prompt: string,
  purpose: KeysSecretPurpose,
) => Promise<string>;

interface PromptWriter {
  write(value: string): unknown;
}

export interface KeysCliDependencies {
  readonly config?: Config;
  readonly keystore?: KeystoreOptions;
  readonly env?: NodeJS.ProcessEnv;
  readonly readSecret?: KeysSecretReader;
  readonly stdin?: NodeJS.ReadStream;
  readonly promptOutput?: PromptWriter;
  readonly write?: (value: string) => void;
  readonly fetch?: typeof fetch;
  readonly keyCheckFetch?: typeof fetch;
  /** Test/embedding seam; production deliberately defaults to the existing key checker. */
  readonly validateKeys?: (
    cfg: Config,
    env: NodeJS.ProcessEnv,
  ) => Promise<KeyCheckResult[]>;
  readonly envFilePath?: string;
  readonly attachControlHeaders?: (
    cfg: Config,
    headers: Record<string, string>,
  ) => Record<string, string>;
}

export class KeysCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeysCliError";
  }
}

export const KEY_CUSTODY_THREAT_BOUNDARY = [
  "- **What it stops:** a copy of `keystore.json` alone — committed to a repo, synced to cloud storage, pulled from a partial backup, or moved to another machine — is useless.",
  "- **What it does not stop:** a copy of the **whole user profile together with the account password**. `%APPDATA%\\Microsoft\\Protect` travels in a whole-profile backup, and an offline attacker holding it plus the password (or its hash, or a domain backup key) decrypts CurrentUser blobs. This is routine, not exotic.",
  "- **What nothing user-side stops:** code already running as you.",
  "- An **admin-forced password reset** on a non-domain machine destroys the DPAPI master key and every entry becomes undecryptable. A normal password change is fine.",
].join("\n");

class MutedPromptOutput extends Writable {
  muted = false;

  constructor(private readonly target: PromptWriter) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      if (!this.muted) this.target.write(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}

interface PipedLineWaiter {
  readonly resolve: (value: string) => void;
  readonly reject: (error: KeysCliError) => void;
}

interface PipedLineReader {
  readonly values: string[];
  readonly waiters: PipedLineWaiter[];
  ended: boolean;
  failure?: KeysCliError;
}

const pipedLineReaders = new WeakMap<NodeJS.ReadStream, PipedLineReader>();

function sharedPipedLineReader(input: NodeJS.ReadStream): PipedLineReader {
  const existing = pipedLineReaders.get(input);
  if (existing !== undefined) return existing;

  const state: PipedLineReader = {
    values: [],
    waiters: [],
    ended: input.readableEnded,
  };
  pipedLineReaders.set(input, state);
  if (state.ended) return state;

  const line = createInterface({ input, crlfDelay: Infinity, terminal: false });
  const fail = (): void => {
    if (state.failure !== undefined) return;
    const failure = new KeysCliError("secret input failed");
    state.failure = failure;
    state.values.length = 0;
    for (const waiter of state.waiters.splice(0)) waiter.reject(failure);
    line.close();
  };
  line.on("line", (value) => {
    const waiter = state.waiters.shift();
    if (waiter === undefined) state.values.push(value);
    else waiter.resolve(value);
  });
  line.once("close", () => {
    state.ended = true;
    input.removeListener("error", fail);
    if (state.failure !== undefined) return;
    for (const waiter of state.waiters.splice(0)) waiter.resolve("");
  });
  line.once("error", fail);
  input.once("error", fail);
  return state;
}

/**
 * One-line secret input. TTY input is handled by readline in terminal/raw mode while its output
 * is muted after the prompt; closing and every failure path restore the caller's raw-mode state.
 * Each piped prompt consumes one logical line from a shared reader and never prints a prompt.
 */
export async function readMaskedOrPipedLine(
  prompt: string,
  input: NodeJS.ReadStream = process.stdin,
  output: PromptWriter = process.stderr,
): Promise<string> {
  if (input.isTTY !== true) {
    const reader = sharedPipedLineReader(input);
    const buffered = reader.values.shift();
    if (buffered !== undefined) return buffered;
    if (reader.failure !== undefined) throw reader.failure;
    if (reader.ended || input.readableEnded) return "";
    return await new Promise<string>((resolve, reject) => {
      reader.waiters.push({ resolve, reject });
    });
  }

  const priorRaw = input.isRaw;
  const masked = new MutedPromptOutput(output);
  const line = createInterface({ input, output: masked, terminal: true });
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value = ""): void => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", onSigint);
      try {
        line.close();
      } finally {
        try {
          if (typeof input.setRawMode === "function") input.setRawMode(priorRaw === true);
        } finally {
          output.write("\n");
        }
      }
      if (error !== null) reject(error);
      else resolve(value);
    };
    const onSigint = (): void => finish(new KeysCliError("secret input interrupted"));
    process.once("SIGINT", onSigint);
    line.once("SIGINT", onSigint);
    line.once("error", () => finish(new KeysCliError("secret input failed")));
    line.once("close", () => finish(new KeysCliError("secret input ended before a line was read")));
    line.question(prompt, (value) => finish(null, value));
    masked.muted = true;
  });
}

function output(deps: KeysCliDependencies, value: string): void {
  (deps.write ?? ((message) => { process.stdout.write(message); }))(value);
}

async function readSecret(
  deps: KeysCliDependencies,
  prompt: string,
  purpose: KeysSecretPurpose,
  allowWhitespace = false,
): Promise<string> {
  let value: string;
  try {
    value = await (deps.readSecret ?? ((message) => readMaskedOrPipedLine(
      message,
      deps.stdin ?? process.stdin,
      deps.promptOutput ?? process.stderr,
    )))(prompt, purpose);
  } catch (error) {
    if (error instanceof KeysCliError) throw error;
    throw new KeysCliError("secret input failed");
  }
  if (value.endsWith("\r\n")) value = value.slice(0, -2);
  else if (value.endsWith("\n")) value = value.slice(0, -1);
  if (value.includes("\r") || value.includes("\n")) {
    throw new KeysCliError("secret input must be exactly one line");
  }
  if (value.length === 0 || (!allowWhitespace && !keyIsPresent(value))) {
    throw new KeysCliError("empty secret refused");
  }
  return value;
}

interface AddTarget {
  readonly provider: string;
  readonly config: ProviderConfig;
  readonly slot: CredentialSlot;
  readonly envName: string;
  readonly label: string;
  readonly credentialId: CredentialId;
}

function selectAddTarget(
  cfg: Config,
  provider: string,
  requestedLabel?: string,
  requestedEnvName?: string,
): AddTarget {
  const configured = cfg.providers[provider];
  if (configured === undefined) {
    throw new KeysCliError(`unknown provider: no provider "${provider}" exists in the loaded config`);
  }
  // This check precedes the no-auth declaration check because valid passthrough providers
  // necessarily omit provider-owned auth declarations; both named refusals must stay reachable.
  const hasProviderOwnedDeclaration = configured.authEnv !== undefined ||
    (configured.credentials?.some((slot) => slot.authEnv.length > 0) ?? false);
  const resolvesPassthrough = configured.credentialMode === "passthrough" ||
    (configured.kind === "anthropic" && configured.credentialMode !== "contained" &&
      !hasProviderOwnedDeclaration);
  if (resolvesPassthrough) {
    throw new KeysCliError(
      `passthrough provider: provider "${provider}" resolves credentialMode "passthrough"`,
    );
  }
  const declaredSlots = providerCredentialSlots(provider, configured)
    .filter((slot): slot is CredentialSlot & { authEnv: string } => slot.authEnv !== undefined);
  if (declaredSlots.length === 0) {
    throw new KeysCliError(
      `no auth declaration: provider "${provider}" declares neither authEnv nor a credentials[] slot naming one`,
    );
  }
  if (requestedLabel !== undefined && !CREDENTIAL_LABEL_PATTERN.test(requestedLabel)) {
    throw new KeysCliError("invalid label: --label must match [A-Za-z0-9_.-]{1,32}");
  }

  const declaredNames = declaredSlots.map((slot) => slot.authEnv);
  const allowedNames = new Set([...declaredNames, ...curatedEnvNames(provider)]);
  if (requestedEnvName !== undefined && !allowedNames.has(requestedEnvName)) {
    throw new KeysCliError(
      `undeclared env name: --env-name "${requestedEnvName}" is outside provider "${provider}" declared names and curated aliases`,
    );
  }

  const envSlot = requestedEnvName === undefined
    ? undefined
    : declaredSlots.find((candidate) => candidate.authEnv === requestedEnvName);
  const labelSlot = requestedLabel === undefined
    ? undefined
    : declaredSlots.find((candidate) => candidate.label === requestedLabel);
  if (requestedLabel !== undefined && labelSlot === undefined) {
    throw new KeysCliError(
      `credential identity mismatch: --label "${requestedLabel}" is not a configured slot for provider "${provider}"`,
    );
  }
  if (envSlot !== undefined && labelSlot !== undefined && envSlot !== labelSlot) {
    throw new KeysCliError(
      `credential identity mismatch: --label "${requestedLabel}" and --env-name "${requestedEnvName}" select different configured slots`,
    );
  }

  let slot = envSlot ?? labelSlot;
  if (configured.authEnv !== undefined) {
    slot = declaredSlots[0];
    if (requestedLabel !== undefined && requestedLabel !== slot!.label) {
      throw new KeysCliError(
        `credential identity mismatch: legacy authEnv uses credential id ${slot!.credentialId}`,
      );
    }
  } else if (slot === undefined && declaredSlots.length === 1) {
    slot = declaredSlots[0];
  } else if (slot === undefined && requestedLabel === undefined && requestedEnvName === undefined) {
    slot = declaredSlots.find((candidate) => candidate.label === "default");
  }
  if (slot === undefined) {
    throw new KeysCliError(
      `ambiguous credential slot: provider "${provider}" has multiple credentials[] slots; use --env-name or a matching --label`,
    );
  }

  // credentials[] fleet slots resolve declared-only. For those slots, a curated alias is accepted
  // as input vocabulary but normalized to the selected slot's declared authEnv; legacy authEnv
  // providers retain an explicitly requested curated alias.
  const envName = configured.credentials !== undefined
    ? slot.authEnv
    : (requestedEnvName ?? slot.authEnv);
  const label = slot.label;
  return {
    provider,
    config: configured,
    slot,
    envName,
    label,
    credentialId: makeCredentialId(provider, label),
  };
}

function envFilePath(deps: KeysCliDependencies): string {
  return deps.envFilePath ?? defaultEnvPath();
}

function describeShadow(
  resolution: Pick<CredentialResolution, "envName" | "source">,
  deps: KeysCliDependencies,
): string {
  const envName = resolution.envName ?? "(unknown variable)";
  return resolution.source === "env-file"
    ? `$${envName} from env-file ${envFilePath(deps)}`
    : `$${envName} from the process environment`;
}

function resolveDescriptor(
  cfg: Config,
  entry: KeystoreEntryDescriptor,
  deps: KeysCliDependencies,
): CredentialResolution {
  const configured = cfg.providers[entry.provider];
  const env = deps.env ?? process.env;
  if (configured === undefined) {
    return resolveCredential(entry.envName, env, entry.provider, deps.keystore);
  }
  const slots = providerCredentialSlots(entry.provider, configured);
  const idSlot = slots.find((slot) => slot.credentialId === entry.id);
  if (idSlot !== undefined) return resolveCredentialSlot(idSlot, env, deps.keystore);
  const envSlot = slots.find((slot) => slot.authEnv === entry.envName);
  if (envSlot !== undefined) return resolveCredentialSlot(envSlot, env, deps.keystore);
  const legacy = slots.find((slot) => slot.origin === "legacy-authEnv");
  if (legacy !== undefined) return resolveCredentialSlot(legacy, env, deps.keystore);
  return resolveCredential(entry.envName, env, entry.provider, deps.keystore);
}

async function storeOptionsForWrite(
  deps: KeysCliDependencies,
  prompt = "Keystore passphrase: ",
): Promise<KeystoreOptions> {
  const base = deps.keystore ?? {};
  const mode = keystoreWrapMode(base);
  if ((mode === "passphrase" || (mode === null && base.mode === "passphrase")) &&
      base.passphrase === undefined) {
    const passphrase = await readSecret(deps, prompt, "keystore-passphrase", true);
    return { ...base, mode: "passphrase", passphrase };
  }
  return base;
}

async function withFreshPassphraseFallback<T>(
  deps: KeysCliDependencies,
  initial: KeystoreOptions,
  operation: (opts: KeystoreOptions) => T,
): Promise<{ value: T; opts: KeystoreOptions }> {
  try {
    return { value: operation(initial), opts: initial };
  } catch (error) {
    if (!(error instanceof KeyringUnavailableError) &&
        !(error instanceof KeyringPassphraseRequiredError)) throw error;
    const passphrase = await readSecret(
      deps,
      "Create keystore passphrase: ",
      "keystore-passphrase",
      true,
    );
    const opts: KeystoreOptions = { ...initial, mode: "passphrase", passphrase };
    return { value: operation(opts), opts };
  }
}

export async function runKeysAddLocal(
  cfg: Config,
  provider: string | undefined,
  options: { readonly label?: string; readonly envName?: string; readonly check?: boolean } = {},
  deps: KeysCliDependencies = {},
): Promise<void> {
  if (provider === undefined || provider.length === 0) {
    throw new KeysCliError("usage: keys add <provider> [--label <label>] [--env-name <NAME>] [--check]");
  }
  const target = selectAddTarget(cfg, provider, options.label, options.envName);
  const secret = await readSecret(deps, "Credential: ", "credential");
  const prepared = await storeOptionsForWrite(deps);
  const stored = await withFreshPassphraseFallback(deps, prepared, (keystore) => addEntry({
    id: target.credentialId,
    provider: target.provider,
    envName: target.envName,
    value: secret,
  }, keystore));

  output(deps, `Stored ${stored.value.id} for $${stored.value.envName}.\n`);
  const winning = resolveCredentialSlot(target.slot, deps.env ?? process.env, stored.opts);
  if (winning.source === "env" || winning.source === "env-file") {
    output(
      deps,
      `Warning: the key is stored but shadowed by ${describeShadow(winning, deps)}.\n`,
    );
  } else if (winning.source === undefined) {
    output(
      deps,
      "Warning: the key is stored but the credential resolver cannot currently select it; inspect the store status with `llm-relay keys list`.\n",
    );
  }
  output(deps, `${KEY_CUSTODY_THREAT_BOUNDARY}\n`);

  if (options.check === true) {
    if (winning.source === undefined) {
      output(
        deps,
        `Check skipped: the stored key ${target.credentialId} was NOT probed because the credential resolver selected no source.\n`,
      );
      return;
    }
    const checkCfg: Config = { ...cfg, providers: { [provider]: target.config } };
    const results = await (deps.validateKeys?.(checkCfg, deps.env ?? process.env) ??
      validateProviderKeys(checkCfg, deps.keyCheckFetch ?? fetch, {
        env: deps.env ?? process.env,
      }));
    for (const result of results) {
      const subject = result.credentialId === target.credentialId &&
          (winning.source === "env" || winning.source === "env-file")
        ? `Checked ${describeShadow(winning, deps)} — the stored key was NOT probed`
        : `Check ${result.credentialId}`;
      output(
        deps,
        `${subject}: ${result.status.toUpperCase()} — ${result.message}\n`,
      );
    }
  }
}

function dateCell(value: number | null): string {
  return value === null ? "—" : new Date(value).toISOString();
}

function entryState(entry: KeystoreEntryDescriptor, now: number): string {
  const states: string[] = [];
  if (entry.disabled) states.push("disabled");
  if (entry.revokedAt !== null) states.push("revoked");
  if (entry.expiresAt !== null && entry.expiresAt <= now) states.push("expired");
  return states.length === 0 ? "active" : states.join(",");
}

export function runKeysListLocal(
  cfg: Config,
  deps: KeysCliDependencies = {},
): void {
  const status = keystoreStatus(deps.keystore);
  let entries: KeystoreEntryDescriptor[] = [];
  try {
    entries = listEntries(deps.keystore);
  } catch {
    // The status line below is the safe, non-secret diagnostic for an unreadable store.
  }
  const rows = [
    ["provider", "credential id", "source", "fingerprint", "added", "rotated", "expiry", "state"],
    ...entries.map((entry) => {
      const resolution = resolveDescriptor(cfg, entry, deps);
      return [
        entry.provider,
        entry.id,
        resolution.source ?? "—",
        entry.fingerprint,
        dateCell(entry.addedAt),
        dateCell(entry.rotatedAt),
        dateCell(entry.expiresAt),
        entryState(entry, Date.now()),
      ];
    }),
  ];
  output(deps, `${rows.map((row) => row.join("\t")).join("\n")}\n`);
  const undecryptableCount = status.undecryptableCount;
  const listedCount = entries.length;
  const droppedCount = Math.max(0, status.droppedCount - undecryptableCount);
  output(
    deps,
    `Store: ${status.status} — ${listedCount} listed, ${undecryptableCount} undecryptable, ${droppedCount} dropped.\n`,
  );
  output(deps, "Note: this reflects the CLI process's view, not the running relay's.\n");
}

function normalizeRotatableId(value: string | undefined): {
  readonly id: CredentialId;
  readonly provider: string;
  readonly label: string;
} {
  if (value === undefined || value.length === 0) {
    throw new KeysCliError("usage: keys rotate <credentialId>");
  }
  const id = value.includes("#") ? value : makeCredentialId(value);
  const parsed = parseCredentialId(id);
  if (parsed === null) throw new KeysCliError("invalid credential id");
  return { id: id as CredentialId, ...parsed };
}

function runtimeSlotForEntry(cfg: Config, entry: KeystoreEntryDescriptor): CredentialSlot | undefined {
  const configured = cfg.providers[entry.provider];
  if (configured === undefined) return undefined;
  const slots = providerCredentialSlots(entry.provider, configured);
  if (configured.credentials !== undefined) {
    return slots.find((slot) => slot.authEnv === entry.envName);
  }
  return slots.find((slot) => slot.origin === "legacy-authEnv" && slot.authEnv !== undefined);
}

function proxyUrl(cfg: Config, path: string): string {
  const host = cfg.host.includes(":") ? `[${cfg.host}]` : cfg.host;
  return `http://${host}:${cfg.port}${path}`;
}

type RotationClearOutcome =
  | { readonly status: "cleared" }
  | { readonly status: "unreachable" }
  | { readonly status: "failed"; readonly reason: string };

async function clearRotatedLiveState(
  cfg: Config,
  provider: string,
  label: string,
  deps: KeysCliDependencies,
): Promise<RotationClearOutcome> {
  let headers: Record<string, string>;
  try {
    headers = deps.attachControlHeaders?.(cfg, { "content-type": "application/json" }) ??
      createControlAuthorization(resolveControlAuthorizationConfigDir(cfg.sourcePath))
        .attach({ "content-type": "application/json" });
  } catch {
    return { status: "failed", reason: "control authorization is unavailable" };
  }
  const target = { provider, credential: label, kinds: ["credential-fault"] as const };
  try {
    const response = await (deps.fetch ?? fetch)(proxyUrl(cfg, "/cooldowns/clear"), {
      method: "POST",
      headers,
      body: JSON.stringify(target),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return { status: "failed", reason: `running relay returned HTTP ${response.status}` };
    }
    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch {
      return { status: "failed", reason: "running relay returned malformed JSON" };
    }
    return isCooldownClearResult(payload, target, ["provider", "credential", "kinds"])
      ? { status: "cleared" }
      : { status: "failed", reason: "running relay returned an invalid narrowed-clear response" };
  } catch {
    return { status: "unreachable" };
  }
}

export async function runKeysRotateLocal(
  cfg: Config,
  credential: string | undefined,
  deps: KeysCliDependencies = {},
): Promise<void> {
  const parsed = normalizeRotatableId(credential);
  const entry = listEntries(deps.keystore).find((candidate) => candidate.id === parsed.id);
  if (entry === undefined) throw new KeysCliError(`credential "${parsed.id}" was not found`);
  const runtimeSlot = runtimeSlotForEntry(cfg, entry);
  if (runtimeSlot === undefined || runtimeSlot.credentialId !== entry.id) {
    throw new KeysCliError(
      `credential identity mismatch: ${entry.id} does not match the configured runtime slot for $${entry.envName}`,
    );
  }
  if (!runtimeSlot.enabled) {
    throw new KeysCliError(
      `configured slot disabled refusal: enable ${runtimeSlot.credentialId} in config before rotating it`,
    );
  }
  if (entry.disabled) {
    throw new KeysCliError(`disabled credential refusal: enable ${entry.id} before rotating it`);
  }
  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    throw new KeysCliError(`expired credential refusal: ${entry.id} would remain expired after rotation`);
  }
  const winning = resolveDescriptor(cfg, entry, deps);
  if (winning.source === "env" || winning.source === "env-file") {
    throw new KeysCliError(
      `shadow refusal: ${describeShadow(winning, deps)} wins; rotation would not change the wire credential`,
    );
  }
  if (winning.source === "keystore" && winning.provenance?.entryId !== entry.id) {
    throw new KeysCliError(
      `shadow refusal: keystore credential ${winning.provenance?.entryId ?? "(unknown)"} wins; rotation would not change the wire credential`,
    );
  }

  const wasRevoked = entry.revokedAt !== null;
  const prepared = await storeOptionsForWrite(deps);
  const storeView = keystoreStatus(prepared);
  if (storeView.status !== "ok") {
    throw new KeysCliError(`rotation proof failed: keystore is ${storeView.status}`);
  }
  const verified = resolveDescriptor(cfg, entry, { ...deps, keystore: prepared });
  if (verified.source === "env" || verified.source === "env-file") {
    throw new KeysCliError(
      `shadow refusal: ${describeShadow(verified, deps)} wins; rotation would not change the wire credential`,
    );
  }
  if (verified.source === "keystore" && verified.provenance?.entryId !== entry.id) {
    throw new KeysCliError(
      `shadow refusal: keystore credential ${verified.provenance?.entryId ?? "(unknown)"} wins; rotation would not change the wire credential`,
    );
  }
  if (!wasRevoked &&
      (verified.source !== "keystore" || verified.provenance?.entryId !== entry.id)) {
    throw new KeysCliError(
      `rotation proof failed: ${entry.id} is not the configured keystore winner`,
    );
  }
  const replacement = await readSecret(deps, "New credential: ", "credential");
  rotateEntry(entry.id, replacement, prepared);
  output(deps, `Rotated ${entry.id}; new ciphertext stored and rotatedAt set.\n`);
  if (wasRevoked) output(deps, `Rotation deliberately un-revoked ${entry.id}.\n`);

  // Design §2.6: widening "only on a disproved stated fact" is defensible here because the
  // operator's assertion was verified above against what actually resolves.
  const cleared = await clearRotatedLiveState(cfg, parsed.provider, parsed.label, deps);
  if (cleared.status === "cleared") {
    output(deps, `Cleared live credential-fault state for ${entry.id}; other cooldowns were untouched.\n`);
  } else if (cleared.status === "unreachable") {
    output(
      deps,
      "No running relay accepted the narrowed clear; live state will converge on the relay's own success or expiry.\n",
    );
  } else {
    throw new KeysCliError(
      `rotation was stored, but live credential-fault clearing failed: ${cleared.reason}`,
    );
  }
}

function requireLifecycleId(value: string | undefined, verb: string): CredentialId {
  if (value === undefined || parseCredentialId(value) === null) {
    throw new KeysCliError(`usage: keys ${verb} <credentialId>`);
  }
  return value as CredentialId;
}

export function runKeysRevokeLocal(id: string | undefined, deps: KeysCliDependencies = {}): void {
  const entry = revokeEntry(requireLifecycleId(id, "revoke"), deps.keystore);
  output(deps, `Revoked ${entry.id}; the row remains in the keystore.\n`);
}

export function runKeysRemoveLocal(
  id: string | undefined,
  purge: boolean,
  deps: KeysCliDependencies = {},
): void {
  const credentialId = requireLifecycleId(id, "remove");
  removeEntry(credentialId, deps.keystore);
  output(deps, `Removed ${credentialId}.\n`);
  if (purge) {
    output(
      deps,
      "--purge is logical removal only: overwrite-then-unlink is theatre on a journaling filesystem or SSD; no secure erase is claimed.\n",
    );
  }
}

export function runKeysDisableLocal(id: string | undefined, deps: KeysCliDependencies = {}): void {
  const entry = setDisabled(requireLifecycleId(id, "disable"), true, deps.keystore);
  output(deps, `Disabled ${entry.id}.\n`);
}

export function runKeysEnableLocal(id: string | undefined, deps: KeysCliDependencies = {}): void {
  const entry = setDisabled(requireLifecycleId(id, "enable"), false, deps.keystore);
  output(deps, `Enabled ${entry.id}.\n`);
}

export async function runKeysExportLocal(
  outPath: string | undefined,
  deps: KeysCliDependencies = {},
): Promise<void> {
  if (outPath === undefined || outPath.length === 0) {
    throw new KeysCliError("usage: keys export --out <file>");
  }
  if (existsSync(outPath)) throw new KeysCliError(`export destination already exists: ${outPath}`);
  const store = await storeOptionsForWrite(deps);
  const passphrase = await readSecret(deps, "Export passphrase: ", "export-passphrase");
  const confirmation = await readSecret(
    deps,
    "Confirm export passphrase: ",
    "export-passphrase",
  );
  if (confirmation !== passphrase) {
    throw new KeysCliError("export passphrase confirmation mismatch: export refused");
  }
  const envelope = createEncryptedKeystoreExport(passphrase, store);
  writeFileSync(outPath, envelope, { encoding: "utf8", flag: "wx", mode: 0o600 });
  if ((store.acl?.platform ?? process.platform) === "win32") {
    restrictSecretFileOnWindowsSync(outPath, store.acl);
  } else {
    chmodSync(outPath, 0o600);
  }
  output(deps, `Encrypted keystore export written to ${outPath}. A plaintext export path does not exist.\n`);
  output(
    deps,
    "The export passphrase is the file's entire protection off-machine; keep it separate from the export.\n",
  );
}

async function importWriteOptions(deps: KeysCliDependencies): Promise<KeystoreOptions> {
  return await storeOptionsForWrite(deps, "Destination keystore passphrase: ");
}

export async function runKeysImportLocal(
  cfg: Config,
  importPath: string | undefined,
  deps: KeysCliDependencies = {},
): Promise<void> {
  if (importPath === undefined || importPath.length === 0) {
    throw new KeysCliError("usage: keys import <file>");
  }
  const serialized = readFileSync(importPath, "utf8");
  let store = await importWriteOptions(deps);
  let imported = 0;
  let skipped = 0;

  if (isEncryptedKeystoreExport(serialized)) {
    const passphrase = await readSecret(deps, "Import passphrase: ", "import-passphrase", true);
    const entries = decryptEncryptedKeystoreExport(serialized, passphrase);
    for (const entry of entries) {
      try {
        const id = parseCredentialId(entry.id);
        const target = selectAddTarget(cfg, entry.provider, id?.label, entry.envName);
        if (target.credentialId !== entry.id) {
          throw new KeysCliError("exported credential id does not match the configured slot");
        }
        const result = await withFreshPassphraseFallback(deps, store, (opts) =>
          restoreEntryFromExport(entry, opts));
        store = result.opts;
        imported += 1;
        output(deps, `Imported ${entry.provider} $${entry.envName} into the keystore.\n`);
      } catch (error) {
        if (error instanceof KeystoreEntryExistsError || error instanceof KeysCliError) {
          skipped += 1;
          output(deps, `Skipped ${entry.provider} $${entry.envName}: ${error.message}.\n`);
          continue;
        }
        throw error;
      }
    }
    output(deps, `Import complete: ${imported} imported, ${skipped} skipped.\n`);
    return;
  }

  const parsed = parseCredentialImport(serialized);
  for (const entry of parsed.entries) {
    const match = matchCredentialImportName(entry.name, cfg);
    if (match === undefined) {
      skipped += 1;
      // Import names are attacker-controlled file content. Keep the diagnostic useful without
      // reflecting terminal escapes or a value someone placed in the name field.
      output(deps, "Skipped an unrecognized credential name.\n");
      continue;
    }
    if (!keyIsPresent(entry.value)) {
      skipped += 1;
      output(deps, `Skipped ${match.provider} $${match.envName}: empty value.\n`);
      continue;
    }
    try {
      const target = selectAddTarget(cfg, match.provider, undefined, match.envName);
      const result = await withFreshPassphraseFallback(deps, store, (opts) => addEntry({
        id: target.credentialId,
        provider: target.provider,
        envName: target.envName,
        value: entry.value,
      }, opts));
      store = result.opts;
      imported += 1;
      output(deps, `Imported ${target.provider} $${target.envName} into the keystore.\n`);
    } catch (error) {
      if (error instanceof KeystoreEntryExistsError || error instanceof KeysCliError) {
        skipped += 1;
        output(deps, `Skipped ${match.provider} $${match.envName}: ${error.message}.\n`);
        continue;
      }
      throw error;
    }
  }
  output(deps, `Import complete: ${imported} imported, ${skipped} skipped.\n`);
  output(
    deps,
    "The plaintext source was not modified. Shred/delete it yourself; backups and unallocated blocks can retain old contents.\n",
  );
}

export async function runKeysUnlockLocal(deps: KeysCliDependencies = {}): Promise<void> {
  const base = deps.keystore ?? {};
  const mode = keystoreWrapMode(base);
  if (mode === null) {
    output(deps, "No keystore exists; unlock is a no-op.\n");
    return;
  }
  if (mode !== "passphrase") {
    output(deps, `Keystore wrap mode is ${mode}; unlock is a no-op there.\n`);
    return;
  }
  const passphrase = base.passphrase ?? await readSecret(
    deps,
    "Keystore passphrase: ",
    "unlock-passphrase",
    true,
  );
  verifyKeystoreUnlock({ ...base, mode: "passphrase", passphrase });
  output(
    deps,
    "Passphrase verified. No cross-process KEK cache exists; each command prompts as needed.\n",
  );
}
