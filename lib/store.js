/**
 * 插件的持久状态与状态快照。
 *
 * 状态放在 DSH_HOME 下（与其它 DSH 插件一致），绝不写进用户工作区：
 * 写进工作区会在每个项目里显示成「被修改的文件」。
 *   - state.json  暂停中的任务、错峰规划、上次时段
 *   - status.json 给 Web 界面读的只读快照
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STATE_VERSION = 1;
const MAX_RECORDS = 120;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeName(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function normalizeRecord(record) {
  if (record === null || typeof record !== 'object') return null;
  const id = normalizeName(record.id, null);
  const sessionId = normalizeName(record.sessionId, null);
  if (id === null || sessionId === null) return null;
  return { ...record, id, sessionId };
}

function pruned(list, keep = MAX_RECORDS) {
  const protectedItems = list.filter((item) => item.status === 'paused' || item.status === 'queued');
  const loose = list.filter((item) => item.status !== 'paused' && item.status !== 'queued');
  const trimmedLoose = loose.length > keep ? loose.slice(loose.length - keep) : loose;
  const merged = [...trimmedLoose, ...protectedItems];
  merged.sort((left, right) => Number(right.at ?? right.createdAt ?? 0) - Number(left.at ?? left.createdAt ?? 0));
  return merged;
}

export function emptyState() {
  return { version: STATE_VERSION, interrupted: [], plans: [], meta: { lastPhase: null, lastTick: 0 } };
}

export function normalizeState(raw) {
  const state = emptyState();
  if (raw === null || typeof raw !== 'object') return state;
  state.interrupted = asArray(raw.interrupted)
    .map(normalizeRecord)
    .filter((item) => item !== null && item.status !== undefined)
    .map((item) => ({ ...item, status: normalizeName(item.status, 'paused') }));
  state.plans = asArray(raw.plans)
    .map(normalizeRecord)
    .filter((item) => item !== null)
    .map((item) => ({ ...item, title: normalizeName(item.title, '未命名任务'), status: normalizeName(item.status, 'queued') }));
  const meta = raw.meta !== null && typeof raw.meta === 'object' ? raw.meta : {};
  state.meta = {
    lastPhase: meta.lastPhase === 'peak' || meta.lastPhase === 'offpeak' ? meta.lastPhase : null,
    lastTick: Number.isFinite(Number(meta.lastTick)) ? Number(meta.lastTick) : 0,
  };
  state.interrupted = pruned(state.interrupted);
  state.plans = pruned(state.plans);
  return state;
}

export class StateFile {
  /** @param {string} file */
  constructor(file) {
    this.file = file;
    this.loaded = null;
    this.writing = Promise.resolve();
  }

  async read() {
    if (this.loaded !== null) return this.loaded;
    try {
      const text = await readFile(this.file, 'utf8');
      this.loaded = normalizeState(JSON.parse(text));
    } catch {
      this.loaded = emptyState();
    }
    return this.loaded;
  }

  /** 串行化写入：同一文件同时只跑一个临时文件 + rename。 */
  async write(state) {
    this.loaded = normalizeState(state);
    const snapshot = this.loaded;
    this.writing = this.writing
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
        try {
          await writeFile(temp, JSON.stringify(snapshot, null, 2), 'utf8');
          await rename(temp, this.file);
        } catch (error) {
          await unlink(temp).catch(() => {});
          throw error;
        }
      })
      .catch(() => {});
    await this.writing;
    return snapshot;
  }
}

/** 给界面读的状态快照：一次写多份镜像（DSH_HOME 与 ~/.dsh 不同时）。 */
export async function writeStatusFiles(files, payload) {
  const text = JSON.stringify(payload, null, 2);
  await Promise.all(
    files.map(async (file) => {
      try {
        await mkdir(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temp, text, 'utf8');
        await rename(temp, file);
      } catch {
        /* 快照失败不影响守卫本身 */
      }
    }),
  );
}
