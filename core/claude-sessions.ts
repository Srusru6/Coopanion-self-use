/**
 * Reads the Claude Code CLI's on-disk state, without changing its configuration: the running
 * sessions in `<claude>/sessions/<pid>.json` and each session's transcript in
 * `<claude>/projects/<encoded-cwd>/<sessionId>.jsonl`. Only token counts, tool names and their
 * targets, session names and working directories are read; what the conversation says or thinks
 * never is. This module is pure file reading and arithmetic; `claude-cli.ts` owns the polling loop
 * and the counters.
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** What a session is doing, as its `status` field has it. `waiting` covers the CLI's `waiting` and
 *  `shell` values: the turn is blocked until the person approves or answers, not doing work. */
export type ClaudeStatus = 'busy' | 'idle' | 'waiting';

/** A running Claude Code session, as `sessions/<pid>.json` has it. */
export interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  status: ClaudeStatus;
  model?: string;
}

/** One point of a session's cumulative consumed tokens over time, for the speed window. */
export interface RateSample {
  t: number;
  tokens: number;
}

/** The verb the status and the dashboard show for a tool; localized at display time. */
export type ToolVerb = 'read' | 'edit' | 'bash' | 'search' | 'agent' | 'web' | 'other';

/** Where the CLI keeps its state; a deployment can point elsewhere with `CLAUDE_CONFIG_DIR`. */
export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

