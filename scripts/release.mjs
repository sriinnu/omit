#!/usr/bin/env node
// Usage: npm run release -- <patch|minor|major>
// main requires PRs, so the version bump rides one: branch → PR → merge →
// tag the merge → push the tag (publish.yml publishes to npm with
// provenance) → GitHub release → Homebrew tap formula.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bump = process.argv[2];
if (!["patch", "minor", "major"].includes(bump)) {
  console.error("usage: npm run release -- <patch|minor|major>");
  process.exit(64);
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const sleep = (s) => execFileSync("sleep", [String(s)]);
const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

// `gh pr checks` exits 8 while checks are pending and 1 before any are
// reported, so read its JSON without letting the exit status throw.
// A PR that reports no checks after a minute has none to wait for.
const waitForChecks = (pr, repo) => {
  for (let i = 0; i < 80; i++) {
    const res = spawnSync("gh", ["pr", "checks", pr, "-R", repo, "--json", "bucket"],
      { encoding: "utf8" });
    let buckets = [];
    try { buckets = JSON.parse(res.stdout).map((c) => c.bucket); } catch {}
    if (buckets.some((b) => ["fail", "cancel"].includes(b)))
      fail(`${repo}#${pr} checks failed`);
    if (buckets.length && buckets.every((b) => ["pass", "skipping"].includes(b))) return;
    if (!buckets.length && i >= 4) return;
    sleep(15);
  }
  fail(`${repo}#${pr} checks still pending after 20 minutes`);
};

// --- preflight
if (out("git", ["branch", "--show-current"]) !== "main")
  fail("release from main");
if (out("git", ["status", "--porcelain"])) fail("working tree is not clean");
run("git", ["fetch", "origin", "main"]);
if (out("git", ["rev-parse", "HEAD"]) !== out("git", ["rev-parse", "origin/main"]))
  fail("main is not in sync with origin/main");
run("gh", ["auth", "status"]);

// --- bump without tagging (tests run via preversion); the tag comes later,
// on the merged commit, so it points at what main actually contains
run("npm", ["version", bump, "--no-git-tag-version"]);
const version = out("node", ["-p", "require('./package.json').version"]);
const tag = `v${version}`;
const pkg = out("node", ["-p", "require('./package.json').name"]);

// --- the version bump rides a PR; main does not take direct pushes
const branch = `release/${tag}`;
run("git", ["switch", "-c", branch]);
run("git", ["commit", "-am", `Release ${tag}`]);
run("git", ["push", "-u", "origin", branch]);
const pr = out("gh", [
  "pr", "create", "--title", `Release ${tag} — version bump`,
  "--body", `Cut by scripts/release.mjs. Tag and publish follow the merge.`,
]);
const prNumber = pr.split("/").pop();
waitForChecks(prNumber, "sriinnu/omit");
run("gh", ["pr", "merge", prNumber, "--squash", "--delete-branch"]);

run("git", ["switch", "main"]);
run("git", ["pull", "origin", "main"]);
if (out("node", ["-p", "require('./package.json').version"]) !== version)
  fail(`main does not contain ${version} after the merge — refusing to tag`);

// --- tag the merge and push the tag; publish.yml takes it from here
run("git", ["tag", "-m", version, tag]);
run("git", ["push", "origin", tag]);

// --- watch the publish workflow; a failed publish aborts the release
let runId = null;
for (let i = 0; i < 30 && !runId; i++) {
  const runs = JSON.parse(
    out("gh", ["run", "list", "--workflow", "publish.yml", "--branch", tag,
      "--json", "databaseId", "--limit", "1"]),
  );
  if (runs.length) runId = runs[0].databaseId;
  else sleep(2);
}
if (!runId) fail("publish workflow never started for the tag");
run("gh", ["run", "watch", String(runId), "--exit-status", "--interval", "10"]);

// --- GitHub release
run("gh", ["release", "create", tag, "--verify-tag", "--generate-notes"]);

// --- wait for npm to serve the version (registry read-replica lag)
let live = false;
for (let i = 0; i < 30 && !live; i++) {
  try {
    out("npm", ["view", `${pkg}@${version}`, "version"]);
    live = true;
  } catch {
    sleep(10);
  }
}
if (!live) fail(`${pkg}@${version} never appeared on npm`);

// --- Homebrew tap
const tarball = out("npm", ["view", `${pkg}@${version}`, "dist.tarball"]);
const tmp = mkdtempSync(join(tmpdir(), "omit-release-"));
const tgz = join(tmp, "pkg.tgz");
run("curl", ["-fsSL", tarball, "-o", tgz]);
const sha256 = out("shasum", ["-a", "256", tgz]).split(" ")[0];

const tap = join(tmp, "tap");
run("gh", ["repo", "clone", "sriinnu/homebrew-tap", tap, "--", "--depth", "1"]);
mkdirSync(join(tap, "Formula"), { recursive: true });
writeFileSync(join(tap, "Formula", "omit.rb"), `class Omit < Formula
  desc "Editorial discipline for AI coding agents: draft less, cite everything, cut last"
  homepage "https://github.com/sriinnu/omit"
  url "${tarball}"
  sha256 "${sha256}"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match "usage: omit", shell_output(bin/"omit")
  end
end
`);
run("git", ["-C", tap, "add", "Formula/omit.rb"]);
// the tap's main is PR-gated too
if (out("git", ["-C", tap, "status", "--porcelain"])) {
  const tapBranch = `omit-${version}`;
  run("git", ["-C", tap, "switch", "-c", tapBranch]);
  run("git", ["-C", tap, "commit", "-m", `omit ${version}`]);
  run("git", ["-C", tap, "push", "-u", "origin", tapBranch]);
  const tapPr = out("gh", ["pr", "create", "-R", "sriinnu/homebrew-tap",
    "--head", tapBranch, "--title", `omit ${version}`,
    "--body", "Cut by sriinnu/omit scripts/release.mjs."]).split("/").pop();
  waitForChecks(tapPr, "sriinnu/homebrew-tap");
  run("gh", ["pr", "merge", tapPr, "-R", "sriinnu/homebrew-tap", "--squash", "--delete-branch"]);
}

console.log(`
released ${pkg}@${version}
  npm:      https://www.npmjs.com/package/${pkg}
  github:   https://github.com/sriinnu/omit/releases/tag/${tag}
  homebrew: brew install sriinnu/tap/omit`);
