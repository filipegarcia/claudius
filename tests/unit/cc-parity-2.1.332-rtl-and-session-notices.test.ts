import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { AskUserQuestionPrompt } from "@/components/chat/AskUserQuestionPrompt";
import { mapEventToKind } from "@/lib/server/notification-bus";
import type { AskUserQuestionEvent } from "@/lib/shared/events";

/**
 * CC 2.1.332 — "[VSCode] Fixed a hidden panel's notice not naming the
 * waiting session, Hebrew and Arabic questions reading out of order, …".
 *
 * 1. The "blocked on you" notifications (permission, MCP input, question,
 *    plan review) said only "Claude needs permission" etc.; with several
 *    tabs open the OS notice didn't say which session was waiting. Their
 *    titles now name it; the body keeps the request.
 * 2. The question card rendered the model's text with the page's LTR
 *    direction, so Hebrew and Arabic punctuation landed on the wrong side.
 *    The question, header, option labels/descriptions and the Other
 *    textareas now carry `dir="auto"`.
 */

const CTX = { cwd: "/tmp/proj", sessionId: "sess-1", sessionTitle: "Auth audit" };
const NO_TITLE_CTX = { cwd: "/tmp/proj", sessionId: "sess-1" };
const idle = () => new Map<string, number>();

describe("blocked-on-you notifications name the session", () => {
  test("permission request", () => {
    const out = mapEventToKind(
      { type: "permission_request", requestId: "r1", toolName: "Bash", toolUseId: "t1", input: {}, title: "Run `npm test`" },
      CTX,
      idle(),
    );
    expect(out?.title).toBe("Claude needs permission — Auth audit");
    expect(out?.body).toBe("Run `npm test`");
  });

  test("question", () => {
    const out = mapEventToKind(
      {
        type: "ask_user_question",
        requestId: "r2",
        toolUseId: "t2",
        questions: [{ question: "Which runner?", header: "Runner", options: [], multiSelect: false }],
      },
      CTX,
      idle(),
    );
    expect(out?.title).toBe("Claude is asking a question — Auth audit");
    expect(out?.body).toBe("Which runner?");
  });

  test("plan review", () => {
    const out = mapEventToKind(
      { type: "plan_approval_request", requestId: "r3", toolUseId: "t3", plan: "1. Do it" },
      CTX,
      idle(),
    );
    expect(out?.title).toBe("Claude has a plan to review — Auth audit");
  });

  test("MCP input and sign-in", () => {
    const form = mapEventToKind(
      { type: "mcp_elicitation_request", requestId: "r4", serverName: "linear", message: "Pick a team", mode: "form" },
      CTX,
      idle(),
    );
    expect(form?.title).toBe("linear needs your input — Auth audit");
    const url = mapEventToKind(
      { type: "mcp_elicitation_request", requestId: "r5", serverName: "linear", message: "Sign in", mode: "url" },
      CTX,
      idle(),
    );
    expect(url?.title).toBe("linear needs you to sign in — Auth audit");
  });

  test("with no session label (scheduler-style context) the title is unchanged", () => {
    const out = mapEventToKind(
      { type: "permission_request", requestId: "r6", toolName: "Bash", toolUseId: "t6", input: {} },
      NO_TITLE_CTX,
      idle(),
    );
    expect(out?.title).toBe("Claude needs permission");
  });
});

describe("question card text direction", () => {
  const request: AskUserQuestionEvent = {
    type: "ask_user_question",
    requestId: "r-rtl",
    toolUseId: "t-rtl",
    questions: [
      {
        question: "איזה מסד נתונים להשתמש?",
        header: "מסד נתונים",
        multiSelect: false,
        options: [
          { label: "פוסטגרס", description: "יציב ומוכר." },
          { label: "SQLite", description: "קובץ אחד, בלי שרת." },
        ],
      },
    ],
  };

  test("question, header, labels and descriptions take dir=auto", () => {
    const html = renderToStaticMarkup(
      createElement(AskUserQuestionPrompt, { request, onSubmit: () => {}, onCancel: () => {}, inline: true }),
    );
    expect(html).toMatch(/<p[^>]*data-testid="ask-question-text"[^>]*dir="auto"[^>]*>איזה מסד נתונים להשתמש\?<\/p>/);
    expect(html).toMatch(/<p[^>]*data-testid="ask-question-header"[^>]*dir="auto"[^>]*>מסד נתונים<\/p>/);
    expect(html).toMatch(/<span dir="auto"[^>]*text-start[^>]*>פוסטגרס<\/span>/);
    expect(html).toMatch(/<span dir="auto"[^>]*text-start[^>]*>יציב ומוכר\.<\/span>/);
  });
});