/** The transcript directory name the CLI derives from a working directory. */
export function encodeDir(cwd: string): string {
  return cwd.replace(/[:\\]/g, '-');
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The running sessions, by pid; a file that is not a live session is skipped. */
export function readSessions(root: string): ClaudeSession[] {
  const dir = join(root, 'sessions');
  if (!existsSync(dir)) return [];
  const out: ClaudeSession[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>; } catch { continue; }
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : '';
    if (!sessionId) continue;
    out.push({
      pid: typeof raw.pid === 'number' ? raw.pid : Number(name.slice(0, -'.json'.length)),
      sessionId,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
      name: typeof raw.name === 'string' ? raw.name : '',
      status: raw.status === 'busy' ? 'busy' : raw.status === 'waiting' || raw.status === 'shell' ? 'waiting' : 'idle',
      ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
    });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

/** The transcript of a session, by the directory-name rule and, failing that, a scan of `projects/`. */
export function transcriptPath(root: string, session: ClaudeSession): string | null {
  const expected = join(root, 'projects', encodeDir(session.cwd), `${session.sessionId}.jsonl`);
  if (existsSync(expected)) return expected;
  const projects = join(root, 'projects');
  if (!existsSync(projects)) return null;
  for (const name of readdirSync(projects)) {
    const file = join(projects, name, `${session.sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

/** Reads a growing file by byte offset; the last, still-written line waits for its end. */
export class Tail {
  private offset = 0;
  private pending = '';

  constructor(private readonly file: string) {}

  /** Starts at the last complete line, so what was already written is not replayed and a line still being written is not half-read. */
  skipToEnd(): void {
    this.pending = '';
    let size: number;
    try { size = statSync(this.file).size; } catch { this.offset = 0; return; }
    if (size === 0) { this.offset = 0; return; }
    let fd: number;
    try { fd = openSync(this.file, 'r'); } catch { this.offset = 0; return; }
    try {
      let pos = size;
      const chunk = Buffer.allocUnsafe(64 * 1024);
      while (pos > 0) {
        const back = Math.min(pos, chunk.length);
        const start = pos - back;
        const read = readSync(fd, chunk, 0, back, start);
        if (read <= 0) { this.offset = 0; return; }
        const nl = chunk.lastIndexOf(0x0a, read - 1);
        if (nl !== -1) { this.offset = start + nl + 1; return; }
        pos = start;
      }
      this.offset = 0;
    } finally { closeSync(fd); }
  }

  /** Complete lines appended since the last read. A file that shrank is read again from its start. */
  readNew(): string[] {
    let size: number;
    try { size = statSync(this.file).size; } catch { return []; }
    if (size < this.offset) { this.offset = 0; this.pending = ''; }
    if (size === this.offset) return [];
    const want = size - this.offset;
    const buf = Buffer.allocUnsafe(want);
    let read = 0;
    let fd: number;
    try { fd = openSync(this.file, 'r'); } catch { return []; }
    try {
      while (read < want) {
        const n = readSync(fd, buf, read, want - read, this.offset + read);
        if (n <= 0) break;
        read += n;
      }
    } finally { closeSync(fd); }
    this.offset += read;
    this.pending += buf.subarray(0, read).toString('utf8');
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    return lines;
  }
}

/** One `assistant` line's tokens, tool and target; null when it is another kind or carries no usage. */
export interface AssistantStep {
  at: number;
  input: number;
  output: number;
  cache: number;
  tool: ToolVerb | null;
  target: string;
  model: string;
}

export function assistantUsage(line: string): AssistantStep | null {
  let rec: Record<string, unknown>;
  try { rec = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (rec.type !== 'assistant') return null;
  const message = rec.message;
  if (!message || typeof message !== 'object') return null;
  const m = message as Record<string, unknown>;
  const usage = m.usage as Record<string, unknown> | undefined;
  const input = num(usage?.input_tokens);
  const cache = num(usage?.cache_read_input_tokens) + num(usage?.cache_creation_input_tokens);
  const output = num(usage?.output_tokens);
  if (input + cache + output === 0) return null;
  let tool: ToolVerb | null = null;
  let target = '';
  for (const block of Array.isArray(m.content) ? m.content : []) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'tool_use' && typeof b.name === 'string') {
      tool = verbForTool(b.name);
      target = targetForTool(b.name, (b.input ?? {}) as Record<string, unknown>);
      break;
    }
  }
  const model = typeof m.model === 'string' ? m.model : typeof rec.model === 'string' ? rec.model : '';
  return { at: typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : 0, input, output, cache, tool, target, model };
}

/** The verb a tool name shows as; unknown tools are `other`. */
export function verbForTool(name: string): ToolVerb {
  switch (name) {
    case 'Read': case 'NotebookRead': case 'ReadFiles': return 'read';
    case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'edit';
    case 'Bash': case 'BashOutput': return 'bash';
    case 'Grep': case 'Glob': return 'search';
    case 'Agent': case 'Task': return 'agent';
    case 'WebSearch': case 'WebFetch': return 'web';
    default: return 'other';
  }
}

const TARGET_MAX = 24;
const shorten = (text: string): string => (text.length > TARGET_MAX ? `${text.slice(0, TARGET_MAX)}…` : text);
const leaf = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;

/** The short target a tool works on, for the status and dashboard; empty when none. */
export function targetForTool(name: string, input: Record<string, unknown>): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  switch (name) {
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return shorten(leaf(str(input.file_path) || str(input.path) || str(input.notebook_path)));
    case 'Bash': case 'BashOutput':
      return shorten(str(input.command));
    case 'Grep': case 'Glob':
      return shorten(str(input.pattern));
    case 'Agent': case 'Task':
      return shorten(str(input.subagent_type) || str(input.description));
    case 'WebSearch':
      return shorten(str(input.query));
    case 'WebFetch':
      return shorten(str(input.url));
    default:
      return '';
  }
}

/** Tokens per second over `windowMs`, from the window's cumulative consumed tokens. */
export function computeRate(samples: readonly RateSample[], windowMs: number): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1]!;
  const cutoff = last.t - windowMs;
  let start = samples[0]!;
  for (const s of samples) if (s.t >= cutoff) { start = s; break; }
  const dt = last.t - start.t;
  if (dt <= 0) return 0;
  return ((last.tokens - start.tokens) / dt) * 1000;
}
