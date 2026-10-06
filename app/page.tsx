"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

type Step = { title: string; description: string };
type SupervisorResult = { status: "needs_clarification" | "ready"; summary: string; questions: string[]; plan: Step[] };
type QAResult = { status: "approved" | "revise" | "unavailable"; summary: string; issues: string[] };
type Artifact = { kind: "web" | "file"; filename: string; mimeType: string; content: string };
type WorkerResult = { title: string; summary: string; needsWebPreview: boolean; artifact: Artifact; notes: string[]; finalized: boolean; quality?: QAResult };
type Message = { role: "user" | "assistant"; actor?: "supervisor" | "worker"; label: string; text: string };
type Activity = { title: string; detail: string; time: string };
type Project = {
  request: string;
  answer: string;
  supervisor: SupervisorResult | null;
  worker: WorkerResult | null;
  pendingFeedback: string;
  approvedPlan: boolean;
  messages: Message[];
  activities: Activity[];
};
type Tab = "chat" | "supervisor" | "worker";

const KEY = "promptbridge-concierge-v3";
const blankProject = (): Project => ({ request: "", answer: "", supervisor: null, worker: null, pendingFeedback: "", approvedPlan: false, messages: [], activities: [] });

function parseCsvPreview(source: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((line) => line.some((value) => value.trim())).slice(0, 13);
}

function formatSupervisorOrder(result: SupervisorResult) {
  return [result.summary, "", ...result.plan.map((step, index) => `${index + 1}. ${step.title} — ${step.description}`)].join("\n");
}

