import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import type { Config } from "./config.js";
import { ALL_PROVIDER_PRESETS, FREE_PROVIDER_PRESETS, SUBSCRIPTION_PROVIDER_PRESETS } from "./presets.js";
import { keyIsPresent } from "./authEnv.js";

export interface OnboardingStatus {
  provider: string;
  displayName: string;
  tierType: "free" | "subscription";
  authEnv: string;
  hasKey: boolean;
  signupUrl?: string | undefined;
  recommendedModels: string[];
}

/**
 * Providers the user has told the onboarding flow to stop asking about.
 *
 * Case- and whitespace-insensitive: config keys are lowercase by convention, and a user typing
 * "Gemini" into a suppression list means the obvious thing. Matching is against the provider's
 * own name only — never its authEnv or display name — so one entry cannot silence a provider
 * the user did not name.
 */
function suppressed(cfg?: Config): Set<string> {
  return new Set((cfg?.leaveMeAlone ?? []).map((n) => n.trim().toLowerCase()));
}

/**
 * The providers onboarding should nudge about.
 *
 * ⚠ This is the ONLY surface `leave_me_alone` affects. Do not reuse it in `llm-relay keys`,
 * `/registry`, telemetry or the candidates table: the user asked for silence about a provider
 * they are not configuring, not for it to disappear from the places they go to find out what
 * the relay actually sees.
 */
export function getOnboardingStatusList(cfg?: Config): OnboardingStatus[] {
  const result: OnboardingStatus[] = [];
  const providers = cfg?.providers ?? ALL_PROVIDER_PRESETS;
  const quiet = suppressed(cfg);

  for (const [name, p] of Object.entries(providers)) {
    if (quiet.has(name.toLowerCase())) continue;
    const preset = ALL_PROVIDER_PRESETS[name];
    const authEnv = p.authEnv ?? preset?.authEnv;
    // The shared presence predicate, not a local `Boolean(...)`: presence has exactly one
    // definition in this codebase, and a whitespace-only exported variable is ABSENT. Reporting
    // such a provider "✅ Ready" sends the user off to debug a live call instead of their key.
    const hasKey = authEnv ? keyIsPresent(process.env[authEnv]) : true;

    result.push({
      provider: name,
      displayName: preset?.displayName ?? name.toUpperCase(),
      tierType: p.tierType ?? preset?.tierType ?? "free",
      authEnv: authEnv ?? "",
      hasKey,
      signupUrl: p.signupUrl ?? preset?.signupUrl,
      recommendedModels: preset?.recommendedModels ?? [],
    });
  }

  return result;
}

export function printOnboardingGuide(cfg?: Config): void {
  const statuses = getOnboardingStatusList(cfg);
  const freeProviders = statuses.filter((s) => s.tierType === "free");
  const subProviders = statuses.filter((s) => s.tierType === "subscription");

  console.log("\n=== llm-relay: Free Models & Subscription Pooling Onboarding ===\n");

  console.log("🟢 100%-FREE MODEL PROVIDERS:");
  for (const p of freeProviders) {
    const statusTag = p.hasKey ? "✅ Ready" : "❌ Missing Key";
    console.log(`  • ${p.displayName} [${statusTag}]`);
    console.log(`    Env: ${p.authEnv ? `$${p.authEnv}` : "(none required)"}`);
    if (!p.hasKey && p.signupUrl) {
      console.log(`    👉 Get your 100% FREE key here: ${p.signupUrl}`);
    }
  }

  console.log("\n🔵 SUBSCRIPTION PROVIDERS (Pooled Quota):");
  for (const p of subProviders) {
    const statusTag = p.hasKey ? "✅ Pooled" : "⚪ Not Configured";
    console.log(`  • ${p.displayName} [${statusTag}]`);
    console.log(`    Env: ${p.authEnv ? `$${p.authEnv}` : "(none required)"}`);
    if (!p.hasKey && p.signupUrl) {
      console.log(`    👉 Add your subscription key: ${p.signupUrl}`);
    }
  }

  // Stated, not silent. The list is a nudge suppressor, not a secret: a user who forgot they
  // suppressed something would otherwise wonder why a provider they configured never appears.
  const quiet = cfg?.leaveMeAlone ?? [];
  if (quiet.length > 0) {
    console.log(`\n🔇 Suppressed via leave_me_alone (still visible in \`llm-relay keys\` and /registry):`);
    console.log(`  ${quiet.join(", ")}`);
  }

  console.log("\n💡 QUICK START:");
  console.log("  Export your API keys in terminal or add them to your environment:");
  console.log("    export NVIDIA_API_KEY=\"nvapi-...\"");
  console.log("    export GROQ_API_KEY=\"gsk_...\"");
  console.log("    export GEMINI_API_KEY=\"AIzaSy...\"\n");
}

/** Interactively prompt for missing API keys and save them to ~/.llm-relay/.env */
export async function runInteractiveOnboarding(cfg?: Config): Promise<void> {
  printOnboardingGuide(cfg);

  const statuses = getOnboardingStatusList(cfg);
  const missing = statuses.filter((s) => !s.hasKey);

  if (missing.length === 0) {
    console.log("🎉 All configured provider API keys are active! You are ready to run llm-relay.\n");
    return;
  }

  if (!process.stdin.isTTY) {
    console.log("Non-interactive terminal detected. Set environment variables to enable providers.\n");
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const envPath = join(homedir(), ".llm-relay", ".env");
  const addedKeys: Record<string, string> = {};

  const ask = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, (ans) => resolve(ans.trim())));

  console.log("Would you like to enter API keys now to save to ~/.llm-relay/.env?");
  const proceed = await ask("Enter 'y' to set up keys now (or press Enter to skip): ");

  if (proceed.toLowerCase() === "y" || proceed.toLowerCase() === "yes") {
    for (const p of missing) {
      console.log(`\nSetting up ${p.displayName}`);
      if (p.signupUrl) console.log(`Signup URL: ${p.signupUrl}`);
      const val = await ask(`Enter key for \$${p.authEnv} (leave blank to skip): `);
      if (val) {
        process.env[p.authEnv] = val;
        addedKeys[p.authEnv] = val;
        console.log(`  Added \$${p.authEnv}!`);
      }
    }

    if (Object.keys(addedKeys).length > 0) {
      try {
        const envLines = Object.entries(addedKeys)
          .map(([k, v]) => `${k}="${v}"`)
          .join("\n");
        appendFileSync(envPath, "\n" + envLines + "\n");
        console.log(`\n✅ Saved ${Object.keys(addedKeys).length} key(s) to ${envPath}\n`);
      } catch {
        console.log("\n⚠️ Could not write to ~/.llm-relay/.env, but keys are active for this session.\n");
      }
    }
  }

  rl.close();
}
