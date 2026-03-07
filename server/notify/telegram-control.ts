import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PORT, SESSION_AUTH_TOKEN } from "../config/runtime.js";
import { sendTelegramMessage } from "./telegram.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";
const TELEGRAM_CONTROL_ENABLED = process.env.TELEGRAM_CONTROL_ENABLED === "true";
const TELEGRAM_OFFSET_PATH = join("data", "telegram-control-offset.txt");

let running = false;
let offset = 0;

interface TgUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id?: number };
    message_id?: number;
  };
}

type InteractivePromptType = "exit_plan_mode" | "ask_user_question" | "text_input_request";

interface InteractiveResponseRequestResult {
  ok: true;
  payload: {
    promptType: InteractivePromptType;
    approved: boolean;
    freeText?: string;
  };
}

interface InteractiveResponseRequestError {
  ok: false;
  detail: string;
}

export function loadTelegramOffset(filePath = TELEGRAM_OFFSET_PATH): number {
  try {
    if (!existsSync(filePath)) return 0;
    const raw = readFileSync(filePath, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

export function saveTelegramOffset(filePath = TELEGRAM_OFFSET_PATH, nextOffset: number): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${nextOffset}\n`, "utf8");
}

export function getBootstrapOffset(updates: Array<Pick<TgUpdate, "update_id">>): number {
  if (updates.length === 0) return 0;
  return Math.max(...updates.map((update) => update.update_id)) + 1;
}

export function buildInteractiveResponseRequest(
  interactivePromptData: string | null | undefined,
  approved: boolean,
  freeText?: string,
): InteractiveResponseRequestResult | InteractiveResponseRequestError {
  if (!interactivePromptData) {
    return { ok: false, detail: "no_pending_prompt" };
  }

  try {
    const parsed = JSON.parse(interactivePromptData) as {
      data?: {
        promptType?: InteractivePromptType;
      };
    };
    const promptType = parsed.data?.promptType;
    if (!promptType) {
      return { ok: false, detail: "no_pending_prompt" };
    }
    if (promptType !== "exit_plan_mode") {
      return { ok: false, detail: `unsupported_prompt_type:${promptType}` };
    }
    return {
      ok: true,
      payload: {
        promptType,
        approved,
        freeText: freeText || undefined,
      },
    };
  } catch {
    return { ok: false, detail: "invalid_interactive_prompt_data" };
  }
}

async function callInteractiveResponse(taskId: string, approved: boolean, freeText?: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const taskResponse = await fetch(`http://127.0.0.1:${PORT}/api/tasks/${taskId}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${SESSION_AUTH_TOKEN}`,
      },
    });
    if (!taskResponse.ok) {
      const payload = (await taskResponse.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, detail: payload?.error ?? `HTTP ${taskResponse.status}` };
    }

    const taskPayload = (await taskResponse.json().catch(() => null)) as { interactive_prompt_data?: string | null } | null;
    const responseRequest = buildInteractiveResponseRequest(taskPayload?.interactive_prompt_data, approved, freeText);
    if (!responseRequest.ok) {
      return responseRequest;
    }

    const r = await fetch(`http://127.0.0.1:${PORT}/api/tasks/${taskId}/interactive-response`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SESSION_AUTH_TOKEN}`,
      },
      body: JSON.stringify(responseRequest.payload),
    });

    if (!r.ok) {
      const payload = (await r.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, detail: payload?.error ?? `HTTP ${r.status}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

async function handleCommand(text: string): Promise<void> {
  const t = text.trim();

  if (t === "/ao_help" || t === "/ao") {
    await sendTelegramMessage(
      [
        "Agent Organizer 承認コマンド:",
        "/ao_approve <task_id>",
        "/ao_reject <task_id> [理由]",
      ].join("\n"),
    );
    return;
  }

  if (t.startsWith("/ao_approve ")) {
    const taskId = t.replace("/ao_approve", "").trim();
    if (!taskId) {
      await sendTelegramMessage("使い方: /ao_approve <task_id>");
      return;
    }

    const result = await callInteractiveResponse(taskId, true);
    await sendTelegramMessage(result.ok
      ? `✅ 承認しました: ${taskId}`
      : `❌ 承認失敗: ${taskId}\n理由: ${result.detail}`);
    return;
  }

  if (t.startsWith("/ao_reject ")) {
    const rest = t.replace("/ao_reject", "").trim();
    const [taskId, ...reasonParts] = rest.split(/\s+/);
    if (!taskId) {
      await sendTelegramMessage("使い方: /ao_reject <task_id> [理由]");
      return;
    }
    const reason = reasonParts.join(" ").trim();

    const result = await callInteractiveResponse(taskId, false, reason || undefined);
    await sendTelegramMessage(result.ok
      ? `🛑 却下しました: ${taskId}${reason ? `\n理由: ${reason}` : ""}`
      : `❌ 却下失敗: ${taskId}\n理由: ${result.detail}`);
  }
}

async function pollOnce(): Promise<void> {
  const url = new URL(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`);
  if (offset > 0) url.searchParams.set("offset", String(offset));
  url.searchParams.set("timeout", "20");

  const r = await fetch(url, { method: "GET" });
  if (!r.ok) return;

  const payload = (await r.json().catch(() => null)) as { ok?: boolean; result?: TgUpdate[] } | null;
  if (!payload?.ok || !Array.isArray(payload.result)) return;

  for (const u of payload.result) {
    offset = Math.max(offset, u.update_id + 1);
    saveTelegramOffset(TELEGRAM_OFFSET_PATH, offset);

    const msg = u.message;
    if (!msg?.text) continue;
    if (String(msg.chat?.id ?? "") !== TELEGRAM_CHAT_ID) continue;

    if (msg.text.startsWith("/ao_")) {
      await handleCommand(msg.text);
    }
  }
}

async function seedTelegramOffsetFromLatestUpdate(): Promise<void> {
  if (offset > 0) return;

  try {
    const url = new URL(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`);
    url.searchParams.set("limit", "1");
    url.searchParams.set("timeout", "0");

    const r = await fetch(url, { method: "GET" });
    if (!r.ok) return;

    const payload = (await r.json().catch(() => null)) as { ok?: boolean; result?: TgUpdate[] } | null;
    if (!payload?.ok || !Array.isArray(payload.result)) return;

    const seededOffset = getBootstrapOffset(payload.result);
    if (seededOffset > 0) {
      offset = seededOffset;
      saveTelegramOffset(TELEGRAM_OFFSET_PATH, offset);
    }
  } catch {
    // ignore bootstrap failures and fall back to offset=0
  }
}

export function startTelegramControlPoller(): void {
  if (running) return;
  if (!TELEGRAM_CONTROL_ENABLED) return;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  running = true;
  offset = loadTelegramOffset();
  void sendTelegramMessage("🤖 Agent Organizer Telegram承認コマンドを有効化しました。/ao_help で使い方を表示");

  const loop = async () => {
    if (!running) return;
    try {
      await seedTelegramOffsetFromLatestUpdate();
      await pollOnce();
    } catch {
      // ignore polling failures and retry
    }
    setTimeout(loop, 1500);
  };

  void loop();
}