export default function Home() {
  const [project, setProject] = useState<Project>(blankProject);
  const [tab, setTab] = useState<Tab>("chat");
  const [request, setRequest] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState("");
  const [refineOpen, setRefineOpen] = useState(false);
  const [busy, setBusy] = useState<"supervisor" | "worker" | "qa" | null>(null);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<Project>;
        const activities = (saved.activities || []).map((item) => item.title === "Worker ปรับ Draft และ Supervisor ตรวจแล้ว"
          ? { ...item, title: "Supervisor รับ Feedback → มอบหมาย Worker" }
          : item.title === "Worker สร้าง Draft และ Supervisor ตรวจแล้ว"
            ? { ...item, title: "Supervisor มอบหมาย Worker → QA ตรวจ" }
            : item.title === "Worker ส่งผลงานกลับมา"
              ? { ...item, title: "Supervisor รับผลจาก Worker และส่งมอบ" }
              : item);
        const messages = (saved.messages || []).map((message) => message.role === "assistant" && message.label === "ผลลัพธ์จาก Supervisor"
          ? { ...message, actor: "worker" as const, label: "Worker ส่งผลงานกลับมาให้ Supervisor" }
          : message);
        if (saved.supervisor?.status === "ready" && !messages.some((message) => message.actor === "supervisor" && message.label.includes("สั่ง Worker"))) {
          const orderMessage: Message = { role: "assistant", actor: "supervisor", label: "Supervisor สั่ง Worker", text: formatSupervisorOrder(saved.supervisor) };
          const workerIndex = messages.findIndex((message) => message.actor === "worker");
          messages.splice(workerIndex < 0 ? messages.length : workerIndex, 0, orderMessage);
        }
        if (saved.worker && !messages.some((message) => message.actor === "worker")) {
          messages.push({ role: "assistant", actor: "worker", label: "Worker ส่งผลงานกลับมาให้ Supervisor", text: `${saved.worker.summary}\nผลงาน: ${saved.worker.artifact.filename}` });
        }
        setProject({ ...blankProject(), ...saved, pendingFeedback: saved.pendingFeedback || "", messages, activities });
        setRequest(saved.request || "");
      }
    } catch (error) { console.warn("Could not restore saved workspace", error); }
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem(KEY, JSON.stringify(project));
  }, [project, ready]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 4500);
  }

  function activity(title: string, detail: string) {
    setProject((current) => ({ ...current, activities: [{ title, detail, time: new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) }, ...current.activities].slice(0, 8) }));
  }

  async function callAgent(role: "supervisor" | "worker" | "web" | "qa", input: string, options: { answer?: string; plan?: Step[]; draft?: string; feedback?: string; history?: Message[] } = {}) {
    const payload = role === "supervisor" && options.history ? { ...options, history: options.history.slice(-40) } : options;
    const response = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role, input, ...payload }) });
    const body = await response.json() as { result?: unknown; error?: string };
    if (!response.ok) throw new Error(body.error || `เกิดข้อผิดพลาด (${response.status})`);
    return body.result;
  }

  async function askSupervisor(goal: string, clarification = "", priorPlan?: Step[], history: Message[] = project.messages) {
    setBusy("supervisor");
    try {
      const result = await callAgent("supervisor", goal, { answer: clarification, plan: priorPlan, history }) as SupervisorResult;
      setProject((current) => ({ ...current, request: goal, answer: clarification, supervisor: result, approvedPlan: false }));
      setProject((current) => ({ ...current, messages: [...current.messages, { role: "assistant", actor: "supervisor", label: result.status === "ready" ? "Supervisor สั่ง Worker" : "คำถามจาก Supervisor", text: result.status === "ready" ? formatSupervisorOrder(result) : result.questions.join("\n") }] }));
      setTab("chat");
      activity(result.status === "ready" ? "Supervisor แตกงานเป็นแผนแล้ว" : "Supervisor ต้องการข้อมูลเพิ่ม", result.status === "ready" ? `${result.plan.length} ขั้นตอน รอคุณตรวจและอนุมัติ` : result.questions.join(" · "));
    } catch (error) { notify(error instanceof Error ? error.message : "เรียก Supervisor ไม่สำเร็จ"); }
    finally { setBusy(null); }
  }

  function submitGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const goal = request.trim();
    if (!goal || busy) return;
    const initialTurn: Message = { role: "user", label: "เป้าหมาย", text: goal };
    setProject((current) => ({ ...blankProject(), request: goal, messages: [initialTurn] }));
    setTab("chat");
    setRequest("");
    void askSupervisor(goal, "", undefined, [initialTurn]);
  }

  function sendClarification(value: string) {
    if (!value || busy) return;
    const combined = [project.answer, value].filter(Boolean).join("\n");
    const turn: Message = { role: "user", label: "คำตอบของคุณ", text: value };
    const history = [...project.messages, turn];
    setProject((current) => ({ ...current, messages: [...current.messages, turn] }));
    activity("คุณตอบคำถามของ Supervisor", value);
    setTab("chat");
    setAnswer("");
    setRefineOpen(false);
    if (project.pendingFeedback) {
      void continueFeedbackAfterClarification(combined, project.pendingFeedback, history);
      return;
    }
    void askSupervisor(project.request, combined, project.supervisor?.plan, history);
  }

  async function continueFeedbackAfterClarification(combinedAnswer: string, feedbackText: string, history: Message[]) {
    setBusy("supervisor");
    try {
      const revisedPlan = await callAgent("supervisor", project.request, { answer: combinedAnswer, plan: project.supervisor?.plan, draft: project.worker ? JSON.stringify(project.worker.artifact) : undefined, feedback: feedbackText, history }) as SupervisorResult;
      setProject((current) => ({ ...current, answer: combinedAnswer, supervisor: revisedPlan, approvedPlan: revisedPlan.status === "ready", messages: [...current.messages, { role: "assistant", actor: "supervisor", label: revisedPlan.status === "ready" ? "Supervisor ปรับคำสั่งให้ Worker" : "คำถามจาก Supervisor", text: revisedPlan.status === "ready" ? formatSupervisorOrder(revisedPlan) : revisedPlan.questions.join("\n") }] }));
      if (revisedPlan.status !== "ready" || !revisedPlan.plan.length) {
        activity("Supervisor ขอรายละเอียดเพิ่ม", revisedPlan.questions.join(" · "));
        notify("Supervisor ต้องการข้อมูลเพิ่มก่อนส่งคำสั่งแก้ให้ Worker");
        return;
      }
      activity("Supervisor ปรับแผนและส่งงานให้ Worker", `${revisedPlan.plan.length} ขั้นตอน · ใช้ feedback เดิมและคำตอบของคุณ`);
      await runWorker(feedbackText, revisedPlan.plan, combinedAnswer, history, revisedPlan.summary);
    } catch (error) {
      notify(error instanceof Error ? error.message : "ส่งคำตอบให้ Supervisor ไม่สำเร็จ");
    } finally { setBusy(null); }
  }

  function submitClarification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    sendClarification(answer.trim());
  }

  function requestRecommendation() {
    sendClarification("ยังไม่แน่ใจ ช่วยแนะนำตัวเลือกที่เหมาะสมให้หน่อย");
  }

  async function runWorker(userFeedback = "", supervisorPlan?: Step[], answerContext = project.answer, history: Message[] = project.messages, supervisorSummary = project.supervisor?.summary || "") {
    let plan = supervisorPlan || project.supervisor?.plan;
    let currentSupervisorSummary = supervisorSummary;
    if (!plan?.length) return notify("ยังไม่มีแผนที่อนุมัติจาก Supervisor");
    try {
      if (userFeedback && !supervisorPlan) {
        setProject((current) => ({ ...current, pendingFeedback: userFeedback }));
        setBusy("supervisor");
        const revisedPlan = await callAgent("supervisor", project.request, { answer: answerContext, plan, draft: project.worker ? JSON.stringify(project.worker.artifact) : undefined, feedback: userFeedback, history }) as SupervisorResult;
        setProject((current) => ({ ...current, supervisor: revisedPlan, approvedPlan: revisedPlan.status === "ready" }));
        if (revisedPlan.status !== "ready" || !revisedPlan.plan.length) {
          activity("Supervisor ขอรายละเอียดเพิ่ม", revisedPlan.questions.join(" · "));
          setTab("chat");
          setProject((current) => ({ ...current, messages: [...current.messages, { role: "assistant", label: "คำถามจาก Supervisor", text: revisedPlan.questions.join("\n") }] }));
          notify("Supervisor ขอให้ยืนยันรายละเอียดการแก้ก่อนส่งให้ Worker");
          return;
        }
        plan = revisedPlan.plan;
        currentSupervisorSummary = revisedPlan.summary;
        setProject((current) => ({ ...current, messages: [...current.messages, { role: "assistant", actor: "supervisor", label: "Supervisor ปรับคำสั่งให้ Worker", text: formatSupervisorOrder(revisedPlan) }] }));
        activity("Supervisor ปรับแผนและส่งงานให้ Worker", `${plan.length} ขั้นตอน · feedback พร้อมส่งต่อ`);
      }

      setBusy("worker");
      const supervisorDirective = [currentSupervisorSummary, ...plan.map((step, index) => `${index + 1}. ${step.title}: ${step.description}`)].filter(Boolean).join("\n");
      let result = await callAgent("worker", supervisorDirective, { plan, draft: project.worker ? JSON.stringify(project.worker.artifact) : undefined }) as Omit<WorkerResult, "finalized" | "quality">;
      let webFailure = "";
      if (result.needsWebPreview) {
        setProject((current) => ({ ...current, worker: { ...result, finalized: false } }));
        try {
          const webResult = await callAgent("web", supervisorDirective, { plan, draft: project.worker ? JSON.stringify(project.worker.artifact) : JSON.stringify(result.artifact) }) as Omit<WorkerResult, "finalized" | "quality" | "needsWebPreview">;
          result = { ...result, artifact: webResult.artifact, notes: [...result.notes, ...webResult.notes] };
          setProject((current) => ({ ...current, worker: current.worker ? { ...current.worker, artifact: webResult.artifact, notes: result.notes } : current.worker }));
        } catch (error) {
          webFailure = error instanceof Error ? error.message : "สร้างตัวอย่างเว็บไม่สำเร็จ";
          console.warn("Website preview generation failed; keeping the text fallback:", webFailure);
        }
      }
      setBusy("qa");
      let quality: QAResult;
      try { quality = await callAgent("qa", supervisorDirective, { plan, draft: JSON.stringify(result.artifact) }) as QAResult; }
      catch (error) { quality = { status: "unavailable", summary: "Supervisor QA เรียกไม่สำเร็จ จึงยังไม่ได้ตรวจอัตโนมัติ", issues: [error instanceof Error ? error.message : "ตรวจ Draft ไม่สำเร็จ"] }; }
      if (quality.status === "revise") {
        const qaFeedback = quality.issues.join("\n");
        activity("Supervisor QA ขอให้ Worker ปรับ", quality.issues.join(" · ") || quality.summary);
        setBusy("worker");
        if (result.artifact.kind === "web") {
          const revisedWeb = await callAgent("web", supervisorDirective, { plan, draft: JSON.stringify(result.artifact), feedback: `Supervisor QA: ${qaFeedback}` }) as Omit<WorkerResult, "finalized" | "quality" | "needsWebPreview">;
          result = { ...result, artifact: revisedWeb.artifact, notes: [...result.notes, ...revisedWeb.notes] };
        } else {
          result = await callAgent("worker", supervisorDirective, { plan, draft: JSON.stringify(result.artifact), feedback: `Supervisor QA: ${qaFeedback}` }) as Omit<WorkerResult, "finalized" | "quality">;
        }
        setBusy("qa");
        try { quality = await callAgent("qa", supervisorDirective, { plan, draft: JSON.stringify(result.artifact) }) as QAResult; }
        catch (error) { quality = { status: "unavailable", summary: "Supervisor QA เรียกไม่สำเร็จ จึงยังไม่ได้ตรวจอัตโนมัติ", issues: [error instanceof Error ? error.message : "ตรวจ Draft ไม่สำเร็จ"] }; }
      }
      setProject((current) => ({ ...current, pendingFeedback: "", worker: { ...result, quality, finalized: false }, messages: [...current.messages, { role: "assistant", actor: "worker", label: "Worker ส่งผลงานกลับมาให้ Supervisor", text: `${result.summary}\nผลงาน: ${result.artifact.filename}` }] }));
      activity("Supervisor รับผลจาก Worker และส่งมอบ", result.title);
      activity(quality.status === "approved" ? "Supervisor QA ตรวจผ่าน" : quality.status === "unavailable" ? "Supervisor QA ยังตรวจไม่ได้" : "Supervisor QA แจ้งจุดให้ตรวจ", quality.summary || quality.issues.join(" · "));
      setTab("chat");
      setFeedback("");
      notify(webFailure ? `สร้าง Preview เว็บไม่สำเร็จ แต่เก็บคำตอบข้อความไว้แล้ว: ${webFailure}` : quality.status === "approved" ? (userFeedback ? "Worker ปรับผลงานและ Supervisor ตรวจผ่านแล้ว" : "ผลงานผ่านการตรวจเบื้องต้น พร้อมให้คุณพิจารณา") : quality.status === "unavailable" ? "ผลงานพร้อมแล้ว แต่ QA อัตโนมัติไม่สำเร็จ โปรดตรวจด้วยตนเอง" : "ผลงานพร้อมแล้ว แต่ Supervisor แจ้งจุดที่ควรตรวจเพิ่มเติม");
    } catch (error) { notify(error instanceof Error ? error.message : "เรียก Worker ไม่สำเร็จ"); }
    finally { setBusy(null); }
  }

  function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = feedback.trim();
    if (!text || busy) return;
    const turn: Message = { role: "user", label: "Feedback ถึง Supervisor", text };
    const history = [...project.messages, turn];
    setProject((current) => ({ ...current, approvedPlan: false, worker: current.worker ? { ...current.worker, quality: undefined } : null, messages: [...current.messages, turn] }));
    activity("คุณส่ง Feedback ให้ Supervisor", text);
    setTab("chat");
    void runWorker(text, undefined, project.answer, history);
  }

  function submitChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = chatInput.trim();
    if (!text || busy) return;
    setChatInput("");
    if (project.supervisor?.status === "needs_clarification") {
      sendClarification(text);
      return;
    }
    if (project.worker) {
      const turn: Message = { role: "user", label: "Feedback ถึง Supervisor", text };
      const history = [...project.messages, turn];
      setProject((current) => ({ ...current, approvedPlan: false, worker: current.worker ? { ...current.worker, quality: undefined, finalized: false } : null, messages: [...current.messages, turn] }));
      activity("คุณส่ง Feedback ให้ Supervisor", text);
      void runWorker(text, undefined, project.answer, history);
      return;
    }
    const turn: Message = { role: "user", label: "ข้อความถึง Supervisor", text };
    const history = [...project.messages, turn];
    setProject((current) => ({ ...current, messages: [...current.messages, turn] }));
    void askSupervisor(project.request, [project.answer, text].filter(Boolean).join("\n"), project.supervisor?.plan, history);
  }

  function approvePlan() {
    setProject((current) => ({ ...current, approvedPlan: true }));
    activity("คุณอนุมัติแผน", "Supervisor ส่งแผนให้ Worker เริ่มทำงาน");
    setTab("chat");
    void runWorker();
  }

  function approveDraft() {
    const worker = project.worker;
    if (!worker?.artifact.content) return;
    downloadArtifact(worker.artifact);
    setProject((current) => current.worker ? { ...current, worker: { ...current.worker, finalized: true } } : current);
    activity("คุณอนุมัติผลลัพธ์", `บันทึกใน Workspace และดาวน์โหลด ${worker.artifact.filename}`);
    notify(`อนุมัติแล้ว และดาวน์โหลด ${worker.artifact.filename}`);
  }

  function downloadArtifact(artifact: Artifact) {
    const content = artifact.mimeType === "text/csv" && !artifact.content.startsWith("\uFEFF") ? `\uFEFF${artifact.content}` : artifact.content;
    const url = URL.createObjectURL(new Blob([content], { type: `${artifact.mimeType};charset=utf-8` }));
    const link = document.createElement("a");
    link.href = url;
    link.download = artifact.filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function reset() {
    if ((project.request || project.worker) && !window.confirm("เริ่มโปรเจกต์ใหม่หรือไม่?")) return;
    setProject(blankProject()); setRequest(""); setChatInput(""); setAnswer(""); setFeedback(""); setRefineOpen(false); setTab("chat");
  }

  const latestFeedback = [...project.messages].reverse().find((message) => message.label === "Feedback ถึง Supervisor");
  const interviewMessages = project.messages.filter((message) => message.label === "คำถามจาก Supervisor" || message.label === "คำตอบของคุณ");
  const interviewHistory = project.supervisor?.status === "needs_clarification" ? interviewMessages.slice(0, -1) : interviewMessages;
  const launched = Boolean(project.request);

  return <main className={`shell ${launched ? "" : "landing-shell"}`}>
    {launched && <aside className="sidebar">
      <div className="brand"><span className="brand-mark">p</span><span><strong>promptbridge</strong><small>AI concierge workspace</small></span></div>
      <div className="side-label">WORKSPACE</div><button className="workspace-link" onClick={reset}><span className="workspace-icon">▦</span> โปรเจกต์ของฉัน <span className="side-dot" /></button>
      <div className="side-label workflow-label">WORKFLOW</div>
      <button className={`side-tab ${tab === "chat" ? "selected" : ""}`} onClick={() => setTab("chat")}><span className="side-num">00</span><span>คุยกับ Supervisor</span><small>{busy ? "กำลังทำงาน" : project.worker ? "รายงานผลแล้ว" : "Supervisor รับคำขอ"}</small></button>
      <button className={`side-tab ${tab === "supervisor" ? "selected" : ""}`} onClick={() => setTab("supervisor")}><span className="side-num">01</span><span>Supervisor</span><small>{project.supervisor?.status === "ready" ? "แผนพร้อม" : project.supervisor ? "ถามเพิ่ม" : "เริ่มต้น"}</small></button>
      <button className={`side-tab ${tab === "worker" ? "selected" : ""}`} onClick={() => setTab("worker")}><span className="side-num">02</span><span>Worker & Preview</span><small>{project.worker?.finalized ? "อนุมัติแล้ว" : project.worker ? "Draft พร้อม" : "รอแผน"}</small></button>
      <div className="sidebar-spacer" />
      <div className="human-note"><span>◈</span><p><strong>คุณเป็นผู้ควบคุม</strong><br />AI รอการอนุมัติก่อนเริ่มทำงานและก่อนนำผลลัพธ์ไปใช้</p></div>
      <div className="profile"><span className="avatar">Y</span><span><strong>ผู้ใช้งาน</strong><small>Personal workspace</small></span><span className="profile-menu">•••</span></div>
    </aside>}

    <section className={`main-area ${launched ? "" : "landing-main"}`}>
      {launched && <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>{tab === "chat" ? "บทสนทนา" : tab === "supervisor" ? "Supervisor" : "Worker & Preview"}</strong></div><div className="top-actions"><span className="model-chip"><i /> Gemini Flash</span><span className="local-chip">◉ บันทึกในเครื่อง</span><button className="icon-button" title="เริ่มใหม่" onClick={reset}>↻</button><button className="mobile-reset" onClick={reset}>เริ่มใหม่</button></div></header>}
      <div className={`content ${launched ? "" : "landing-content"}`}>
      {launched ? <>
        <div className="page-heading"><div><div className="eyebrow"><span>✳</span> {tab === "chat" ? "SUPERVISOR DESK" : tab === "supervisor" ? "SUPERVISOR CONTROL" : "REVIEW & CO-CREATE"}</div><h1>{tab === "chat" ? "คุยกับ Supervisor แล้วรับผลงานได้เลย" : tab === "supervisor" ? "ตรวจเป้าหมายและแผนของ Supervisor" : "ตรวจผลงานและทำงานร่วมกับ Worker"}</h1><p>{tab === "chat" ? "ทุกคำขอและ Feedback ส่งถึง Supervisor ก่อน เขาจดจำบทสนทนา แล้วค่อยสั่ง Worker และรายงานผลให้คุณ" : tab === "supervisor" ? "ดูสิ่งที่ Supervisor เข้าใจและคำสั่งที่จะแบ่งให้ Worker" : "ดูตัวอย่างผลงาน ส่ง Feedback ให้ Supervisor ปรับคำสั่งก่อนมอบหมาย Worker แล้วดาวน์โหลดหรืออนุมัติ"}</p></div><div className="step-indicator">{tab === "chat" ? "SUPERVISOR" : tab === "supervisor" ? "01 / 02" : "02 / 02"}</div></div>

        <nav className="tabs" aria-label="ขั้นตอน AI Concierge">
          <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}><span className="tab-number">✳</span><span><strong>คุยกับ Supervisor</strong><small>ส่งคำขอและ Feedback</small></span><span className="tab-status">{busy ? "กำลังทำงาน" : project.worker ? "รายงานผลแล้ว" : "พร้อมคุย"}</span></button>
          <button className={tab === "supervisor" ? "active" : ""} onClick={() => setTab("supervisor")}><span className="tab-number">01</span><span><strong>Supervisor</strong><small>ดูเป้าหมายและแผน</small></span><span className="tab-status">{project.supervisor?.status === "ready" ? "แผนพร้อม" : project.supervisor ? "รอคำตอบ" : "เริ่มต้น"}</span></button>
          <button className={tab === "worker" ? "active" : ""} onClick={() => setTab("worker")}><span className="tab-number">02</span><span><strong>ผลงาน</strong><small>Preview และไฟล์</small></span><span className="tab-status">{project.worker?.finalized ? "อนุมัติแล้ว" : project.worker ? "Draft พร้อม" : "รอแผน"}</span></button>
        </nav>

        {tab !== "chat" && <section className="capability-strip" aria-label="องค์ประกอบ AI Concierge ทั้ง 6 ด้าน">
          {[
            ["01", "Remember", "บันทึกเป้าหมายและ Feedback ในเครื่อง"],
            ["02", "Understand", "Supervisor สรุปและถามเมื่อข้อมูลยังไม่พอ"],
            ["03", "Connect", "รวมคำขอ คำตอบ แผน และ Feedback เป็นบริบทเดียว"],
            ["04", "Retrieve", "ดึงบริบทเดิมจาก Workspace มาให้ Worker"],
            ["05", "Reason", "Worker ทำตามแผนที่ผู้ใช้อนุมัติ"],
            ["06", "Act", "สร้างเว็บตัวอย่างใน sandbox หลังอนุมัติ"],
          ].map(([number, name, description]) => <div className="capability" title={description} key={name}><span>{number}</span><strong>{name}</strong><i>✓</i></div>)}
        </section>}

        {tab !== "chat" && <ProcessStepper busy={busy} supervisor={project.supervisor} approvedPlan={project.approvedPlan} worker={project.worker} />}

        {tab === "chat" ? <section className="panel chat-workspace">
      <div className="chat-heading"><span className="brand-mark">S</span><div><strong>Supervisor</strong><small>คุณกำลังคุยกับ Supervisor · จดจำบริบทของบทสนทนานี้ไว้</small></div></div>
          <div className="chat-messages">
            {project.messages.map((message, index) => <div className={`chat-message ${message.role}`} key={`${index}-${message.label}`}><span className="chat-avatar">{message.role === "assistant" ? message.actor === "worker" ? "W" : "S" : "คุณ"}</span><div className="chat-bubble"><small>{message.role === "assistant" ? message.actor === "worker" ? `Worker · ${message.label}` : `Supervisor · ${message.label}` : "คุณ · ส่งถึง Supervisor"}</small><p>{message.text}</p></div></div>)}
            {busy && <div className="chat-message assistant"><span className="chat-avatar">S</span><div className="chat-bubble"><ProgressPanel busy={busy} /></div></div>}
            {project.supervisor?.status === "ready" && !project.approvedPlan && !project.worker && <div className="chat-plan-card"><strong>คำสั่งจาก Supervisor ไปยัง Worker</strong><p>{project.supervisor.summary}</p><ol>{project.supervisor.plan.map((step, index) => <li key={`${index}-${step.title}`}><b>{index + 1}.</b> <span><strong>{step.title}</strong> — {step.description}</span></li>)}</ol><button className="primary-button" onClick={approvePlan} disabled={Boolean(busy)}>{busy ? <><span className="spinner light" /> กำลังทำงาน</> : <>✓ ยืนยัน แล้วให้ Worker ลงมือ</>}</button><button className="chat-link-button" onClick={() => setTab("supervisor")} disabled={Boolean(busy)}>ตรวจรายละเอียด Supervisor</button></div>}
            {project.worker && <div className="chat-artifact-card"><div className="chat-artifact-heading"><span>{project.worker.artifact.kind === "web" ? "WEB" : project.worker.artifact.filename.split(".").pop()?.toUpperCase()}</span><div><strong>{project.worker.artifact.filename}</strong><small>{project.worker.summary}</small></div></div><div className="chat-artifact-actions">{project.worker.artifact.kind === "web" && <button className="secondary-button" onClick={() => setTab("worker")}>เปิด Preview</button>}<button className="secondary-button" onClick={() => downloadArtifact(project.worker!.artifact)}>↓ ดาวน์โหลดไฟล์</button>{!project.worker.finalized && <button className="approve-button" onClick={approveDraft} disabled={Boolean(busy)}>✓ อนุมัติผลงาน</button>}</div>{project.worker.quality && <small className="chat-quality">{project.worker.quality.status === "approved" ? "Supervisor ตรวจผ่านเบื้องต้น" : project.worker.quality.summary}</small>}</div>}
          </div>
          <form className="chat-composer" onSubmit={submitChat}><textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder={project.supervisor?.status === "needs_clarification" ? "ตอบคำถามของ Supervisor..." : project.worker ? "คุยกับ Supervisor หรือขอแก้ผลงาน..." : "บอก Supervisor ว่าต้องการอะไร..."} rows={2} disabled={Boolean(busy)} /><div><small>{project.supervisor?.status === "needs_clarification" ? "ตอบตามที่ทราบได้ หรือขอให้แนะนำ — Supervisor จะจำคำตอบนี้ไว้" : project.worker ? "ข้อความนี้ส่งถึง Supervisor ก่อน เขาจะปรับแผนแล้วค่อยมอบหมาย Worker" : "คุณกำลังคุยกับ Supervisor — เขาจะถามเพิ่มถ้าต้องการรายละเอียด"}</small><button className="primary-button" disabled={Boolean(busy) || !chatInput.trim()}>{busy ? <><span className="spinner light" /> กำลังทำงาน</> : <>ส่งให้ Supervisor ↗</>}</button></div></form>
        </section> : tab === "supervisor" ? <div className="supervisor-grid">
          <section className="panel intent-panel">
            <div className="panel-heading"><span className="panel-icon purple">01</span><div><h2>ยืนยันเป้าหมายกับ Supervisor</h2><p>ตรวจว่าเราเข้าใจสิ่งที่คุณต้องการถูกต้องหรือไม่</p></div><span className={`status-pill ${busy === "supervisor" || project.supervisor?.status === "needs_clarification" ? "working" : project.supervisor ? "ready" : "idle"}`}>{busy === "supervisor" ? <><span className="spinner" /> กำลังวิเคราะห์</> : project.approvedPlan ? "อนุมัติแล้ว" : project.supervisor?.status === "needs_clarification" ? "รอคำตอบจากคุณ" : project.supervisor ? "รอตรวจสอบ" : "กำลังเริ่ม"}</span></div>
            <div className="intent-body">
              <div className="request-recap"><span>คำขอของคุณ</span><p>{project.request}</p></div>
              {busy === "supervisor" && <ProgressPanel busy="supervisor" />}
              {project.supervisor && <div className="intent-card"><div className="intent-card-title"><span>✳</span><strong>เป้าหมายที่ระบบเข้าใจ</strong></div><p>{project.supervisor.summary}</p></div>}
              {project.worker && <div className="intent-card"><div className="intent-card-title"><span>↩</span><strong>Worker ส่งผลงานกลับให้ Supervisor</strong></div><p>{project.worker.summary}</p><small>{project.worker.artifact.filename}</small></div>}
              {interviewHistory.length > 0 && <div className="interview-history"><div className="interview-history-title">สิ่งที่คุยกันไปแล้ว</div>{interviewHistory.map((message, index) => <div className={`interview-turn ${message.role}`} key={`${index}-${message.label}`}><span>{message.role === "assistant" ? "?" : "คุณ"}</span><p>{message.text}</p></div>)}</div>}
              {project.supervisor?.status === "needs_clarification" && project.supervisor.questions.length > 0 && <div className="clarify-card"><strong>คำถามจาก Supervisor</strong><p>{project.supervisor.questions[0]}</p><small>ตอบเท่าที่ทราบได้เลย ถ้ายังไม่แน่ใจให้ Supervisor ช่วยแนะนำ</small></div>}
              {project.supervisor?.status === "ready" && !project.approvedPlan && <div className="intent-actions"><button className="primary-button wide" onClick={approvePlan} disabled={Boolean(busy)}>{busy === "worker" || busy === "qa" ? <><span className="spinner light" /> กำลังดำเนินการ</> : <>✓ ใช่, ดำเนินการเลย</>}</button><button className="secondary-button wide" onClick={() => setRefineOpen((current) => !current)} disabled={Boolean(busy)}>ปรับเป้าหมายหรือเพิ่มเงื่อนไข</button><small>Worker จะเริ่มเมื่อคุณยืนยันเป้าหมายและแผนแล้วเท่านั้น</small></div>}
              {project.approvedPlan && <div className="approved-note">✓ ยืนยันเป้าหมายและแผนแล้ว — ส่งงานให้ Worker</div>}
              {(refineOpen || project.supervisor?.status === "needs_clarification") && !project.approvedPlan && <form className="revision-form" onSubmit={submitClarification}><label htmlFor="goal-revision">{project.supervisor?.status === "needs_clarification" ? "คำตอบของคุณ" : "ปรับเป้าหมายหรือเพิ่มเงื่อนไข"}</label><textarea id="goal-revision" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={project.supervisor?.status === "needs_clarification" ? "ตอบคำถามนี้ได้ตามที่ทราบ ไม่ต้องรู้ศัพท์เทคนิค..." : "เช่น ขอเทียบกับบริษัท B ด้วย และขอเน้นความเสี่ยงระยะยาว..."} rows={3} disabled={Boolean(busy)} required /><div className="clarification-actions"><button className="primary-button" disabled={Boolean(busy) || !answer.trim()}>{busy === "supervisor" ? <><span className="spinner light" /> กำลังส่งคำตอบ</> : project.supervisor?.status === "needs_clarification" ? <>ส่งคำตอบให้ Supervisor ถามต่อ ↗</> : <>ส่งให้ Supervisor ปรับแผน ↗</>}</button>{project.supervisor?.status === "needs_clarification" && <button type="button" className="recommend-button" onClick={requestRecommendation} disabled={Boolean(busy)}>ยังไม่แน่ใจ — ช่วยแนะนำให้หน่อย</button>}</div></form>}
            </div>
          </section>

          <section className="panel plan-panel"><div className="panel-heading"><span className="panel-icon blue">⌘</span><div><h2>แผนปฏิบัติงาน</h2><p>คำสั่งที่ Supervisor จะแบ่งให้ Worker</p></div><span className="status-pill idle">{project.supervisor?.plan.length || 0} ขั้นตอน</span></div>
            {busy === "supervisor" && !project.supervisor ? <div className="empty-plan"><span className="spinner"/><strong>กำลังสรุปคำขอ</strong><p>Supervisor กำลังวิเคราะห์เป้าหมายและเตรียมขั้นตอน</p></div> : !project.supervisor?.plan.length ? <div className="empty-plan"><span>⌘</span><strong>{project.supervisor ? "รอข้อมูลเพิ่มเติม" : "แผนจะแสดงตรงนี้"}</strong><p>{project.supervisor ? "ตอบคำถามของ Supervisor เพื่อให้จัดแผนได้ตรงตามต้องการ" : "ระบบจะแสดงงานย่อยและสิ่งที่ Worker จะทำให้ตรวจสอบได้"}</p></div> : <div className="plan-content"><div className="plan-summary">แผนนี้ยึดตามเป้าหมายที่ระบบสรุปไว้ และจะเริ่มหลังคุณยืนยัน</div><ol className="plan-list">{project.supervisor.plan.map((step, index) => <li key={`${index}-${step.title}`}><span className="plan-index">{String(index + 1).padStart(2, "0")}</span><div><strong>{step.title}</strong><p>{step.description}</p></div></li>)}</ol>{project.supervisor.status === "needs_clarification" && <div className="plan-wait">รอคำตอบของคุณก่อนจัดแผนขั้นสุดท้าย</div>}</div>}
            <div className="panel-foot">◈ ตรวจสอบทุกคำสั่งก่อนอนุมัติให้ Worker ลงมือ</div>
          </section>
        </div> : <div className="worker-grid">
          <section className="panel preview-panel"><div className="panel-heading"><span className="panel-icon blue">▣</span><div><h2>{project.worker?.artifact.kind === "web" ? "ตัวอย่างเว็บไซต์" : "ตัวอย่างผลงาน"}</h2><p>{project.worker?.artifact.filename || "เว็บไซต์ ตาราง หรือไฟล์ที่ Worker สร้างจะแสดงตรงนี้"}</p></div><span className={`status-pill ${busy ? "working" : project.worker ? "ready" : "idle"}`}>{busy ? <><span className="spinner" /> {busy === "supervisor" ? "กำลังวางแผน" : busy === "worker" ? "กำลังสร้าง" : "QA ตรวจทาน"}</> : project.worker?.finalized ? "อนุมัติแล้ว" : project.worker ? "Draft" : "รอแผน"}</span></div>
            <div className="preview-wrap">
              {project.worker ? project.worker.artifact.kind === "web" ? <iframe title="ตัวอย่างเว็บที่ Worker สร้าง" sandbox="" srcDoc={project.worker.artifact.content} /> : <div className="artifact-preview">
                <div className="artifact-meta"><span>{project.worker.artifact.mimeType === "text/csv" ? "CSV" : project.worker.artifact.mimeType.split("/").pop()?.toUpperCase()}</span><strong>{project.worker.artifact.filename}</strong><small>{project.worker.artifact.mimeType}</small></div>
                {project.worker.artifact.mimeType === "text/csv" ? <div className="csv-preview"><table><tbody>{parseCsvPreview(project.worker.artifact.content).map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => rowIndex === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div> : <pre>{project.worker.artifact.content.slice(0, 8_000)}{project.worker.artifact.content.length > 8_000 ? "\n… แสดงตัวอย่างบางส่วน" : ""}</pre>}
                <button className="primary-button" onClick={() => downloadArtifact(project.worker!.artifact)}>↓ ดาวน์โหลด {project.worker.artifact.filename}</button>
              </div> : <div className="preview-empty"><span>▣</span><strong>ตัวอย่างผลงานจะแสดงที่นี่</strong><p>อนุมัติแผนในแท็บ Supervisor ก่อน Worker จะสร้างเว็บไซต์ ตาราง หรือไฟล์ตามคำสั่ง</p><button className="secondary-button" onClick={() => setTab("supervisor")}>กลับไปที่ Supervisor ←</button></div>}
            </div>
            <div className="preview-foot">{project.worker?.artifact.kind === "web" ? "◈ แสดงใน sandbox เพื่อความปลอดภัย" : project.worker?.artifact.kind === "file" ? "◈ แสดงตัวอย่างไฟล์ และดาวน์โหลดได้ก่อนอนุมัติ" : "◈ ผลงานที่ Worker สร้าง"}</div>
          </section>
          <div className="worker-column">
            <section className="panel worker-card"><div className="panel-heading"><span className="panel-icon amber">✦</span><div><h2>Worker</h2><p>ลงมือทำตามคำสั่ง และปรับตาม Feedback</p></div></div>
              <div className="worker-body">
                {project.supervisor?.plan.length ? <div className="worker-task"><div className="mini-heading">⌘ <span>คำสั่งที่ Worker ได้รับ</span></div><p className="task-goal">{project.supervisor.summary}</p><ol>{project.supervisor.plan.map((step, index) => <li key={`${index}-${step.title}`}><b>{index + 1}</b><span><strong>{step.title}</strong><small>{step.description}</small></span></li>)}</ol></div> : <div className="no-task">Supervisor ยังไม่ได้ส่งคำสั่งให้ Worker <button onClick={() => setTab("supervisor")}>ไปกำหนดเป้าหมาย →</button></div>}
                {latestFeedback && <div className="feedback-display"><div className="mini-heading">↳ <span>Feedback ล่าสุดที่ Supervisor รับไว้</span></div><p>{latestFeedback.text}</p></div>}
                {busy && <ProgressPanel busy={busy} />}
                {project.worker && <><div className="draft-summary"><strong>{project.worker.finalized ? "ผลลัพธ์อนุมัติแล้ว" : busy === "worker" ? "Worker กำลังทำฉบับแก้ไข" : "Draft พร้อมให้ตรวจ"}</strong><p>{project.worker.summary}</p></div>{project.worker.quality && <div className={`qa-result ${project.worker.quality.status}`}><strong>{project.worker.quality.status === "approved" ? "✓ Supervisor ตรวจผ่านเบื้องต้น" : project.worker.quality.status === "unavailable" ? "! ระบบตรวจอัตโนมัติไม่พร้อม" : "! Supervisor ขอให้ตรวจจุดเหล่านี้"}</strong><p>{project.worker.quality.summary}</p>{project.worker.quality.issues.length > 0 && <ul>{project.worker.quality.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}</div>}{project.worker.notes.length > 0 && <ul className="notes">{project.worker.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
                  {!project.worker.finalized ? <form className="feedback-form" onSubmit={submitFeedback}><label htmlFor="feedback">สั่งแก้เฉพาะจุด</label><p className="feedback-hint">Supervisor จะส่งคำสั่งแก้ให้ Worker โดยคงเป้าหมายและบริบทเดิมไว้</p><textarea id="feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="เช่น เปลี่ยนกราฟเป็นตาราง หรือย่อเนื้อหาให้สั้นลง..." rows={3} disabled={Boolean(busy)} /><div className="feedback-actions"><button type="button" className="approve-button" disabled={Boolean(busy)} onClick={approveDraft}>✓ อนุมัติผลลัพธ์ + Export</button><button className="secondary-button" disabled={Boolean(busy) || !feedback.trim()}>{busy === "supervisor" ? <><span className="spinner" /> Supervisor กำลังวางคำสั่ง</> : busy === "worker" || busy === "qa" ? <><span className="spinner" /> กำลังดำเนินการ</> : <>ส่งให้ปรับ ↗</>}</button></div></form> : <><div className="exported-note">ผลลัพธ์ได้รับอนุมัติและบันทึกใน Workspace แล้ว</div><button className="secondary-button full" onClick={() => { setProject((current) => current.worker ? { ...current, worker: { ...current.worker, finalized: false } } : current); }}>กลับไปแก้ Draft</button></>}</>}
                {project.approvedPlan && !project.worker && busy !== "worker" && <div className="start-worker"><p>แผนได้รับอนุมัติแล้ว Worker พร้อมเริ่มทำงาน</p><button className="primary-button" onClick={() => void runWorker()}>เริ่มสร้าง Draft <span>→</span></button></div>}
                {busy === "worker" && !project.worker && <div className="thinking"><span className="spinner" /> Worker กำลังสร้างผลงานตามแผน...</div>}
              </div>
            </section>
            <section className="panel activity-card"><div className="panel-heading compact"><span className="panel-icon neutral">↻</span><div><h2>กิจกรรมล่าสุด</h2><p>{project.activities.length} รายการ</p></div></div><div className="activity-list">{project.activities.length ? project.activities.map((item, index) => <div className="activity-item" key={`${index}-${item.title}`}><span className="activity-icon">✓</span><div><strong>{item.title}</strong><small>{item.detail} · {item.time}</small></div></div>) : <p className="no-activity">กิจกรรมของโปรเจกต์จะแสดงที่นี่</p>}</div></section>
          </div>
        </div>}
        <footer>PromptBridge · คิดร่วมกัน ตรวจสอบได้ · ผลลัพธ์จาก AI ควรตรวจทานก่อนนำไปใช้</footer>
      </> : <section className="landing-card">
        <div className="landing-brand"><span className="brand-mark">p</span><span>promptbridge <i>AI CONCIERGE</i></span></div>
        <div className="landing-eyebrow"><span>✳</span> YOUR AI WORKSPACE</div>
        <h1>เรื่องที่อยากจัดการ<br /><em>เริ่มตรงนี้ได้เลย</em></h1>
        <p className="landing-subtitle">พิมพ์สิ่งที่ต้องการเหมือนคุยกับ chatbot<br className="desktop-break" /> Supervisor จะถามเพิ่ม แล้วส่งคำตอบหรือไฟล์กลับมาให้</p>
        <form className="landing-form" onSubmit={submitGoal}><textarea autoFocus value={request} onChange={(event) => setRequest(event.target.value)} placeholder="เช่น อยากได้สรุปข้อมูลการลงทุน..." rows={4} required /><div className="landing-form-footer"><span>✧ ไม่ต้องเขียน Prompt ให้สมบูรณ์ — Supervisor จะถามเพิ่มถ้าจำเป็น</span><button className="primary-button" disabled={!request.trim() || Boolean(busy)}>{busy === "supervisor" ? <><span className="spinner light" /> กำลังวิเคราะห์</> : <>เริ่มจัดการงาน <span>→</span></>}</button></div></form>
        <div className="landing-examples"><span>ลองเริ่มจาก</span>{["สรุปข้อมูลการลงทุน", "วางแผนทริป 3 วัน", "ทำเว็บแนะนำคาเฟ่"].map((example) => <button key={example} onClick={() => setRequest(example)}>{example} <span>↗</span></button>)}</div>
        {busy === "supervisor" && <ProgressPanel busy="supervisor" />}
        <div className="landing-trust"><span>◈</span> คุณเป็นผู้สั่งการ — ระบบจะขออนุมัติก่อนเริ่มทำและก่อนส่งมอบ</div>
      </section>}
      </div>
    </section>
    {toast && <div className="toast" role="status">{toast}</div>}
    {!ready && <div className="loading-screen"><span className="spinner" /> กำลังเปิด Workspace...</div>}
  </main>;
}

function ProgressPanel({ busy }: { busy: "supervisor" | "worker" | "qa" }) {
  const status = busy === "supervisor" ? "Supervisor กำลังวิเคราะห์คำขอและจัดแผน" : busy === "worker" ? "Worker กำลังสร้างหรือปรับ Draft ตามแผน" : "Supervisor กำลังตรวจ Draft เทียบกับแผนและ Feedback";
  return <div className="progress-panel"><div className="progress-heading"><span className="spinner" /> <strong>{status}</strong></div><div className="progress-bar"><span /></div></div>;
}

function ProcessStepper({ busy, supervisor, approvedPlan, worker }: { busy: "supervisor" | "worker" | "qa" | null; supervisor: SupervisorResult | null; approvedPlan: boolean; worker: WorkerResult | null }) {
  const stages = [
    { label: "วิเคราะห์เป้าหมาย", complete: Boolean(supervisor) && busy !== "supervisor", active: busy === "supervisor" },
    { label: "ยืนยันแผน", complete: approvedPlan, active: Boolean(supervisor?.status === "ready" && !approvedPlan) },
    { label: "Worker สร้าง Draft", complete: Boolean(worker) && busy !== "worker", active: busy === "worker" },
    { label: "Supervisor ตรวจทาน", complete: worker?.quality?.status === "approved" && busy !== "qa", active: busy === "qa" },
  ];
  const status = busy ? "กำลังดำเนินการ" : worker?.quality?.status === "unavailable" ? "QA ไม่พร้อม — ตรวจ Draft ด้วยตนเอง" : worker ? "พร้อมให้คุณตรวจ" : "รอการดำเนินการ";
  return <div className="process-stepper" aria-label="สถานะกระบวนการ"><div className="process-caption">สถานะงาน <span>{status}</span></div><div className="process-stages">{stages.map((stage, index) => <div className={`process-stage ${stage.complete ? "complete" : ""} ${stage.active ? "active" : ""}`} key={stage.label}><i>{stage.complete ? "✓" : stage.active ? <span className="spinner" /> : String(index + 1).padStart(2, "0")}</i><span>{stage.label}</span></div>)}</div></div>;
}
