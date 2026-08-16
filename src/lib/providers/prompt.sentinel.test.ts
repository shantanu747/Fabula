import { describe, expect, it } from "vitest";
import { extractInventedMetadata } from "./prompt";

describe("extractInventedMetadata", () => {
  it("extracts metadata when expectHeader is true", async () => {
    const chunks = ["THEME: fantasy\nCHARACTERS: hero, villain\n---\nOnce upon a time..."];
    const chunksAsync = (async function*() { 
      for (const chunk of chunks) yield chunk; 
    })();
    
    const generator = extractInventedMetadata(chunksAsync, true);
    const textChunks = [];
    let result;
    do {
      result = await generator.next();
      if (!result.done) {
        textChunks.push(result.value);
      }
    } while (!result.done);
    
    // The return value (metadata) is in result.value when done=true
    expect(result.value).toEqual({ theme: "fantasy", characters: "hero, villain" });
  });

  it("passes through chunks when expectHeader is false", async () => {
    const chunks = ["Just prose text"];
    const chunksAsync = (async function*() { 
      for (const chunk of chunks) yield chunk; 
    })();
    
    const result: string[] = [];
    for await (const chunk of extractInventedMetadata(chunksAsync, false)) {
      result.push(chunk);
    }
    
    expect(result).toEqual(["Just prose text"]);
  });
});