import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMailer } from "./registry";
import { consoleMailer } from "./console";
import { resendMailer } from "./resend";

const ORIGINAL_KEY = process.env.RESEND_API_KEY;

beforeEach(() => {
  delete process.env.RESEND_API_KEY;
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_KEY;
});

describe("getMailer", () => {
  it("defaults to ConsoleMailer when no RESEND_API_KEY is configured", () => {
    expect(getMailer()).toBe(consoleMailer);
  });

  it("selects ResendMailer once RESEND_API_KEY is set", () => {
    process.env.RESEND_API_KEY = "a-real-key";
    expect(getMailer()).toBe(resendMailer);
  });
});
