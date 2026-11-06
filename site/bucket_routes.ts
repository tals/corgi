/** Routes without a script bypass Workers, including its request quota. */
export const patterns = [
  "corgi.computer/install.sh*",
  "corgi.computer/channels/*",
  "corgi.computer/releases/*",
  "corgi.computer/test/*",
  "corgi.computer/corgi.computer.git*",
];

interface Route {
  id: string;
  pattern: string;
  script?: string | null;
}
type Request = <T>(path: string, body?: { pattern: string }) => Promise<T>;

export async function ensure(request: Request) {
  const zones = await request<{ id: string }[]>("/zones?name=corgi.computer");
  if (zones.length !== 1) throw new Error("Expected exactly one corgi.computer zone");
  const path = `/zones/${zones[0].id}/workers/routes`;
  const routes = await request<Route[]>(path);
  // Check all conflicts before changing anything. Never take over another Worker.
  for (const pattern of patterns) {
    const existing = routes.find(route => route.pattern === pattern);
    if (existing?.script) throw new Error(`Bucket bypass ${pattern} belongs to ${existing.script}`);
  }
  for (const pattern of patterns)
    if (!routes.some(route => route.pattern === pattern)) await request(path, { pattern });
  const verified = await request<Route[]>(path);
  for (const pattern of patterns)
    if (!verified.some(route => route.pattern === pattern && !route.script))
      throw new Error(`Bucket bypass missing: ${pattern}`);
}

export async function prepare() {
  // Wrangler cannot declare scriptless routes; use its credentials for the API.
  const auth = Bun.spawnSync([process.execPath, "run", "wrangler", "auth", "token", "--json"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "inherit",
  });
  if (!auth.success) throw new Error("Could not read Wrangler credentials");
  const credentials = JSON.parse(auth.stdout.toString()) as
    { type: "oauth" | "api_token"; token: string } | { type: "api_key"; key: string; email: string };
  const headers = new Headers({ "Content-Type": "application/json" });
  if (credentials.type === "api_key") {
    headers.set("X-Auth-Key", credentials.key);
    headers.set("X-Auth-Email", credentials.email);
  } else headers.set("Authorization", `Bearer ${credentials.token}`);
  await ensure(async <T>(path: string, body?: { pattern: string }): Promise<T> => {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await response.json()) as { success: boolean; result: T };
    if (!response.ok || !data.success) throw new Error(`Cloudflare route request failed: HTTP ${response.status}`);
    return data.result;
  });
}
