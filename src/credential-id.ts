/** Stable identity for a configured provider credential slot. */
declare const credentialIdBrand: unique symbol;
export type CredentialId = string & { readonly [credentialIdBrand]: true };

export const DEFAULT_CREDENTIAL_LABEL = "default";
export const CREDENTIAL_LABEL_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;

export function makeCredentialId(provider: string, label = DEFAULT_CREDENTIAL_LABEL): CredentialId {
  if (!provider || provider.includes("#")) {
    throw new Error("provider must be non-empty and must not contain '#'");
  }
  if (!CREDENTIAL_LABEL_PATTERN.test(label)) {
    throw new Error("credential label must match [A-Za-z0-9_.-]{1,32}");
  }
  return `${provider}#${label}` as CredentialId;
}

export function parseCredentialId(
  value: string,
): { readonly provider: string; readonly label: string } | null {
  const separator = value.indexOf("#");
  if (separator <= 0 || separator !== value.lastIndexOf("#")) return null;
  const provider = value.slice(0, separator);
  const label = value.slice(separator + 1);
  if (!provider || !CREDENTIAL_LABEL_PATTERN.test(label)) return null;
  return { provider, label };
}
