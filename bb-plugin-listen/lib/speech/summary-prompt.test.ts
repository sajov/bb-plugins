import { describe, expect, it } from "vitest";
import { DEFAULT_SUMMARY_PROMPT, buildSummaryPrompt, languageName } from "./summary-prompt.js";

describe("languageName", () => {
  it("names a tag in English", () => {
    expect(languageName("de")).toBe("German");
    expect(languageName("en-GB")).toBe("British English");
  });

  it("falls back to English for an empty tag", () => {
    expect(languageName("")).toBe("English");
  });
});

describe("buildSummaryPrompt", () => {
  it("fills the language into the default prompt", () => {
    const prompt = buildSummaryPrompt(DEFAULT_SUMMARY_PROMPT, "de");
    expect(prompt).toContain("in German");
    expect(prompt).not.toContain("{language}");
  });

  it("uses the default prompt when the template is empty", () => {
    expect(buildSummaryPrompt("  ", "fr")).toContain("in French");
  });

  it("appends the language to a custom prompt without placeholder", () => {
    const prompt = buildSummaryPrompt("Summarize this.\nMessage:", "es");
    expect(prompt).toContain("Write the summary in Spanish.");
  });
});
