import {test,expect} from "bun:test";
import {Endpoint} from "./crash";
test("a DSN names its project's envelope endpoint and key",()=>{
  const us=Endpoint.parse("https://17878b2c@o451.ingest.us.sentry.io/4512");expect(us.url).toBe("https://o451.ingest.us.sentry.io/api/4512/envelope/");expect(us.proto).toBe("=https");expect(us.auth).toContain("sentry_key=17878b2c,");
  const hosted=Endpoint.parse("http://public:secret@127.0.0.1:9000/prefix/7");expect(hosted.url).toBe("http://127.0.0.1:9000/prefix/api/7/envelope/");expect(hosted.proto).toBe("=http");expect(hosted.auth).toContain("sentry_key=public,");
});
