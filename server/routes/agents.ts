import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RuntimeContext, Agent } from "../types/runtime.js";
import { DEFAULT_CLI_MODELS } from "../config/runtime.js";

const VALID_ROLES = ["lead_engineer", "tester", "code_reviewer", "architect", "security_reviewer", "researcher", "devops", "designer", "planner"] as const;

const CreateAgentSchema = z.object({
  name: z.string().min(1).max(100),
  cli_provider: z.enum(["claude", "codex", "gemini"]).default("claude"),
  cli_model: z.string().nullish(),
  cli_reasoning_level: z.string().nullish(),
  avatar_emoji: z.string().default("🤖"),
  role: z.enum(VALID_ROLES).nullish(),
  agent_type: z.enum(["worker", "ceo"]).default("worker"),
  personality: z.string().nullish(),
});

const UpdateAgentSchema = CreateAgentSchema.partial();

export function resolveDefaultCliReasoningLevel(
  cliProvider: "claude" | "codex" | "gemini",
  requestedLevel: string | null | undefined,
): string | null {
  if (requestedLevel !== undefined) {
    return requestedLevel ?? null;
  }
  return cliProvider === "codex" ? "high" : null;
}

export function createAgentsRouter(ctx: RuntimeContext): Router {
  const router = Router();
  const { db, ws } = ctx;

  router.get("/agents", (_req, res) => {
    const agents = db.prepare("SELECT * FROM agents ORDER BY created_at DESC").all();
    res.json(agents);
  });

  router.get("/agents/:id", (req, res) => {
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(req.params.id);
    if (!agent) return res.status(404).json({ error: "not_found" });
    res.json(agent);
  });

  router.post("/agents", (req, res) => {
    const parsed = CreateAgentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const id = randomUUID();
    const now = Date.now();
    const { name, cli_provider, cli_model, cli_reasoning_level, avatar_emoji, role, agent_type, personality } = parsed.data;
    const resolvedModel = cli_model ?? DEFAULT_CLI_MODELS[cli_provider] ?? null;
    const resolvedReasoningLevel = resolveDefaultCliReasoningLevel(cli_provider, cli_reasoning_level);

    try {
      db.prepare(
        `INSERT INTO agents (id, name, cli_provider, cli_model, cli_reasoning_level, avatar_emoji, role, agent_type, personality, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, name, cli_provider, resolvedModel, resolvedReasoningLevel, avatar_emoji, role ?? null, agent_type, personality ?? null, now, now);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        return res.status(409).json({ error: "duplicate_name", message: `Agent name already exists: ${name}` });
      }
      throw err;
    }

    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    ws.broadcast("agent_status", agent);
    res.status(201).json(agent);
  });

  router.put("/agents/:id", (req, res) => {
    const existing = db.prepare("SELECT * FROM agents WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "not_found" });

    const parsed = UpdateAgentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const updates = parsed.data;
    const now = Date.now();
    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push((value ?? null) as string | number | null);
      }
    }
    fields.push("updated_at = ?");
    values.push(now);
    values.push(req.params.id);

    try {
      db.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`).run(...(values as Array<string | number | null>));
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        return res.status(409).json({ error: "duplicate_name", message: `Agent name already exists: ${updates.name}` });
      }
      throw err;
    }
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(req.params.id);
    ws.broadcast("agent_status", agent);
    res.json(agent);
  });

  router.delete("/agents/:id", (req, res) => {
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(req.params.id) as Agent | undefined;
    if (!agent) return res.status(404).json({ error: "not_found" });
    if (agent.status === "working") return res.status(409).json({ error: "agent_busy" });

    db.prepare("DELETE FROM agents WHERE id = ?").run(req.params.id);
    res.json({ deleted: true });
  });

  return router;
}
