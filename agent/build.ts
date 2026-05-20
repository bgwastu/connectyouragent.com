#!/usr/bin/env bun
import { $ } from "bun";

const targets = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
];

const outDir = "./public/bin";

await $`mkdir -p ${outDir}`;

for (const target of targets) {
  const outName = target === "bun-windows-x64"
    ? "cya-bridge-windows-x64.exe"
    : `cya-bridge-${target.replace("bun-", "")}`;

  console.log(`Building ${target} -> ${outName}`);
  await $`bun build --compile --target=${target} --outfile=${outDir}/${outName} ./agent/agent.ts`;
}

console.log("Done. Binaries in", outDir);
