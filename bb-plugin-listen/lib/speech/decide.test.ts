/**
 * Tests for the speaking decisions.
 *
 * Both directions matter here. A rule that never lets anything through looks
 * identical to a switched-off feature — no error, no sound — so every "does
 * not speak" case is paired with one that does.
 */

import { describe, expect, it } from "vitest";
import { shouldSpeak, speaksAloud, spokenText } from "./decide";

const answer = "I fixed the failing test and pushed the change.";
const noWorkers = new Set<string>();

describe("shouldSpeak", () => {
  it("speaks a finished answer in a normal thread", () => {
    expect(
      shouldSpeak(
        { id: "t1" },
        { enabled: true, override: null, lastAssistantText: answer, ourWorkers: noWorkers },
      ),
    ).toEqual({ speak: true });
  });

  it("stays quiet while the setting is off", () => {
    expect(
      shouldSpeak(
        { id: "t1" },
        { enabled: false, override: null, lastAssistantText: answer, ourWorkers: noWorkers },
      ),
    ).toEqual({ speak: false, reason: "disabled" });
  });

  it("stays quiet when the turn produced no answer", () => {
    expect(
      shouldSpeak(
        { id: "t1" },
        { enabled: true, override: null, lastAssistantText: null, ourWorkers: noWorkers },
      ),
    ).toEqual({ speak: false, reason: "no-answer" });
  });

  it("stays quiet when the answer is only whitespace", () => {
    expect(
      shouldSpeak(
        { id: "t1" },
        { enabled: true, override: null, lastAssistantText: "   \n  ", ourWorkers: noWorkers },
      ),
    ).toEqual({ speak: false, reason: "no-answer" });
  });

  it("does not speak its own summary thread", () => {
    // The loop this prevents: summarizing a summary, which produces another
    // idle event, forever.
    expect(
      shouldSpeak(
        { id: "worker-1" },
        {
          enabled: true,
          override: null,
          lastAssistantText: answer,
          ourWorkers: new Set(["worker-1"]),
        },
      ),
    ).toEqual({ speak: false, reason: "own-worker" });
  });

  it("still speaks a normal thread while a summary worker is running", () => {
    expect(
      shouldSpeak(
        { id: "t1" },
        {
          enabled: true,
          override: null,
          lastAssistantText: answer,
          ourWorkers: new Set(["worker-1"]),
        },
      ),
    ).toEqual({ speak: true });
  });

  it("does not speak another plugin's hidden worker", () => {
    expect(
      shouldSpeak(
        { id: "t2", visibility: "hidden" },
        { enabled: true, override: null, lastAssistantText: answer, ourWorkers: noWorkers },
      ),
    ).toEqual({ speak: false, reason: "hidden-thread" });
  });

  it("speaks a thread that is explicitly visible", () => {
    expect(
      shouldSpeak(
        { id: "t3", visibility: "visible" },
        { enabled: true, override: null, lastAssistantText: answer, ourWorkers: noWorkers },
      ),
    ).toEqual({ speak: true });
  });
});

describe("the thread's own speaker button", () => {
  it("speaks in a thread that switched it on, while the setting is off", () => {
    expect(
      shouldSpeak(
        { id: "t1" },
        { enabled: false, override: true, lastAssistantText: answer, ourWorkers: noWorkers },
      ),
    ).toEqual({ speak: true });
  });

  it("stays quiet in a thread that switched it off, while the setting is on", () => {
    expect(
      shouldSpeak(
        { id: "t1" },
        { enabled: true, override: false, lastAssistantText: answer, ourWorkers: noWorkers },
      ),
    ).toEqual({ speak: false, reason: "disabled" });
  });

  it("follows the setting in a thread that never chose", () => {
    // Both directions, or "follows the setting" could mean "always off".
    expect(speaksAloud({ enabled: true, override: null })).toBe(true);
    expect(speaksAloud({ enabled: false, override: null })).toBe(false);
  });

  it("does not let a thread's choice override the loop guard", () => {
    // A summary worker must stay silent even if something switched it on.
    expect(
      shouldSpeak(
        { id: "worker-1" },
        {
          enabled: false,
          override: true,
          lastAssistantText: answer,
          ourWorkers: new Set(["worker-1"]),
        },
      ),
    ).toEqual({ speak: false, reason: "own-worker" });
  });
});

