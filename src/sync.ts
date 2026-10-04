import { uid } from "./data";
import type {
  ConflictField,
  FieldOp,
  OpField,
  PendingConflict,
  ProjectData,
  Reply,
  ReviewComment,
  Segment,
  TranscriptTrack,
} from "./types";

export const OPS_KEY = "sologsb-1007-ops-v1";
export const PENDING_KEY = "sologsb-1007-pending-v1";
export const PROOFREADER_KEY = "sologsb-1007-proofreader";

export const CONFLICT_FIELDS: ConflictField[] = ["text", "speakerId", "start", "end", "confidence"];

export const opKey = (trackId: string, segmentId: string, field: string) => `${trackId}/${segmentId}/${field}`;
export const pendingKeyOf = (conflict: PendingConflict) => opKey(conflict.trackId, conflict.segmentId, conflict.field);

// ---------- 本地存储 ----------

export function readOps(): FieldOp[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(OPS_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as FieldOp[]) : [];
  } catch {
    return [];
  }
}

/**
 * 追加操作到共享日志。localStorage 没有原子追加，采用读-改-写后校验，
 * 若发现本批操作被其他标签页覆盖则合并重试；storage 事件会兜底对齐。
 */
export function appendToLog(ops: FieldOp[]): FieldOp[] {
  if (typeof localStorage === "undefined" || ops.length === 0) return readOps();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const log = readOps();
    const known = new Set(log.map((op) => op.id));
    const merged = [...log, ...ops.filter((op) => !known.has(op.id))];
    localStorage.setItem(OPS_KEY, JSON.stringify(merged));
    const verify = readOps();
    const ids = new Set(verify.map((op) => op.id));
    if (ops.every((op) => ids.has(op.id))) return verify;
  }
  return readOps();
}

export function loadPending(): PendingConflict[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as PendingConflict[]) : [];
  } catch {
    return [];
  }
}

export function savePending(conflicts: PendingConflict[]) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PENDING_KEY, JSON.stringify(conflicts));
}

