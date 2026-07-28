import fs from "fs";
import path from "path";

const apiKey = process.env.NVIDIA_API_KEY;
if (!apiKey) {
  console.error("NVIDIA_API_KEY is not set in environment.");
  process.exit(1);
}

const BASE_URL = "https://integrate.api.nvidia.com/v1";
const MODEL = "meta/llama-3.1-70b-instruct";

const auditReportPath = path.resolve(".audit-tools/audit/audit-report.md");
if (!fs.existsSync(auditReportPath)) {
  console.error(`Audit report not found at ${auditReportPath}`);
  process.exit(1);
}

const auditReportText = fs.readFileSync(auditReportPath, "utf-8");

// Extract findings from audit report
const findingBlocks = [];
const lines = auditReportText.split("\n");
let currentFinding = null;

for (let line of lines) {
  if (line.startsWith("### ") && (line.includes(" — ") || line.includes(" - "))) {
    if (currentFinding) {
      findingBlocks.push(currentFinding);
    }
    const titlePart = line.replace(/^###\s+/, "");
    const parts = titlePart.split(/\s+[—-]\s+/);
    currentFinding = {
      id: parts[0]?.trim() || "",
      title: parts[1]?.trim() || titlePart,
      content: [line],
    };
  } else if (currentFinding) {
    currentFinding.content.push(line);
  }
}
if (currentFinding) {
  findingBlocks.push(currentFinding);
}

console.log(`Found ${findingBlocks.length} total findings in audit report.`);

// Filter high and key medium findings (up to top 15)
const targetFindings = findingBlocks.slice(0, 12);

async function verifyFindingWithNim(finding) {
  const prompt = `You are a expert security and software engineering code auditor.
Verify the following code audit finding for the Node.js TypeScript repository "llm-relay":

Finding ID: ${finding.id}
Title: ${finding.title}
Details:
${finding.content.join("\n")}

Respond ONLY with a JSON object in this exact schema:
{
  "finding_id": "${finding.id}",
  "verdict": "CONFIRMED_TRUE_POSITIVE" | "FALSE_POSITIVE" | "NEEDS_CLARIFICATION",
  "confidence": "high" | "medium" | "low",
  "analysis": "<2-3 sentence technical verification explaining why the vulnerability/bug exists or does not exist>",
  "recommended_fix": "<concise step-by-step code remediation>"
}`;

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.1,
        max_tokens: 1024,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        finding_id: finding.id,
        verdict: "ERROR",
        confidence: "low",
        analysis: `NIM API HTTP ${res.status}: ${errText}`,
        recommended_fix: "N/A",
      };
    }

    const data = await res.json();
    const rawContent = data.choices[0]?.message?.content || "";
    
    // Extract JSON from markdown fences if present
    const match = rawContent.match(/```(?:json)?\s*([\s\S]*?)\`\`\`/) || [null, rawContent];
    const parsed = JSON.parse(match[1].trim());
    return parsed;
  } catch (err) {
    return {
      finding_id: finding.id,
      verdict: "ERROR",
      confidence: "low",
      analysis: `Error invoking NIM: ${err.message}`,
      recommended_fix: "N/A",
    };
  }
}

async function runVerification() {
  console.log(`Starting NVIDIA NIM verification via ${MODEL}...`);
  const results = [];

  for (let i = 0; i < targetFindings.length; i++) {
    const f = targetFindings[i];
    console.log(`[${i + 1}/${targetFindings.length}] Verifying ${f.id}: ${f.title}...`);
    const res = await verifyFindingWithNim(f);
    results.push(res);
    console.log(`  -> Verdict: ${res.verdict} (Confidence: ${res.confidence})`);
  }

  const outPath = path.resolve(".audit-tools/audit/nim-verification-results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
  console.log(`\nVerification complete. Saved ${results.length} results to ${outPath}`);
}

runVerification().catch(err => {
  console.error("Verification script failed:", err);
  process.exit(1);
});
