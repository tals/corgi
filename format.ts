import * as tooling from "./scripts/tooling";

process.exitCode = await tooling.prettier(process.argv.includes("--check") ? "check" : "write");
