#!/usr/bin/env node
// Usage: npm run release -- <patch|minor|major>
// Bumps + tags, pushes (publish.yml publishes to npm with provenance),
// cuts the GitHub release, then updates the Homebrew tap formula.

import { execFileSync } from "node:child_process";
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

// --- preflight
if (out("git", ["branch", "--show-current"]) !== "main")
  fail("release from main");
if (out("git", ["status", "--porcelain"])) fail("working tree is not clean");
run("git", ["fetch", "origin", "main"]);
if (out("git", ["rev-parse", "HEAD"]) !== out("git", ["rev-parse", "origin/main"]))
  fail("main is not in sync with origin/main");
run("gh", ["auth", "status"]);

// --- bump; preversion runs the tests, and a failure stops the release here
run("npm", ["version", bump]);
const version = out("node", ["-p", "require('./package.json').version"]);
const tag = `v${version}`;
const pkg = out("node", ["-p", "require('./package.json').name"]);

// --- push; the tag triggers publish.yml
run("git", ["push", "--follow-tags"]);

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
  desc "Omit needless code: editorial discipline for AI coding agents"
  homepage "https://github.com/sriinnu/omit"
  url "${tarball}"
  sha256 "${sha256}"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
  end

  test do
    assert_match "usage: omit", shell_output(bin/"omit")
  end
end
`);
run("git", ["-C", tap, "add", "Formula/omit.rb"]);
if (out("git", ["-C", tap, "status", "--porcelain"])) {
  run("git", ["-C", tap, "commit", "-m", `omit ${version}`]);
  run("git", ["-C", tap, "push"]);
}

console.log(`
released ${pkg}@${version}
  npm:      https://www.npmjs.com/package/${pkg}
  github:   https://github.com/sriinnu/omit/releases/tag/${tag}
  homebrew: brew install sriinnu/tap/omit`);
