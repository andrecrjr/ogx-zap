import { describe, expect, test } from "bun:test";
import { TtlCache } from "../src/cache";

function resolved(value: string) {
  return {
    originalUrl: `https://vt.tiktok.com/${value}`,
    destinationUrl: `https://www.tiktok.com/${value}`,
    title: value,
    description: "",
    image: "",
    metadataSource: "fallback" as const,
  };
}

describe("TtlCache", () => {
  test("evicts the least recently used entry when full", () => {
    const cache = new TtlCache(60_000, 2);

    cache.set("one", resolved("one"));
    cache.set("two", resolved("two"));
    expect(cache.get("one")?.title).toBe("one");

    cache.set("three", resolved("three"));

    expect(cache.get("one")?.title).toBe("one");
    expect(cache.get("two")).toBeUndefined();
    expect(cache.get("three")?.title).toBe("three");
    expect(cache.size).toBe(2);
  });
});
