import { describe, expect, it } from "vitest";
import * as z from "zod";
import { countParam, parseQuery } from "#src/schema.js";
import { ArrivalsQuery, ArrivalsResponse } from "#src/subway/schemas.js";

const Query = z.object({ name: z.string({ error: "name is required" }), n: countParam("n", 3, 10) });
const parse = (qs: string) => parseQuery(Query, new URL(`https://x.test/${qs}`));

describe("parseQuery", () => {
  it.each([
    ["?name=a", { name: "a", n: 3 }],
    ["?name=a&n=", { name: "a", n: 3 }],
    ["?name=a&n=7", { name: "a", n: 7 }],
    ["?name=a&n=99", { name: "a", n: 10 }],
    ["?name=a&name=b&n=2&n=5", { name: "a", n: 2 }],
    ["?name=a&other=1", { name: "a", n: 3 }],
  ])("parses %s", (qs, query) => {
    expect(parse(qs)).toEqual({ ok: true, query });
  });

  it.each([
    ["", "name is required"],
    ["?name=", "name is required"],
    ["?name=a&n=0", "n must be a positive integer"],
    ["?name=a&n=-2", "n must be a positive integer"],
    ["?name=a&n=two", "n must be a positive integer"],
  ])("rejects %s with a 400", async (qs, error) => {
    const r = parse(qs);
    if (r.ok) throw new Error("expected a failure");
    expect(r.response.status).toBe(400);
    expect(r.response.headers.get("cache-control")).toBe("no-store");
    expect(await r.response.json()).toEqual({ error });
  });
});

describe("arrivals schemas", () => {
  // A preview of the next step: the schemas already convert to JSON Schema, descriptions included.
  // `io: "input"` describes what a client sends (before defaults and transforms run).
  it("convert to JSON Schema", () => {
    const query = z.toJSONSchema(ArrivalsQuery, { io: "input" });
    expect(query.required).toEqual(["stop"]);
    expect(query.properties?.limit).toMatchObject({ type: "integer", minimum: 1, default: 3 });
    const response = z.toJSONSchema(ArrivalsResponse);
    expect(response.required).toEqual(["stop", "updatedAt", "groups"]);
    expect(response.additionalProperties).toBe(false);
  });
});
