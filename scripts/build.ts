// Compile the pg-analyser binary with the git commit baked in, so a stale
// install can tell the user it is stale (src/buildinfo.ts). Runs without a
// shell: every argument is passed as-is.
const git = (...args: string[]): string => {
  const res = Bun.spawnSync(["git", ...args], { stderr: "ignore" });
  return res.exitCode === 0 ? res.stdout.toString().trim() : "";
};

const sha = git("rev-parse", "--short=7", "HEAD");
const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
const buildSha = sha ? `${sha}${dirty ? "-dirty" : ""}` : "";

const res = Bun.spawnSync(
  [
    "bun",
    "build",
    "./src/index.ts",
    "--compile",
    "--outfile",
    "pg-analyser",
    "--define",
    `PG_ANALYSER_BUILD_SHA=${JSON.stringify(buildSha)}`,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if (res.exitCode !== 0) process.exit(res.exitCode ?? 1);
console.log(`built pg-analyser ${buildSha || "(no git sha)"}`);
