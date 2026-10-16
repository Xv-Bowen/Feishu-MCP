import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";

// This is a release hygiene check, not a substitute for review or secret rotation.
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean).sort();
if (!files.length) throw new Error("Stage the intended source files first.");
const manifestName = "release-manifest.json";
const failures = [];
const checks = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ["deployment identity", /\bappgprj_[a-f0-9]{24,}\b/i],
  ["provider application identity", /\bcli_[a-f0-9]{12,}\b/],
];
const manifest = [];
for (const file of files) {
  if (file === manifestName) continue;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) { failures.push(`${file}: unexpected file type`); continue; }
  if (/(^|\/)(?:\.env(?!.*\.example$)|\.dev\.vars|node_modules|\.sites-runtime|\.wrangler|\.git)(?:\/|$)/.test(file) || /\.(?:sqlite3?|db|tsbuildinfo|log|pem)$/.test(file)) failures.push(`${file}: runtime/private artifact`);
  const data = readFileSync(file);
  if (!data.includes(0)) {
    const text = data.toString("utf8");
    for (const [label, pattern] of checks) if (pattern.test(text)) failures.push(`${file}: ${label}`);
  }
  manifest.push({ path: file, bytes: data.length, mode: stat.mode & 0o111 ? "100755" : "100644", sha256: createHash("sha256").update(data).digest("hex") });
}
const hosting = JSON.parse(readFileSync(".openai/hosting.json", "utf8"));
if (hosting.project_id) failures.push("Remove deployment project_id before publishing a reusable template.");
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
const result = { version: 1, algorithm: "sha256", excluded_self: manifestName, files: manifest };
if (process.argv.includes("--write")) {
  writeFileSync(manifestName, JSON.stringify(result, null, 2) + "\n");
  console.log(`Wrote manifest for ${manifest.length} files. Review and stage it.`);
} else {
  const expected = JSON.parse(readFileSync(manifestName, "utf8"));
  if (JSON.stringify(expected) !== JSON.stringify(result)) throw new Error("File inventory/hash mismatch. Review changes, then regenerate the manifest.");
  console.log(`PASS: ${manifest.length} file hashes, modes, template identity and release hygiene.`);
}
