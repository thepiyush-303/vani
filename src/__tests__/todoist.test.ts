// ============================================================
// todoist.test.ts — Unit tests for executeTodoistTool
// Uses jest.spyOn to mock global fetch.
// ============================================================

import { executeTodoistTool, todoistToolDeclaration } from '../tools/todoist';

// ── Helpers ────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key: string) => headers[key.toLowerCase()] ?? null,
    },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as any;
}

const SAMPLE_TASK = {
  id: 'abc123',
  content: 'Drink milk',
  due: { string: 'today at 7 PM', date: '2026-08-31', datetime: '2026-08-31T19:00:00Z' },
  priority: 1,
  url: 'https://todoist.com/showTask?id=abc123',
};

const ARGS_SUCCESS = JSON.stringify({ content: 'Drink milk', due_string: 'today at 7 PM' });
const ARGS_NO_DUE  = JSON.stringify({ content: 'Buy groceries' });

beforeEach(() => {
  // Provide a default token so each test starts with auth configured
  process.env.TODOIST_API_TOKEN = 'test_token_123';
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.TODOIST_API_TOKEN;
});

// ── Tool schema ────────────────────────────────────────────────

describe('todoistToolDeclaration schema', () => {
  it('has the correct name', () => {
    expect(todoistToolDeclaration.name).toBe('add_todoist_task');
  });

  it('requires the content field', () => {
    expect(todoistToolDeclaration.parameters.required).toContain('content');
  });
});

// ── Success path ───────────────────────────────────────────────

describe('executeTodoistTool — success', () => {
  it('returns success with task details on 200 response', async () => {
    mockFetch(200, SAMPLE_TASK);
    const raw = await executeTodoistTool(ARGS_SUCCESS);
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(result.task_id).toBe('abc123');
    expect(result.content).toBe('Drink milk');
    expect(result.due).toBe('today at 7 PM');
    expect(result.url).toBe(SAMPLE_TASK.url);
  });

  it('sends due_lang: "en" in the request body', async () => {
    mockFetch(200, SAMPLE_TASK);
    await executeTodoistTool(ARGS_SUCCESS);

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.due_lang).toBe('en');
  });

  it('sends X-Request-Id header for idempotency', async () => {
    mockFetch(200, SAMPLE_TASK);
    await executeTodoistTool(ARGS_SUCCESS);

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(options.headers['X-Request-Id']).toBeTruthy();
  });

  it('works without a due_string', async () => {
    const taskNoDue = { ...SAMPLE_TASK, due: undefined, content: 'Buy groceries' };
    mockFetch(200, taskNoDue);
    const raw = await executeTodoistTool(ARGS_NO_DUE);
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(result.due).toBe('No due date set');
  });
});

// ── Auth errors ────────────────────────────────────────────────

describe('executeTodoistTool — auth errors', () => {
  it('returns error when TODOIST_API_TOKEN is not set', async () => {
    delete process.env.TODOIST_API_TOKEN;
    const raw = await executeTodoistTool(ARGS_SUCCESS);
    const result = JSON.parse(raw);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/TODOIST_API_TOKEN/);
  });

  it('returns auth error on 401 response', async () => {
    mockFetch(401, 'Unauthorized');
    const raw = await executeTodoistTool(ARGS_SUCCESS);
    const result = JSON.parse(raw);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/authentication failed/i);
  });
});

// ── Rate limiting ──────────────────────────────────────────────

describe('executeTodoistTool — rate limiting', () => {
  it('retries once on 429 and succeeds', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: { get: () => '0' }, // Retry-After = 0 for fast test
          json: async () => ({}),
          text: async () => 'rate limited',
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => SAMPLE_TASK,
        text: async () => JSON.stringify(SAMPLE_TASK),
      });
    }) as any;

    const raw = await executeTodoistTool(ARGS_SUCCESS);
    const result = JSON.parse(raw);

    expect(callCount).toBe(2);
    expect(result.success).toBe(true);
  }, 10000);
});

// ── Validation ────────────────────────────────────────────────

describe('executeTodoistTool — validation', () => {
  it('returns error for empty content after trim', async () => {
    const raw = await executeTodoistTool(JSON.stringify({ content: '   ' }));
    const result = JSON.parse(raw);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/content is required/i);
  });

  it('returns error for invalid JSON args', async () => {
    const raw = await executeTodoistTool('NOT_VALID_JSON');
    const result = JSON.parse(raw);
    expect(result.success).toBe(false);
  });
});
