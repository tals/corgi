import { expect, test } from "bun:test";
import { brand, brandOf, program } from "./process_name";

const name = (argv: string[]) => program(argv).name;

test("a program is named as tmux names a window", () => {
  expect(name(["vim", "notes.md"])).toBe("vim");
  expect(name(["/opt/homebrew/bin/htop"])).toBe("htop");
  // A path keeps its spaces; a title written over argv ends at the first.
  expect(name(["/Applications/Visual Studio Code.app/Contents/MacOS/Electron"])).toBe("Electron");
  expect(name(["npm run dev", "", ""])).toBe("npm");
  expect(name(["sshd: tal@pts/0"])).toBe("sshd");
  expect(name([])).toBe("");
});

test("a shell at its prompt is unnamed, and one running something is named for it", () => {
  for (const argv of [["-zsh"], ["fish"], ["tcsh"], ["/bin/bash", "--login"], ["zsh", "-i"]])
    expect(name(argv)).toBe("");
  expect(name(["bash", "deploy"])).toBe("deploy");
  expect(name(["/bin/sh", "./scripts/release.sh", "--dry-run"])).toBe("release");
  expect(name(["sh", "-c", "sleep 10; echo done"])).toBe("sh");
  expect(name(["bash", "-e", "deploy.sh"])).toBe("deploy");
  expect(name(["bash", "-o", "pipefail", "deploy.sh"])).toBe("deploy");
});

test("an interpreter is named for its script, module or package script", () => {
  expect(name(["node", "/opt/homebrew/bin/npm", "run", "dev"])).toBe("npm");
  expect(name(["node", "--inspect", "node_modules/vite/bin/vite.js"])).toBe("vite");
  expect(name(["node", "-r", "ts-node/register", "server.ts"])).toBe("server");
  expect(
    name([
      "/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python",
      "manage.py",
      "runserver",
    ]),
  ).toBe("manage");
  expect(name(["python3.12", "-m", "http.server", "8000"])).toBe("http.server");
  expect(name(["python3", "-u", "-m", "pytest", "-x"])).toBe("pytest");
  expect(name(["python", "file_name.py"])).toBe("file_name");
  expect(name(["python3", "-I", "-W", "ignore", "file_name.py"])).toBe("file_name");
  expect(name(["bun", "file_name.ts"])).toBe("file_name");
  expect(name(["node", "file_name.ts"])).toBe("file_name");
  expect(name(["node", "--", "file_name.js"])).toBe("file_name");
  expect(name(["bun", "run", "src/main.ts"])).toBe("main");
  expect(name(["bun", "run", "dev"])).toBe("dev");
  expect(name(["bun", "--watch", "run", "--hot", "dev"])).toBe("dev");
  expect(name(["bun", "run", "--cwd", "packages/app", "build"])).toBe("build");
  expect(name(["node", "run", "dev"])).toBe("dev");
  expect(name(["node", "--run", "dev"])).toBe("dev");
  // A subcommand, inline code or a bare interpreter keeps the interpreter's name.
  expect(name(["bun", "test"])).toBe("bun");
  expect(name(["bun", "run"])).toBe("bun");
  expect(name(["python3", "-c", "print(1)"])).toBe("python3");
  expect(name(["node", "-m", "dev"])).toBe("node");
  expect(name(["node"])).toBe("node");
  // A program merely named like one is not an interpreter.
  expect(name(["nodemon", "server.js"])).toBe("nodemon");
});

test("a program wears its own brand, or else its interpreter's", () => {
  expect(program(["node", "/opt/homebrew/bin/npm", "run", "dev"])).toEqual({ name: "npm", brand: "node" });
  expect(program(["node", "server.js"]).brand).toBe("node");
  expect(program(["python3.12", "-m", "http.server"]).brand).toBe("python");
  expect(program(["python", "file_name.py"]).brand).toBe("python");
  expect(program(["bun", "run", "dev"])).toEqual({ name: "dev", brand: "bun" });
  expect(program(["node", "run", "dev"])).toEqual({ name: "dev", brand: "node" });
  // A project's script, module or package script named like a branded program
  // still wears its interpreter's brand; only an installed one wears its own.
  expect(program(["bun", "./go.ts", "--temp"])).toEqual({ name: "go", brand: "bun" });
  expect(program(["bun", "run", "docker"])).toEqual({ name: "docker", brand: "bun" });
  expect(program(["python3", "-m", "git"])).toEqual({ name: "git", brand: "python" });
  expect(program(["python3", "tools/redis.py"]).brand).toBe("python");
  expect(program(["/usr/bin/nvim", "notes.md"]).brand).toBe("neovim");
  expect(program(["codex"]).brand).toBe("openai");
  expect(program(["uv", "run", "pytest"]).brand).toBe("python");
  // Wrappers that hand off keep their name: brew to Ruby, R to its own binary.
  const brew = [
    "/opt/homebrew/Library/Homebrew/vendor/portable-ruby/current/bin/ruby",
    "-W1",
    "--disable=gems,rubyopt",
    "/opt/homebrew/Library/Homebrew/brew.rb",
    "install",
    "jq",
  ];
  expect(program(brew)).toEqual({ name: "brew", brand: "homebrew" });
  expect(program(["/opt/homebrew/Cellar/r/4.4.1/lib/R/bin/exec/R"]).brand).toBe("r");
  expect(program(["python3.12", "/opt/homebrew/bin/ipython"]).brand).toBe("python");
  expect(program(["perl", "script.pl"]).brand).toBe("perl");
  expect(program(["hh_client", "check"]).brand).toBe("hack");
  expect(program(["node", "/opt/homebrew/bin/yarn", "dev"]).brand).toBe("node");
  for (const argv of [["-zsh"], ["bash", "deploy"], ["htop"]]) expect(program(argv).brand).toBeNull();
  // Agents' providers name theirs the same way.
  expect(brandOf("claude")).toBe("claude");
  expect(brandOf("opencode")).toBe("opencode");
  expect(brandOf("opencode2")).toBe("opencode");
  expect(brandOf("pi")).toBeNull();
  expect(brand("bun")).toBe("bun");
  expect(brand("brainfuck")).toBeNull();
});
