export function greet(name: string): string {
  const label = "Hello";
  const trimmed = name.trim();
  const upper = trimmed.toUpperCase();
  const suffix = "!";
  const result = label + " " + upper + suffix;
  return result;
}
