#!/usr/bin/env node
// Usage: npm run token:sync
// Pushes the npm token from ~/.npmrc into the repo's NPM_TOKEN secret.
// Verifies the token authenticates BEFORE pushing — a dead token never
// reaches CI. Prints metadata only, never the token.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const fail = (msg) => {
  console.error(`token:sync: ${msg}`);
  process.exit(1);
};
const out = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();

const rc = readFileSync(join(homedir(), ".npmrc"), "utf8");
const token = rc
  .split("\n")
  .find((l) => l.includes("registry.npmjs.org/:_authToken="))
  ?.split("=")
  .slice(1)
  .join("=")
  .trim();
if (!token) fail("no registry.npmjs.org _authToken in ~/.npmrc");
if (!token.startsWith("npm_"))
  fail(`token does not start with npm_ (length ${token.length}) — refusing to push`);

// npm whoami reads the same ~/.npmrc we just parsed, so this proves the
// token itself, not some other credential.
const who = out("npm", ["whoami", "--registry=https://registry.npmjs.org"]);
console.log(`token authenticates as ${who} (length ${token.length})`);

out("gh", ["secret", "set", "NPM_TOKEN", "-R", "sriinnu/omit"], { input: token });
console.log("NPM_TOKEN updated on sriinnu/omit");
