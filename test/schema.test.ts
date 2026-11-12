import { describe, expect, it } from "vitest";
import * as z from "zod";
import { countParam, parseQuery, requiredParam } from "#src/schema.js";
import { ArrivalsQuery, ArrivalsResponse } from "#src/subway/schemas.js";

const Query = z.object({ name: requiredParam("name", "A name."), n: countParam("n", 3, 10, "How many.") });
const parse = (qs: string) => parseQuery(Query, new URL(`https://x.test/${qs}`));

describe("parseQuery", () => {
  it.each([
    ["?name=a", { name: "a", n: 3 }],
    ["?name=a&n=", { name: "a", n: 3 }],
    ["?name=a&n=7", { name: "a", n: 7 }],
    ["?name=a&n=99", { name: "a", n: 10 }],
    ["?name=a&n=99999999999999999999", { name: "a", n: 10 }],
    ["?name=a&n=&n=5", { name: "a", n: 3 }],
    ["?name=a&constructor=b", { name: "a", n: 3 }],
    ["?name=a&name=b&n=2&n=5", { name: "a", n: 2 }],
    ["?name=a&other=1", { name: "a", n: 3 }],
    ["?name=%20a%20&n=05", { name: "a", n: 5 }],
  ])("parses %s", (qs, query) => {
    expect(parse(qs)).toEqual({ ok: true, query });
  });

  it.each([
    ["", "name is required"],
    ["?name=", "name is required"],
    ["?name=%20", "name is required"],
    ["?name=&name=b", "name is required"],
    ["?name=a&n=0", "n must be a positive integer"],
    ["?name=a&n=-2", "n must be a positive integer"],
    ["?name=a&n=two", "n must be a positive integer"],
    // Number() reads these, the digits-only rule (same as intParam) doesn't.
    ["?name=a&n=1e1", "n must be a positive integer"],
    ["?name=a&n=0x10", "n must be a positive integer"],
    ["?name=a&n=%205", "n must be a positive integer"],
  ])("rejects %s with a 400", async (qs, error) => {
    const r = parse(qs);
    if (r.ok) throw new Error("expected a failure");
    expect(r.response.status).toBe(400);
    expect(r.response.headers.get("cache-control")).toBe("no-store");
    expect(await r.response.json()).toEqual({ error });
  });
});

describe("arrivals schemas", () => {
  // The base of the generated docs. `io: "input"` describes what a client sends; the default has
  // to survive into it (why countParam uses .prefault()).
  it("convert to JSON Schema with defaults and descriptions", () => {
    const query = z.toJSONSchema(ArrivalsQuery, { io: "input" });
    expect(query.required).toEqual(["stop"]);
    expect(query.properties?.limit).toMatchObject({
      type: "string",
      default: "3",
      description: expect.stringMatching(/^Trains per route and direction\. Default 3, at most 10/),
    });
    expect(z.toJSONSchema(ArrivalsResponse).additionalProperties).toBe(false);
  });
});