export function loadProofreader(): string {
  if (typeof localStorage === "undefined") return "校对员";
  const existing = localStorage.getItem(PROOFREADER_KEY);
  if (existing) return existing;
  const generated = `校对员-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  localStorage.setItem(PROOFREADER_KEY, generated);
  return generated;
}

export function saveProofreader(name: string) {
  if (typeof localStorage === "undefined") return;
  const trimmed = name.trim();
  if (trimmed) localStorage.setItem(PROOFREADER_KEY, trimmed);
}

// ---------- 查询与标量读写 ----------

export function findSegment(state: ProjectData, trackId: string, segmentId: string): Segment | undefined {
  return state.tracks.find((track) => track.id === trackId)?.segments.find((segment) => segment.id === segmentId);
}

function getScalar(state: ProjectData, trackId: string, segmentId: string, field: ConflictField): unknown {
  const segment = findSegment(state, trackId, segmentId);
  if (!segment) return undefined;
  switch (field) {
    case "text": return segment.text;
    case "speakerId": return segment.speakerId;
    case "start": return segment.start;
    case "end": return segment.end;
    case "confidence": return segment.confidence;
  }
}

function setScalar(state: ProjectData, trackId: string, segmentId: string, field: ConflictField, value: unknown) {
  const segment = findSegment(state, trackId, segmentId);
  if (!segment) return;
  switch (field) {
    case "text": segment.text = String(value ?? ""); break;
    case "speakerId": segment.speakerId = String(value ?? ""); break;
    case "start": segment.start = Number(value) || 0; break;
    case "end": segment.end = Number(value) || 0; break;
    case "confidence": segment.confidence = (Number(value) || 3) as Segment["confidence"]; break;
  }
}

// ---------- 状态差异 → 字段操作 ----------

export interface DiffMeta {
  tabId: string;
  author: string;
  /** 基线版本：当前已见到的操作日志长度。 */
  baseRevision: number;
}

/** 把一次本地状态迁移拆成追加式字段变更，每笔带片段、基线版本和校对员。 */
export function diffProjects(prev: ProjectData, next: ProjectData, meta: DiffMeta): FieldOp[] {
  const ops: FieldOp[] = [];
  const emit = (trackId: string, segmentId: string, field: OpField, value: unknown, baseValue?: unknown) => {
    ops.push({
      id: uid("op"),
      tabId: meta.tabId,
      author: meta.author,
      baseRevision: meta.baseRevision,
      createdAt: new Date().toISOString(),
      trackId,
      segmentId,
      field,
      value,
      ...(baseValue !== undefined ? { baseValue } : {}),
    });
  };

  if (prev.title !== next.title) emit("", "", "title", next.title, prev.title);

  for (const nextTrack of next.tracks) {
    const prevTrack = prev.tracks.find((track) => track.id === nextTrack.id);
    if (!prevTrack) {
      emit(nextTrack.id, "", "track.add", nextTrack);
      continue;
    }
    for (const prevSegment of prevTrack.segments) {
      if (!nextTrack.segments.some((segment) => segment.id === prevSegment.id)) {
        emit(nextTrack.id, prevSegment.id, "segment.remove", { segmentId: prevSegment.id });
      }
    }
    nextTrack.segments.forEach((nextSegment, segmentIndex) => {
      const prevSegment = prevTrack.segments.find((segment) => segment.id === nextSegment.id);
      if (!prevSegment) {
        emit(nextTrack.id, nextSegment.id, "segment.add", {
          afterId: nextTrack.segments[segmentIndex - 1]?.id ?? null,
          segment: nextSegment,
        });
        return;
      }
      const id = nextSegment.id;
      if (prevSegment.text !== nextSegment.text) emit(nextTrack.id, id, "text", nextSegment.text, prevSegment.text);
      if (prevSegment.speakerId !== nextSegment.speakerId) emit(nextTrack.id, id, "speakerId", nextSegment.speakerId, prevSegment.speakerId);
      if (prevSegment.start !== nextSegment.start) emit(nextTrack.id, id, "start", nextSegment.start, prevSegment.start);
      if (prevSegment.end !== nextSegment.end) emit(nextTrack.id, id, "end", nextSegment.end, prevSegment.end);
      if (prevSegment.confidence !== nextSegment.confidence) emit(nextTrack.id, id, "confidence", nextSegment.confidence, prevSegment.confidence);
      if (prevSegment.reviewed !== nextSegment.reviewed) emit(nextTrack.id, id, "reviewed", nextSegment.reviewed);
      for (const flag of ["lowConfidence", "dialect", "properNoun"] as const) {
        if (prevSegment.flags[flag] !== nextSegment.flags[flag]) emit(nextTrack.id, id, flag, nextSegment.flags[flag]);
      }
      const add = nextSegment.tagIds.filter((tagId) => !prevSegment.tagIds.includes(tagId));
      const remove = prevSegment.tagIds.filter((tagId) => !nextSegment.tagIds.includes(tagId));
      if (add.length || remove.length) emit(nextTrack.id, id, "tags", { add, remove });
      for (const prevComment of prevSegment.comments) {
        if (!nextSegment.comments.some((comment) => comment.id === prevComment.id)) {
          emit(nextTrack.id, id, "comment.remove", { commentId: prevComment.originId ?? prevComment.id });
        }
      }
      for (const nextComment of nextSegment.comments) {
        const commentKey = nextComment.originId ?? nextComment.id;
        const prevComment = prevSegment.comments.find((comment) => comment.id === nextComment.id);
        if (!prevComment) {
          emit(nextTrack.id, id, "comment.add", { ...nextComment, originId: commentKey, replies: [] });
          for (const reply of nextComment.replies) emit(nextTrack.id, id, "reply.add", { commentId: commentKey, reply });
          continue;
        }
        if (prevComment.resolved !== nextComment.resolved) {
          emit(nextTrack.id, id, "comment.resolved", { commentId: commentKey, resolved: nextComment.resolved });
        }
        for (const reply of nextComment.replies) {
          if (!prevComment.replies.some((item) => item.id === reply.id)) {
            emit(nextTrack.id, id, "reply.add", { commentId: commentKey, reply });
          }
        }
        for (const prevReply of prevComment.replies) {
          if (!nextComment.replies.some((reply) => reply.id === prevReply.id)) {
            emit(nextTrack.id, id, "reply.remove", { commentId: commentKey, replyId: prevReply.originId ?? prevReply.id });
          }
        }
      }
    });
  }
  return ops;
}

// ---------- 字段级合并引擎 ----------

interface LastOpInfo {
  index: number;
  tabId: string;
  author: string;
  at: string;
  value: unknown;
  baseValue: unknown;
}

/**
 * 把操作日志逐笔折叠到项目状态。文本、发言人、时间、置信度四个字段
 * 若两侧基于同一基线并发修改，则两版都进入待合并区，状态回退到基线值；
 * 批注按新编号追加，主题关联取并集，其余标量按日志顺序覆盖。
 */
export class MergeEngine {
  readonly pending = new Map<string, PendingConflict>();
  private lastOpByKey = new Map<string, LastOpInfo>();
  private tagAdds = new Map<string, { index: number; tabId: string }>();

  constructor(conflicts: PendingConflict[] = []) {
    for (const conflict of conflicts) this.pending.set(pendingKeyOf(conflict), conflict);
  }

  /** 不重放状态，只把日志前缀的簿记信息（最后写入者、主题关联时间）补齐。 */
  prime(ops: FieldOp[], offset = 0) {
    ops.forEach((op, index) => this.noteOp(op, offset + index));
  }

  apply(state: ProjectData, op: FieldOp, index: number) {
    if ((CONFLICT_FIELDS as string[]).includes(op.field)) {
      this.applyConflictScalar(state, op, index);
      return;
    }
    this.applyPlain(state, op);
    this.noteOp(op, index);
  }

  private applyConflictScalar(state: ProjectData, op: FieldOp, index: number) {
    const field = op.field as ConflictField;
    const key = opKey(op.trackId, op.segmentId, field);
    const existing = this.pending.get(key);
    if (existing) {
      const side = existing.sides.find((item) => item.tabId === op.tabId);
      if (side) {
        side.value = op.value;
        side.at = op.createdAt;
        side.author = op.author;
      } else {
        existing.sides.push({ tabId: op.tabId, author: op.author, value: op.value, at: op.createdAt });
      }
      return;
    }
    const last = this.lastOpByKey.get(key);
    if (last && last.tabId !== op.tabId && op.baseRevision <= last.index) {
      // 双方基于同一基线版本并发修改同一字段：两版都进待合并区，状态回到基线。
      const baseline = last.baseValue !== undefined
        ? last.baseValue
        : op.baseValue !== undefined
          ? op.baseValue
          : getScalar(state, op.trackId, op.segmentId, field);
      this.pending.set(key, {
        id: `pc-${key}`,
        trackId: op.trackId,
        segmentId: op.segmentId,
        field,
        baselineValue: baseline,
        sides: [
          { tabId: last.tabId, author: last.author, value: last.value, at: last.at },
          { tabId: op.tabId, author: op.author, value: op.value, at: op.createdAt },
        ],
        createdAt: new Date().toISOString(),
      });
      setScalar(state, op.trackId, op.segmentId, field, baseline);
      return;
    }
    setScalar(state, op.trackId, op.segmentId, field, op.value);
    this.lastOpByKey.set(key, {
      index,
      tabId: op.tabId,
      author: op.author,
      at: op.createdAt,
      value: op.value,
      baseValue: op.baseValue,
    });
  }

  private applyPlain(state: ProjectData, op: FieldOp) {
    switch (op.field) {
      case "resolve": {
        const target = op.value as { field: ConflictField; value: unknown };
        this.pending.delete(opKey(op.trackId, op.segmentId, target.field));
        setScalar(state, op.trackId, op.segmentId, target.field, target.value);
        return;
      }
      case "title":
        state.title = String(op.value ?? "");
        return;
      case "reviewed": {
        const segment = findSegment(state, op.trackId, op.segmentId);
        if (segment) segment.reviewed = Boolean(op.value);
        return;
      }
      case "lowConfidence":
      case "dialect":
      case "properNoun": {
        const segment = findSegment(state, op.trackId, op.segmentId);
        if (segment) segment.flags[op.field] = Boolean(op.value);
        return;
      }
      case "tags": {
        const segment = findSegment(state, op.trackId, op.segmentId);
        if (!segment) return;
        const { add = [], remove = [] } = (op.value ?? {}) as { add?: string[]; remove?: string[] };
        // 主题关联取并集：只有删除方当时已经见到的关联才允许被移除，
        // 另一侧并发的关联保留下来。
        const removable = new Set(remove.filter((tagId) => {
          const added = this.tagAdds.get(`${op.segmentId}/${tagId}`);
          return !added || added.index < op.baseRevision || added.tabId === op.tabId;
        }));
        segment.tagIds = [...new Set([...segment.tagIds.filter((tagId) => !removable.has(tagId)), ...add])];
        return;
      }
      case "comment.add": {
        const segment = findSegment(state, op.trackId, op.segmentId);
        if (!segment) return;
        const payload = op.value as ReviewComment;
        const originId = payload.originId ?? payload.id;
        if (segment.comments.some((comment) => (comment.originId ?? comment.id) === originId)) return;
        // 批注按新编号追加，originId 保留创建方编号供回复/解决操作定位。
        segment.comments.push({
          ...payload,
          id: uid("comment"),
          originId,
          replies: (payload.replies ?? []).map((reply) => ({ ...reply, id: uid("reply"), originId: reply.originId ?? reply.id })),
        });
        return;
      }
      case "comment.remove": {
        const segment = findSegment(state, op.trackId, op.segmentId);
        if (!segment) return;
        const { commentId } = op.value as { commentId: string };
        segment.comments = segment.comments.filter((comment) => (comment.originId ?? comment.id) !== commentId);
        return;
      }
      case "comment.resolved": {
        const { commentId, resolved } = op.value as { commentId: string; resolved: boolean };
        const comment = findSegment(state, op.trackId, op.segmentId)?.comments.find(
          (item) => (item.originId ?? item.id) === commentId,
        );
        if (comment) comment.resolved = Boolean(resolved);
        return;
      }
      case "reply.add": {
        const { commentId, reply } = op.value as { commentId: string; reply: Reply };
        const comment = findSegment(state, op.trackId, op.segmentId)?.comments.find(
          (item) => (item.originId ?? item.id) === commentId,
        );
        if (!comment) return;
        const originId = reply.originId ?? reply.id;
        if (comment.replies.some((item) => (item.originId ?? item.id) === originId)) return;
        comment.replies.push({ ...reply, id: uid("reply"), originId });
        return;
      }
      case "reply.remove": {
        const { commentId, replyId } = op.value as { commentId: string; replyId: string };
        const comment = findSegment(state, op.trackId, op.segmentId)?.comments.find(
          (item) => (item.originId ?? item.id) === commentId,
        );
        if (comment) comment.replies = comment.replies.filter((reply) => (reply.originId ?? reply.id) !== replyId);
        return;
      }
      case "segment.add": {
        const track = state.tracks.find((item) => item.id === op.trackId);
        if (!track) return;
        const { afterId, segment } = op.value as { afterId: string | null; segment: Segment };
        if (track.segments.some((item) => item.id === segment.id)) return;
        const cloned = structuredClone(segment);
        cloned.comments = (cloned.comments ?? []).map((comment) => ({
          ...comment,
          originId: comment.originId ?? comment.id,
          replies: (comment.replies ?? []).map((reply) => ({ ...reply, originId: reply.originId ?? reply.id })),
        }));
        const at = afterId ? track.segments.findIndex((item) => item.id === afterId) : -1;
        if (at >= 0) track.segments.splice(at + 1, 0, cloned);
        else track.segments.push(cloned);
        return;
      }
      case "segment.remove": {
        const track = state.tracks.find((item) => item.id === op.trackId);
        if (!track) return;
        const { segmentId } = op.value as { segmentId: string };
        track.segments = track.segments.filter((segment) => segment.id !== segmentId);
        return;
      }
      case "track.add": {
        const track = op.value as TranscriptTrack;
        if (state.tracks.some((item) => item.id === track.id)) return;
        state.tracks.push(structuredClone(track));
        return;
      }
    }
  }

  private noteOp(op: FieldOp, index: number) {
    if (op.field === "resolve") {
      const target = op.value as { field: ConflictField; value: unknown };
      this.lastOpByKey.set(opKey(op.trackId, op.segmentId, target.field), {
        index,
        tabId: op.tabId,
        author: op.author,
        at: op.createdAt,
        value: target.value,
        baseValue: undefined,
      });
      return;
    }
    if (op.field === "tags") {
      const { add = [] } = (op.value ?? {}) as { add?: string[] };
      for (const tagId of add) this.tagAdds.set(`${op.segmentId}/${tagId}`, { index, tabId: op.tabId });
      return;
    }
    if (op.field === "segment.add") {
      const { segment } = op.value as { segment: Segment };
      for (const tagId of segment.tagIds ?? []) this.tagAdds.set(`${segment.id}/${tagId}`, { index, tabId: op.tabId });
      return;
    }
    if (op.field === "track.add") {
      const track = op.value as TranscriptTrack;
      for (const segment of track.segments ?? []) {
        for (const tagId of segment.tagIds ?? []) this.tagAdds.set(`${segment.id}/${tagId}`, { index, tabId: op.tabId });
      }
    }
  }
}
