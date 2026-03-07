const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

export async function sendTelegramMessage(text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: false,
      }),
    });

    if (!r.ok) {
      const payload = (await r.json().catch(() => null)) as { description?: string } | null;
      console.warn(`[notify] telegram send failed: ${payload?.description ?? r.status}`);
    }
  } catch (err) {
    console.warn(`[notify] telegram error: ${String(err)}`);
  }
}

const STATUS_EMOJI: Record<string, string> = {
  pr_review: "\u{1F50D}",
  done: "\u2705",
  cancelled: "\u274C",
};

const STATUS_LABEL: Record<string, string> = {
  pr_review: "PR Review",
  done: "Complete",
  cancelled: "Cancelled",
};

export function notifyTaskStatus(
  title: string,
  status: string,
  extra?: { taskNumber?: string; prUrl?: string; agentName?: string },
): void {
  const emoji = STATUS_EMOJI[status] ?? "\u{1F4CB}";
  const label = STATUS_LABEL[status] ?? status;
  const tag = extra?.taskNumber ? ` ${extra.taskNumber}` : "";
  const agent = extra?.agentName ? `\nAgent: ${extra.agentName}` : "";
  const pr = extra?.prUrl ? `\nPR: ${extra.prUrl}` : "";

  const text = `${emoji} [${label}]${tag} ${title}${agent}${pr}`;
  void sendTelegramMessage(text);
}
