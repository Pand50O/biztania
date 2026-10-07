import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 300;

type Step = { title: string; description: string };
type ConversationTurn = { role: "user" | "assistant"; label?: string; text: string };
type Payload = {
  role: "supervisor" | "worker" | "web" | "qa";
  input: string;
  answer?: string;
  plan?: Step[];
  draft?: string;
  feedback?: string;
  history?: ConversationTurn[];
};

const supervisorInstruction = `You are the only agent that communicates with the user. The conversationHistory is the remembered conversation; use it to retain the goal, answers, and feedback, and never repeat questions already answered. Respond ONLY with valid JSON: {"status":"needs_clarification"|"ready","summary":"Thai summary of understood goal","questions":["one Thai question"],"plan":[{"title":"Thai step title","description":"specific instruction to worker in Thai"}]}. Use Thai. Conduct a user-friendly interview when key requirements are missing: ask exactly ONE high-value, easy-to-answer question per turn, explain why it matters briefly, and continue asking follow-up questions across turns until you have enough information. Do not dump a checklist, repeat questions already answered, or require the user to know technical details. If the user is unsure, offer a small set of sensible choices or recommend a default. Keep status needs_clarification and include exactly one question while a critical detail is missing. Once the goal is sufficiently clear, set status ready, questions [], and give a practical 3-5 step plan. When the user provides feedback on an existing draft, preserve the approved goal and unchanged requirements, ask one clarification at a time if needed, and keep status needs_clarification until the requested change is clear. Then return status ready with an updated Worker plan that fully captures the user's intent; downstream agents receive only this Supervisor summary and plan, never raw user messages. The initial plan is shown for user approval; a clarified revision feedback loop proceeds Supervisor → Worker. Never claim work is already done. Do not expose private chain-of-thought; give a short user-facing explanation only.`;

const workerInstruction = `You are the Worker. The request and plan you receive were prepared by the Supervisor; follow them as the complete instruction. Do not expect or ask for direct user messages. First provide a useful plain-text response or requested non-web text file. Respond ONLY with valid JSON: {"title":"Thai title","summary":"direct conversational answer in Thai","needsWebPreview":true,"artifact":{"kind":"file","filename":"answer.txt or the explicitly requested text filename","mimeType":"text/plain or the explicitly requested text MIME type","content":"complete text answer or requested text file content"},"notes":["Thai assumption or limitation"]}. Set needsWebPreview true only when the Supervisor's plan requests a website or web app. In that case, content must be a useful text fallback describing the proposed website and important assumptions; do not put HTML in this first response. For ordinary questions, explanations, and code answers (including C++), set false and answer directly in Thai; the .txt content may include code. If the plan requests CSV, JSON, Markdown, or a source-code file, honor that format and return its exact contents. CSV content must be only valid CSV rows with correctly quoted cells. Never wrap a non-web answer in HTML. Do not claim to execute code, access files, or fetch external data unless a tool actually did so. When revising, preserve the previous file format unless the Supervisor's plan changes it. Ensure JSON and content are complete.`;

const webInstruction = `You are the Worker creating the requested website after a concise text response has already been prepared. Follow the approved plan and latest feedback. Respond ONLY with valid JSON: {"title":"Thai title","summary":"short Thai description","artifact":{"kind":"web","filename":"index.html","mimeType":"text/html","content":"complete self-contained HTML document"},"notes":["Thai assumption or limitation"]}. Create a polished, responsive website in Thai using inline CSS; no JavaScript, external resources, or unsupported facts. Ensure the full HTML document is present and valid. Do not return a text explanation instead of HTML. When revising, use the prior HTML and apply the latest feedback.`;