describe("a thread with no global default (every thread starts silent)", () => {
  // The server now always calls these with `enabled: false` — there is no
  // more setting to fall back to. Only the thread's own button speaks.
  it("stays silent when the thread never pressed its speaker button", () => {
    expect(
      shouldSpeak(
        { id: "t1" },
        { enabled: false, override: null, lastAssistantText: answer, ourWorkers: noWorkers },
      ),
    ).toEqual({ speak: false, reason: "disabled" });
  });

  it("speaks once the thread's own button turned it on", () => {
    expect(
      shouldSpeak(
        { id: "t1" },
        { enabled: false, override: true, lastAssistantText: answer, ourWorkers: noWorkers },
      ),
    ).toEqual({ speak: true });
  });
});

describe("spokenText", () => {
  it("uses the summary when there is one", () => {
    expect(spokenText("The test passes now.", answer)).toEqual({
      text: "The test passes now.",
      source: "summary",
    });
  });

  it("falls back to the answer when the summary failed", () => {
    // The point of the fallback: silence would read as a broken feature.
    const result = spokenText(null, answer);
    expect(result?.source).toBe("answer");
    expect(result?.text).toContain("fixed the failing test");
  });

  it("falls back when the summary came back empty", () => {
    expect(spokenText("   ", answer)?.source).toBe("answer");
  });

  it("strips markdown and code out of a fallback answer", () => {
    const markdown = [
      "## Done",
      "",
      "Fixed the **flaky** test in `runner.ts`:",
      "",
      "```ts",
      "expect(result).toBe(42);",
      "```",
      "",
      "See https://example.com/pr/7 for details.",
    ].join("\n");

    const result = spokenText(null, markdown);
    expect(result).not.toBeNull();
    const text = result!.text;
    // What must be gone…
    expect(text).not.toContain("```");
    expect(text).not.toContain("expect(result)");
    expect(text).not.toContain("**");
    expect(text).not.toContain("https://");
    // …and what must survive, or the filter is just deleting everything.
    expect(text).toContain("Done");
    expect(text).toContain("flaky");
  });

  it("returns nothing when an answer holds no speakable words", () => {
    expect(spokenText(null, "```\nconst x = 1;\n```")).toBeNull();
  });

  it("speaks a summary even when the answer itself was unspeakable", () => {
    expect(spokenText("I changed one line.", "```\nconst x = 1;\n```")).toEqual({
      text: "I changed one line.",
      source: "summary",
    });
  });
});

describe("a summary is cleaned up too", () => {
  it("strips markdown a small model left in its summary", () => {
    // Measured: llama3.2 returns `settings.onChange` in backticks even when
    // the prompt asks for plain prose, and backticks get read aloud.
    const result = spokenText(
      "Changes now apply through `settings.onChange` **immediately**.",
      answer,
    );
    expect(result?.source).toBe("summary");
    expect(result?.text).not.toContain("`");
    expect(result?.text).not.toContain("**");
    // The words themselves must survive the cleanup.
    expect(result?.text).toContain("settings.onChange");
    expect(result?.text).toContain("immediately");
  });

  it("leaves a clean summary exactly as it is", () => {
    expect(spokenText("The tests pass again.", answer)).toEqual({
      text: "The tests pass again.",
      source: "summary",
    });
  });
});

describe("language-specific cleanup", () => {
  it("spells numbers out in English, where the words fit", () => {
    const result = spokenText("49 tests pass.", answer, "en");
    expect(result?.text).toContain("forty-nine");
  });

  it("leaves numbers alone in German, which the English rules would mangle", () => {
    // Measured: "49 Tests" came out as "forty-nine Tests" through a German
    // voice before the language reached the filter.
    const result = spokenText("49 Tests laufen durch.", answer, "de");
    expect(result?.text).toContain("49");
    expect(result?.text).not.toContain("forty-nine");
  });

  it("still applies the English rules when no language is given", () => {
    expect(spokenText("49 tests pass.", answer)?.text).toContain("forty-nine");
  });
});
