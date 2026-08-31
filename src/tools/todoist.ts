// ============================================================
// todoist.ts — Todoist REST API v2 task creation tool
// PRD_v2.md §C: uses native NLP by passing due_string verbatim.
// ============================================================

import { randomUUID } from 'crypto';

// ── Tool definition for Gemini (functionDeclarations format) ──

export const todoistToolDeclaration = {
  name: 'add_todoist_task',
  description:
    "Create a new task in the user's Todoist. Use this when the user wants to add a reminder, to-do, or task. " +
    "Pass the user's raw time expression (e.g., 'tomorrow at 3pm', 'every Monday') directly in due_string — " +
    'Todoist will parse it automatically. Do NOT pre-convert time expressions to ISO dates.',
  parameters: {
    type: 'OBJECT',
    properties: {
      content: {
        type: 'STRING',
        description:
          'The task name. Keep it concise and action-oriented (e.g., "Drink milk", "Call dentist"). Max 500 chars.',
      },
      due_string: {
        type: 'STRING',
        description:
          "Natural language due date/time. Pass the user's raw expression verbatim (e.g., 'tomorrow at 9am', 'every weekday'). Todoist's NLP parses this.",
      },
      priority: {
        type: 'INTEGER',
        description:
          'Task priority: 1=normal (default), 2=medium, 3=high, 4=urgent. Infer from user language.',
      },
      description: {
        type: 'STRING',
        description: 'Optional additional notes or context for the task body.',
      },
      labels: {
        type: 'ARRAY',
        items: { type: 'STRING' },
        description: 'Optional list of existing Todoist label names to apply.',
      },
    },
    required: ['content'],
  },
};

// ── Internal interfaces ────────────────────────────────────────

interface TodoistPayload {
  content: string;
  due_string?: string;
  due_lang: 'en'; // always set to ensure NLP uses English parser
  priority?: number;
  description?: string;
  labels?: string[];
}

interface TodoistApiTask {
  id: string;
  content: string;
  due?: { string: string; date: string; datetime?: string };
  priority: number;
  url: string;
}

// ── Executor ──────────────────────────────────────────────────

const TODOIST_API_URL = 'https://api.todoist.com/rest/v2/tasks';

interface TodoistArgs {
  content: string;
  due_string?: string;
  priority?: number;
  description?: string;
  labels?: string[];
}

/**
 * Calls the Todoist REST API v2 to create a task.
 * Returns a JSON string ready to be inserted into Gemini's function response.
 *
 * @param argsJson  Raw JSON string from LLM tool call arguments
 */
export async function executeTodoistTool(argsJson: string): Promise<string> {
  const TODOIST_TOKEN = process.env.TODOIST_API_TOKEN ?? '';

  if (!TODOIST_TOKEN) {
    console.error('[todoist] TODOIST_API_TOKEN is not set');
    return JSON.stringify({
      success: false,
      error: 'TODOIST_API_TOKEN is not configured on the server.',
    });
  }

  let args: TodoistArgs;
  try {
    args = JSON.parse(argsJson) as TodoistArgs;
  } catch {
    return JSON.stringify({ success: false, error: 'Failed to parse Todoist tool arguments.' });
  }

  // Validate required field
  const content = (args.content ?? '').trim().slice(0, 500);
  if (!content) {
    return JSON.stringify({ success: false, error: 'Task content is required.' });
  }

  const payload: TodoistPayload = {
    content,
    due_lang: 'en', // always set; ensures Todoist NLP uses the English parser
    priority: args.priority && [1, 2, 3, 4].includes(args.priority) ? args.priority : 1,
  };

  if (args.due_string)               payload.due_string   = args.due_string;
  if (args.description?.trim())      payload.description  = args.description.trim().slice(0, 1000);
  if (args.labels && args.labels.length > 0) payload.labels = args.labels.slice(0, 10);

  try {
    const res = await fetch(TODOIST_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TODOIST_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Request-Id': randomUUID(), // idempotency key — prevents duplicate tasks on retry
      },
      body: JSON.stringify(payload),
      // 4-second hard timeout (PRD_v2.md §C.2)
      signal: AbortSignal.timeout(4000),
    });

    if (res.status === 401) {
      return JSON.stringify({
        success: false,
        error: 'Todoist authentication failed. Check TODOIST_API_TOKEN.',
      });
    }

    if (res.status === 429) {
      // Honour Retry-After and attempt one retry
      const retryAfter = Number(res.headers.get('Retry-After') ?? '2');
      const waitMs = Math.min(retryAfter * 1000, 5000);
      console.warn(`[todoist] Rate limited — retrying after ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));

      const retry = await fetch(TODOIST_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TODOIST_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Request-Id': randomUUID(),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000),
      });

      if (!retry.ok) {
        return JSON.stringify({
          success: false,
          error: `Todoist is busy right now (${retry.status}). Please try again.`,
        });
      }
      const task: TodoistApiTask = await retry.json() as TodoistApiTask;
      return buildSuccess(task);
    }

    if (!res.ok) {
      const body = await res.text();
      return JSON.stringify({
        success: false,
        error: `Todoist API error ${res.status}: ${body.slice(0, 200)}`,
      });
    }

    const task: TodoistApiTask = await res.json() as TodoistApiTask;
    return buildSuccess(task);

  } catch (err: unknown) {
    const isTimeout =
      err instanceof DOMException && err.name === 'TimeoutError';
    const msg = isTimeout
      ? "Couldn't reach Todoist — request timed out. Please try again."
      : `Todoist request failed: ${String(err).slice(0, 200)}`;
    console.error(`[todoist] ${msg}`);
    return JSON.stringify({ success: false, error: msg });
  }
}

function buildSuccess(task: TodoistApiTask): string {
  return JSON.stringify({
    success: true,
    task_id: task.id,
    content: task.content,
    // "due.string" is the human-readable representation Todoist parsed.
    // This is what the LLM uses to confirm back to the user — never the URL.
    due: task.due?.string ?? 'No due date set',
    // url is included for completeness but MUST NOT be read aloud by TTS.
    // The upstream sanitizeForTTS will strip it if it somehow leaks into LLM text.
    url: task.url,
  });
}
