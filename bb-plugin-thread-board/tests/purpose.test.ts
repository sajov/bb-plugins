import { describe, expect, it } from "vitest";
import { buildTranscript, messagesFromEvents, needsEvaluation, parseAssessment } from "@/lib/purpose";

describe("parseAssessment", () => {
  it("reads a bare JSON reply", () => {
    expect(
      parseAssessment('{"headline":"IPN error lane","purpose":"Fix the IPN lane.","progress":80,"state":"waiting","nextStep":"Pick a retry","actions":[{"label":"Take option 1","reply":"Option 1."}]}'),
    ).toEqual({
      headline: "IPN error lane",
      purpose: "Fix the IPN lane.",
      progress: 80,
      state: "waiting",
      nextStep: "Pick a retry",
      actions: [{ label: "Take option 1", reply: "Option 1." }],
    });
  });

  it("reads missing actions as none and keeps at most four", () => {
    expect(parseAssessment('{"headline":"h","purpose":"p","progress":1,"state":"working","nextStep":null}')?.actions).toEqual([]);
    const five = JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ label: `L${i}`, reply: `R${i}` })));
    expect(parseAssessment(`{"headline":"h","purpose":"p","progress":1,"state":"working","nextStep":null,"actions":${five}}`)?.actions).toHaveLength(4);
  });

  it("rejects an action without a reply", () => {
    expect(parseAssessment('{"headline":"h","purpose":"p","progress":1,"state":"working","nextStep":null,"actions":[{"label":"x"}]}')).toBeNull();
  });

  it("rejects a reply without headline", () => {
    expect(parseAssessment('{"purpose":"p","progress":1,"state":"working","nextStep":null,"actions":[]}')).toBeNull();
  });

  it("finds the object inside a code fence and prose", () => {
    const reply = 'Here it is:\n```json\n{"headline":"h","purpose":"Done.","progress":100,"state":"done","nextStep":null}\n```';
    expect(parseAssessment(reply)?.state).toBe("done");
  });

  it("clamps progress and turns an empty next step into null", () => {
    const parsed = parseAssessment('{"headline":"h","purpose":"x","progress":140.4,"state":"working","nextStep":""}');
    expect(parsed?.progress).toBe(100);
    expect(parsed?.nextStep).toBeNull();
  });

  it("rejects a reply without JSON, with broken JSON, or with an unknown state", () => {
    expect(parseAssessment(null)).toBeNull();
    expect(parseAssessment("I could not tell.")).toBeNull();
    expect(parseAssessment('{"purpose": "x", progress: }')).toBeNull();
    expect(parseAssessment('{"headline":"h","purpose":"x","progress":5,"state":"blocked","nextStep":null}')).toBeNull();
  });
});

describe("needsEvaluation", () => {
  const HOUR = 3_600_000;
  it("evaluates a thread that has never been evaluated", () => {
    expect(needsEvaluation(undefined, 3, 0, HOUR)).toBe(true);
  });
  it("evaluates when new messages arrived and the interval passed", () => {
    expect(needsEvaluation({ messageCount: 3, evaluatedAt: 0, headline: "h", actions: [] }, 5, HOUR, HOUR)).toBe(true);
  });
  it("skips when nothing new was said, however long ago", () => {
    expect(needsEvaluation({ messageCount: 5, evaluatedAt: 0, headline: "h", actions: [] }, 5, 100 * HOUR, HOUR)).toBe(false);
  });
  it("skips inside the interval even with new messages", () => {
    expect(needsEvaluation({ messageCount: 3, evaluatedAt: 0, headline: "h", actions: [] }, 5, HOUR - 1, HOUR)).toBe(false);
  });
  it("re-evaluates an assessment stored without a headline or actions", () => {
    expect(needsEvaluation({ messageCount: 5, evaluatedAt: 0, actions: [] }, 5, 1, HOUR)).toBe(true);
    expect(needsEvaluation({ messageCount: 5, evaluatedAt: 0, headline: "h" }, 5, 1, HOUR)).toBe(true);
  });
  it("skips an empty thread", () => {
    expect(needsEvaluation(undefined, 0, 0, HOUR)).toBe(false);
  });
});

describe("transcript", () => {
  it("reads user turns and agent messages, ignoring everything else", () => {
    const messages = messagesFromEvents([
      { type: "client/turn/requested", data: { input: [{ type: "text", text: "Build a board" }] } },
      { type: "item/completed", data: { item: { type: "commandExecution", text: "ls" } } },
      { type: "item/completed", data: { item: { type: "agentMessage", text: "Done." } } },
    ]);
    expect(messages).toEqual([
      { role: "user", text: "Build a board" },
      { role: "assistant", text: "Done." },
    ]);
  });

  it("keeps the first and the latest messages and cuts the middle", () => {
    const long = "y".repeat(1400);
    const messages = [
      { role: "user" as const, text: "GOAL" },
      ...Array.from({ length: 40 }, (_, index) => ({ role: "assistant" as const, text: `${index} ${long}` })),
    ];
    const transcript = buildTranscript(messages);
    expect(transcript.startsWith("### User\nGOAL")).toBe(true);
    expect(transcript).toContain("39 ");
    expect(transcript).not.toContain("### Agent\n0 ");
    expect(transcript).toMatch(/messages omitted/);
  });

  it("omits nothing when everything fits", () => {
    expect(buildTranscript([{ role: "user", text: "a" }, { role: "assistant", text: "b" }])).not.toMatch(/omitted/);
  });
});
