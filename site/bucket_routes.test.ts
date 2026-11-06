import { expect, test } from "bun:test";
import * as bucketRoutes from "./bucket_routes";

function api(initial: { id: string; pattern: string; script?: string | null }[] = []) {
  const routes = [...initial];
  const created: string[] = [];
  return {
    routes,
    created,
    request: async <T>(path: string, body?: { pattern: string }): Promise<T> => {
      if (path === "/zones?name=corgi.computer") return [{ id: "zone" }] as T;
      expect(path).toBe("/zones/zone/workers/routes");
      if (body) {
        created.push(body.pattern);
        routes.push({ id: String(routes.length), pattern: body.pattern });
      }
      return [...routes] as T;
    },
  };
}

test("creates missing bypasses without changing existing routes; repeated publishes are idempotent", async () => {
  const existing = { id: "site", pattern: "corgi.computer/en/*", script: "corgi-site" };
  const mock = api([existing, { id: "installer", pattern: bucketRoutes.patterns[0], script: null }]);
  await bucketRoutes.ensure(mock.request);
  expect(mock.created).toEqual(bucketRoutes.patterns.slice(1));
  await bucketRoutes.ensure(mock.request);
  expect(mock.created).toEqual(bucketRoutes.patterns.slice(1));
  expect(mock.routes[0]).toEqual(existing);
});

test("refuses conflicting Workers before creating any routes", async () => {
  const mock = api([{ id: "other", pattern: bucketRoutes.patterns.at(-1)!, script: "another-worker" }]);
  await expect(bucketRoutes.ensure(mock.request)).rejects.toThrow("belongs to another-worker");
  expect(mock.created).toEqual([]);
});

test("refuses deployment when bypass creation is not reflected in the route list", async () => {
  await expect(
    bucketRoutes.ensure(
      async <T>(path: string): Promise<T> => (path.startsWith("/zones?") ? [{ id: "zone" }] : []) as T,
    ),
  ).rejects.toThrow("Bucket bypass missing");
});