const qaInstruction = `You are the Supervisor's first-pass QA reviewer. Compare the generated artifact (which may be a website, CSV, JSON, Markdown, plain-text report, or source file) with the original request, approved plan, and latest feedback. Respond ONLY as JSON: {"status":"approved"|"revise","summary":"short Thai explanation for the user","issues":["specific missing requirement"]}. Check that the artifact type and file contents match the request. Approve when it is a complete, usable response to the plan. Only report concrete omissions, malformed content, or mismatch with the user's instructions. Do not invent external facts or expose chain-of-thought. If no meaningful issue remains, return approved and an empty issues array.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPlan(value: unknown): value is Step[] {
  return Array.isArray(value) && value.length <= 10 && value.every((step) =>
    isRecord(step) && typeof step.title === "string" && typeof step.description === "string");
}

function validHistory(value: unknown): value is ConversationTurn[] {
  return value === undefined || (Array.isArray(value) && value.length <= 40 && value.every((turn) => isRecord(turn) && (turn.role === "user" || turn.role === "assistant") && typeof turn.text === "string" && turn.text.length <= 5000 && (turn.label === undefined || typeof turn.label === "string" && turn.label.length <= 80)));
}

function validPayload(value: unknown): value is Payload {
  if (!isRecord(value) || (value.role !== "supervisor" && value.role !== "worker" && value.role !== "web" && value.role !== "qa") || typeof value.input !== "string" || !value.input.trim() || value.input.length > 8000) return false;
  if (!validHistory(value.history)) return false;
  if ((value.role === "worker" || value.role === "web" || value.role === "qa") && !validPlan(value.plan)) return false;
  if (value.role === "qa" && (typeof value.draft !== "string" || value.draft.length > 700_000)) return false;
  return true;
}

function validateResult(value: unknown, role: Payload["role"]): boolean {
  if (!isRecord(value)) return false;
  if (role === "supervisor") {
    if ((value.status !== "ready" && value.status !== "needs_clarification") || typeof value.summary !== "string" || !Array.isArray(value.questions) || value.questions.length > 1 || !value.questions.every((item) => typeof item === "string") || !validPlan(value.plan)) return false;
    return value.status === "ready" ? value.plan.length > 0 : value.questions.length > 0;
  }
  if (role === "qa") return (value.status === "approved" || value.status === "revise") && typeof value.summary === "string" && Array.isArray(value.issues) && value.issues.length <= 8 && value.issues.every((item) => typeof item === "string");
  if (typeof value.title !== "string" || typeof value.summary !== "string" || !isRecord(value.artifact) || !Array.isArray(value.notes) || value.notes.length > 10 || !value.notes.every((item) => typeof item === "string")) return false;
  if (role === "worker" && typeof value.needsWebPreview !== "boolean") return false;
  const artifact = value.artifact;
  if ((artifact.kind !== "web" && artifact.kind !== "file") || typeof artifact.filename !== "string" || !/^[\wก-๙ ._-]+\.[a-z0-9]{1,8}$/i.test(artifact.filename) || typeof artifact.mimeType !== "string" || typeof artifact.content !== "string" || !artifact.content.trim() || artifact.content.length > 700_000) return false;
  const filename = artifact.filename;
  const mimeType = artifact.mimeType;
  const content = artifact.content;
  if (artifact.kind === "web") return role === "web" && mimeType === "text/html" && filename.toLowerCase().endsWith(".html") && /^(<!doctype html|<html\b)/i.test(content.trimStart());
  if (role === "web") return false;
  const supportedFileTypes = new Set(["text/csv", "application/json", "text/markdown", "text/plain", "text/x-python", "text/javascript", "text/css", "application/xml"]);
  return supportedFileTypes.has(mimeType) && !filename.toLowerCase().endsWith(".html");
}

function extractWorkerContent(raw: string) {
  const contentField = /"content"\s*:\s*"/i.exec(raw);
  if (!contentField) return raw.trim();
  const contentStart = contentField.index + contentField[0].length;
  const notesStart = raw.lastIndexOf('"notes"');
  const contentEnd = raw.lastIndexOf('"', notesStart > contentStart ? notesStart - 1 : raw.length - 1);
  if (contentEnd < contentStart) return raw.trim();

  const encoded = raw.slice(contentStart, contentEnd);
  let decoded = "";
  for (let index = 0; index < encoded.length; index += 1) {
    const char = encoded[index];
    if (char !== "\\" || index + 1 >= encoded.length) { decoded += char; continue; }
    const next = encoded[++index];
    const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
    if (next === "u" && /^[\da-f]{4}$/i.test(encoded.slice(index + 1, index + 5))) {
      decoded += String.fromCharCode(parseInt(encoded.slice(index + 1, index + 5), 16));
      index += 4;
    } else decoded += escapes[next] ?? next;
  }
  return decoded.trim() || raw.trim();
}

function workerTextFallback(raw: string, parsed?: unknown) {
  const parsedArtifact = isRecord(parsed) && isRecord(parsed.artifact) ? parsed.artifact : null;
  const content = (parsedArtifact && typeof parsedArtifact.content === "string" ? parsedArtifact.content : extractWorkerContent(raw)).slice(0, 700_000);
  const title = isRecord(parsed) && typeof parsed.title === "string" ? parsed.title : "คำตอบจาก Worker";
  const summary = isRecord(parsed) && typeof parsed.summary === "string"
    ? parsed.summary
    : "Gemini ตอบกลับมาไม่ตรงรูปแบบ จึงบันทึกเนื้อหาที่ได้เป็นไฟล์ข้อความให้ดาวน์โหลด";
  return {
    title,
    summary,
    needsWebPreview: false,
    artifact: { kind: "file", filename: "worker-response.txt", mimeType: "text/plain", content },
    notes: ["คำตอบถูกเก็บเป็นไฟล์ข้อความสำรอง เนื่องจากรูปแบบ JSON จาก Gemini ไม่สมบูรณ์"],
  };
}

export async function POST(request: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const bearerToken = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!supabaseUrl || !supabaseKey) return NextResponse.json({ error: "ยังไม่ได้ตั้งค่า Supabase สำหรับตรวจสอบบัญชี" }, { status: 503 });
  if (!bearerToken) return NextResponse.json({ error: "กรุณาเข้าสู่ระบบก่อนใช้งาน" }, { status: 401 });
  const authClient = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await authClient.auth.getUser(bearerToken);
  if (authError || !authData.user) return NextResponse.json({ error: "เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบอีกครั้ง" }, { status: 401 });

  const payload: unknown = await request.json().catch(() => null);
  if (!validPayload(payload)) return NextResponse.json({ error: "ข้อมูลคำขอไม่ถูกต้อง" }, { status: 400 });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "ยังไม่ได้ตั้งค่า GEMINI_API_KEY ในไฟล์ .env" }, { status: 503 });

  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const supervisor = payload.role === "supervisor";
  const instruction = supervisor ? supervisorInstruction : payload.role === "qa" ? qaInstruction : payload.role === "web" ? webInstruction : workerInstruction;
  // Keep output budgets proportional to each role. The Worker returns a full HTML
  // document, so an unbounded response can exceed the local route's 60s limit.
  const maxOutputTokens = supervisor ? 1_200 : payload.role === "qa" ? 512 : payload.role === "web" ? 65_536 : 8_192;
  const prompt = supervisor
    ? { request: payload.input, conversationHistory: payload.history || [], clarification: payload.answer || null, approvedPlan: payload.plan || null, previousDraft: payload.draft || null, userFeedback: payload.feedback || null }
    : { request: payload.input, clarification: payload.answer || null, approvedPlan: payload.plan, previousDraft: payload.draft || null, userFeedback: payload.feedback || null };

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instruction }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(prompt) }] }],
        generationConfig: { responseMimeType: "application/json", temperature: supervisor || payload.role === "qa" ? 0.2 : 0.7, maxOutputTokens },
      }),
      signal: AbortSignal.timeout(290_000),
    });
    const resultBody: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = isRecord(resultBody) && isRecord(resultBody.error) && typeof resultBody.error.message === "string" ? resultBody.error.message : `Gemini API ตอบกลับ ${response.status}`;
      console.error("Gemini API returned an error:", JSON.stringify({ role: payload.role, model, status: response.status, body: resultBody }));
      return NextResponse.json({ error: message }, { status: response.status === 429 ? 429 : 502 });
    }
    const candidate = isRecord(resultBody) && Array.isArray(resultBody.candidates) && isRecord(resultBody.candidates[0]) ? resultBody.candidates[0] : null;
    const finishReason = candidate && typeof candidate.finishReason === "string" ? candidate.finishReason : "unknown";
    const text = candidate && isRecord(candidate.content) && Array.isArray(candidate.content.parts) && isRecord(candidate.content.parts[0]) && typeof candidate.content.parts[0].text === "string" ? candidate.content.parts[0].text : "";
    let result: unknown;
    try { result = JSON.parse(text); } catch {
      console.error("Gemini returned invalid JSON:", JSON.stringify({ role: payload.role, model, finishReason, responseLength: text.length, responseEnd: text.slice(-1_000) }));
      if (finishReason === "MAX_TOKENS") return NextResponse.json({ error: payload.role === "web" ? "สร้างหน้าเว็บไม่ครบตามเพดาน output" : "สร้างคำตอบไม่ครบตามเพดาน output" }, { status: 502 });
      if (payload.role === "worker" && text.trim()) {
        result = workerTextFallback(text);
        return NextResponse.json({ result }, { headers: { "Cache-Control": "no-store" } });
      }
      return NextResponse.json({ error: "Gemini ส่งผลลัพธ์ที่อ่านไม่ได้ กรุณาลองอีกครั้ง" }, { status: 502 });
    }
    if (!validateResult(result, payload.role)) {
      console.error("Gemini result failed validation:", JSON.stringify({ role: payload.role, model, result }).slice(0, 8_000));
      if (payload.role === "worker" && isRecord(result)) {
        const fallback = workerTextFallback(text, result);
        return NextResponse.json({ result: fallback }, { headers: { "Cache-Control": "no-store" } });
      }
      return NextResponse.json({ error: "ผลลัพธ์จาก Gemini ไม่ตรงตามรูปแบบที่กำหนด กรุณาลองอีกครั้ง" }, { status: 502 });
    }
    return NextResponse.json({ result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Gemini request failed:", JSON.stringify({ role: payload.role, model, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) }));
    if (error instanceof Error && error.name === "TimeoutError") {
      const task = payload.role === "worker" ? "สร้างคำตอบ" : payload.role === "web" ? "สร้าง Preview เว็บไซต์" : payload.role === "qa" ? "ตรวจผลงาน" : "วิเคราะห์คำขอ";
      return NextResponse.json({ error: `Gemini ใช้เวลานานเกินไปในการ${task} กรุณาลองอีกครั้ง` }, { status: 504 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "เรียก Gemini ไม่สำเร็จ" }, { status: 502 });
  }
}
