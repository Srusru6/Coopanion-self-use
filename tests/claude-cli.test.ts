import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assistantUsage, computeRate, encodeDir, readSessions, Tail, targetForTool, transcriptPath, verbForTool, type ClaudeSession } from '../core/claude-sessions.ts';
import { ClaudeCliWorld } from '../core/claude-cli.ts';

/** A fake `.claude` tree with session files and one transcript, written where the tests say. */
function claudeTree(): string {
  return mkdtempSync(join(tmpdir(), 'coo-claude-'));
}

function sessionFile(root: string, raw: Record<string, unknown>): string {
  const dir = join(root, 'sessions');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${raw.pid as number}.json`);
  writeFileSync(file, JSON.stringify(raw));
  return file;
}

const assistantLine = (usage: Record<string, number>, tool?: { name: string; input?: Record<string, unknown> }, ts = '2026-10-17T10:00:00.000Z'): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      usage,
      ...(tool ? { content: [{ type: 'tool_use', name: tool.name, input: tool.input ?? {} }] } : {}),
      model: 'claude-sonnet-5',
    },
  });

describe('encodeDir', () => {
  it('replaces the drive colon and backslashes with dashes', () => {
    expect(encodeDir('d:\\programs\\Coopanion-self-use')).toBe('d--programs-Coopanion-self-use');
  });
});

describe('readSessions', () => {
  it('reads busy and idle sessions by pid, in pid order', () => {
    const root = claudeTree();
    sessionFile(root, { pid: 2, sessionId: 'b', cwd: '/x', name: 'two', status: 'idle' });
    sessionFile(root, { pid: 1, sessionId: 'a', cwd: '/y', name: 'one', status: 'busy', model: 'claude-sonnet-5' });
    expect(readSessions(root)).toEqual([
      { pid: 1, sessionId: 'a', cwd: '/y', name: 'one', status: 'busy', model: 'claude-sonnet-5' },
      { pid: 2, sessionId: 'b', cwd: '/x', name: 'two', status: 'idle' },
    ]);
  });

  it('skips files that are not live sessions and a missing directory', () => {
    const root = claudeTree();
    expect(readSessions(root)).toEqual([]);
    sessionFile(root, { pid: 3, status: 'busy' }); // no sessionId
    writeFileSync(join(root, 'sessions', '4.json'), '{not json');
    expect(readSessions(root)).toEqual([]);
  });

  it("maps the CLI's waiting and shell statuses to waiting", () => {
    const root = claudeTree();
    sessionFile(root, { pid: 1, sessionId: 'a', cwd: '/x', name: 'one', status: 'waiting' });
    sessionFile(root, { pid: 2, sessionId: 'b', cwd: '/y', name: 'two', status: 'shell' });
    expect(readSessions(root).map((s) => s.status)).toEqual(['waiting', 'waiting']);
  });
});

describe('transcriptPath', () => {
  it('prefers the directory derived from the cwd, then scans projects/', () => {
    const root = claudeTree();
    const session: ClaudeSession = { pid: 1, sessionId: 'abc', cwd: 'd:\\prog', name: 'n', status: 'busy' };
    expect(transcriptPath(root, session)).toBeNull();
    const scan = join(root, 'projects', 'elsewhere', 'abc.jsonl');
    mkdirSync(join(root, 'projects', 'elsewhere'), { recursive: true });
    writeFileSync(scan, '');
    expect(transcriptPath(root, session)).toBe(scan);
  });
});

describe('assistantUsage', () => {
  it('returns null for non-assistant lines and assistant lines without usage', () => {
    expect(assistantUsage('{"type":"user"}')).toBeNull();
    expect(assistantUsage(assistantLine({ input_tokens: 0, output_tokens: 0 }))).toBeNull();
  });

  it('sums input, cache read and cache creation, and reads output separately', () => {
    const step = assistantUsage(assistantLine({ input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 40 }));
    expect(step).toMatchObject({ input: 100, cache: 60, output: 40, tool: null, target: '', model: 'claude-sonnet-5' });
  });

  it('maps a tool name to a verb and its short target', () => {
    const step = assistantUsage(assistantLine({ input_tokens: 1, output_tokens: 1 }, { name: 'Edit', input: { file_path: 'src/deep/nested/file.ts' } }));
    expect(step?.tool).toBe('edit');
    expect(step?.target).toBe('file.ts');
  });
});

describe('verbForTool', () => {
  it('maps known tool names and falls back to other', () => {
    expect(verbForTool('Read')).toBe('read');
    expect(verbForTool('Write')).toBe('edit');
    expect(verbForTool('Bash')).toBe('bash');
    expect(verbForTool('Glob')).toBe('search');
    expect(verbForTool('Agent')).toBe('agent');
    expect(verbForTool('WebFetch')).toBe('web');
    expect(verbForTool('SomethingNew')).toBe('other');
  });
});

describe('targetForTool', () => {
  it('picks the target field for each tool and shortens long ones', () => {
    expect(targetForTool('Read', { file_path: 'a/b/c.ts' })).toBe('c.ts');
    expect(targetForTool('Bash', { command: 'npm run build --verbose' })).toBe('npm run build --verbose');
    expect(targetForTool('Grep', { pattern: 'x'.repeat(40) })).toBe(`${'x'.repeat(24)}…`);
    expect(targetForTool('WebSearch', { query: 'weather' })).toBe('weather');
    expect(targetForTool('Other', {})).toBe('');
  });
});

describe('computeRate', () => {
  it('is zero with fewer than two samples or a non-positive window', () => {
    expect(computeRate([], 60_000)).toBe(0);
    expect(computeRate([{ t: 0, tokens: 5 }], 60_000)).toBe(0);
    expect(computeRate([{ t: 0, tokens: 5 }, { t: 1000, tokens: 7 }], 0)).toBe(0);
  });

  it('divides the token delta by the elapsed time over the window', () => {
    // 100 tokens over 2s = 50 tok/s
    expect(computeRate([{ t: 0, tokens: 0 }, { t: 2000, tokens: 100 }], 60_000)).toBe(50);
  });
});

describe('Tail', () => {
  it('reads only complete lines appended since the last read', () => {
    const root = claudeTree();
    const file = join(root, 't.jsonl');
    writeFileSync(file, 'one\n');
    const tail = new Tail(file);
    expect(tail.readNew()).toEqual(['one']);
    expect(tail.readNew()).toEqual([]);
    writeFileSync(file, 'one\ntwo\nthree');
    expect(tail.readNew()).toEqual(['two']); // "three" has no newline yet
    writeFileSync(file, 'one\ntwo\nthree\nfour\n');
    expect(tail.readNew()).toEqual(['three', 'four']);
  });
});

describe('ClaudeCliWorld', () => {
  it('emits started and progress events and an ambient status while a session is busy', async () => {
    const root = claudeTree();
    const pid = 7;
    const sessionId = 'sess-7';
    sessionFile(root, { pid, sessionId, cwd: 'd:\\prog', name: 'build', status: 'busy' });
    const projectDir = join(root, 'projects', encodeDir('d:\\prog'));
    mkdirSync(projectDir, { recursive: true });
    const transcript = join(projectDir, `${sessionId}.jsonl`);
    // a line that predates the watch: it must not be replayed as fresh damage
    writeFileSync(transcript, `${assistantLine({ input_tokens: 999, output_tokens: 999 }, { name: 'Read', input: { file_path: 'old.txt' } })}\n`);

    const events: { type: string; text: string }[] = [];
    const hits: number[] = [];
    const seen: { ambient: { active: boolean; text: string; detail?: string } | null } = { ambient: null };
    const world = new ClaudeCliWorld({
      claudeDir: () => root,
      read: () => 'zh',
      petConnected: () => true,
      ambient: (status) => { seen.ambient = status; },
      hit: (tokens) => { hits.push(tokens); },
      alert: () => {},
      alertClear: () => {},
      label: () => 'Claude',
    });
    const host = {
      pushDeferred: (e: { type: string; render: () => string }) => { events.push({ type: e.type, text: e.render() }); },
    } as unknown as Parameters<ClaudeCliWorld['start']>[0];

    await world.start(host);
    (world as unknown as { tick(): void }).tick(); // the watch begins after the old line
    expect(hits).toEqual([]);
    appendFileSync(transcript, `${assistantLine({ input_tokens: 100, output_tokens: 40 }, { name: 'Bash', input: { command: 'npm test' } })}\n`);
    (world as unknown as { tick(): void }).tick();
    await world.stop();

    expect(hits).toEqual([140]);
    expect(events.some((e) => e.type === 'claude-cli.started')).toBe(true);
    expect(events.some((e) => e.type === 'claude-cli.progress' && e.text.includes('npm test'))).toBe(true);
    expect(seen.ambient?.active).toBe(true);
    expect(seen.ambient?.text).toBe('Claude 工作中');
    expect(seen.ambient?.detail).toContain('npm test');
  });

  it('hides the ambient chip when no session is busy', async () => {
    const root = claudeTree();
    sessionFile(root, { pid: 1, sessionId: 'a', cwd: '/x', name: 'one', status: 'idle' });
    const seen: { ambient: { active: boolean; text: string; detail?: string } | null } = { ambient: null };
    const world = new ClaudeCliWorld({
      claudeDir: () => root,
      read: () => 'zh',
      petConnected: () => true,
      ambient: (status) => { seen.ambient = status; },
      hit: () => {},
      alert: () => {},
      alertClear: () => {},
      label: () => 'Claude',
    });
    const host = { pushDeferred: () => {} } as unknown as Parameters<ClaudeCliWorld['start']>[0];
    await world.start(host);
    (world as unknown as { tick(): void }).tick();
    await world.stop();
    expect(seen.ambient).toEqual({ active: false, text: '' });
  });

  it('raises an approval card while a session needs approval and clears it when it resumes', async () => {
    const root = claudeTree();
    const pid = 9;
    const alerts: { id: number; kind: 'approval' | 'done'; text: string }[] = [];
    const cleared: number[] = [];
    const world = new ClaudeCliWorld({
      claudeDir: () => root,
      read: () => 'zh',
      petConnected: () => true,
      ambient: () => {},
      hit: () => {},
      alert: (id, kind, text) => { alerts.push({ id, kind, text }); },
      alertClear: (id) => { cleared.push(id); },
      label: () => 'Claude',
    });
    const host = { pushDeferred: () => {} } as unknown as Parameters<ClaudeCliWorld['start']>[0];
    await world.start(host);
    const tick = () => (world as unknown as { tick(): void }).tick();

    sessionFile(root, { pid, sessionId: 'sess-9', cwd: 'd:\\prog', name: 'build', status: 'busy' });
    tick();
    sessionFile(root, { pid, sessionId: 'sess-9', cwd: 'd:\\prog', name: 'build', status: 'waiting' });
    tick();
    expect(alerts).toEqual([{ id: pid, kind: 'approval', text: 'build 需要你确认' }]);

    sessionFile(root, { pid, sessionId: 'sess-9', cwd: 'd:\\prog', name: 'build', status: 'busy' });
    tick();
    expect(cleared).toEqual([pid]);

    await world.stop();
  });

  it('raises a done card on finish and keeps a clicked-away card down until the next finish', async () => {
    const root = claudeTree();
    const pid = 10;
    const alerts: { id: number; kind: 'approval' | 'done'; text: string }[] = [];
    const world = new ClaudeCliWorld({
      claudeDir: () => root,
      read: () => 'zh',
      petConnected: () => true,
      ambient: () => {},
      hit: () => {},
      alert: (id, kind, text) => { alerts.push({ id, kind, text }); },
      alertClear: () => {},
      label: () => 'Claude',
    });
    const host = { pushDeferred: () => {} } as unknown as Parameters<ClaudeCliWorld['start']>[0];
    await world.start(host);
    const tick = () => (world as unknown as { tick(): void }).tick();

    sessionFile(root, { pid, sessionId: 'sess-10', cwd: 'd:\\prog', name: 'build', status: 'busy' });
    tick();
    sessionFile(root, { pid, sessionId: 'sess-10', cwd: 'd:\\prog', name: 'build', status: 'idle' });
    tick();
    expect(alerts).toEqual([{ id: pid, kind: 'done', text: 'build 任务完成' }]);

    world.dismissAlert(pid);
    tick();
    expect(alerts).toHaveLength(1);

    sessionFile(root, { pid, sessionId: 'sess-10', cwd: 'd:\\prog', name: 'build', status: 'busy' });
    tick();
    sessionFile(root, { pid, sessionId: 'sess-10', cwd: 'd:\\prog', name: 'build', status: 'idle' });
    tick();
    expect(alerts).toEqual([
      { id: pid, kind: 'done', text: 'build 任务完成' },
      { id: pid, kind: 'done', text: 'build 任务完成' },
    ]);

    await world.stop();
  });
});
