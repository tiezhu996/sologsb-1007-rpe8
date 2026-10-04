import { uid } from "./data";
import type {
  ChangeEnvelope,
  ChangeOp,
  ConflictCandidate,
  FieldConflict,
  ForkField,
  MergeState,
  ProjectData,
  ScalarField,
  Segment,
  TranscriptTrack,
} from "./types";

/** 两边都改就要人工选择的字段（文本、发言人、开始/结束时间、置信度）。 */
export const FORK_FIELDS: ReadonlySet<ScalarField> = new Set<ScalarField>([
  "text",
  "speakerId",
  "start",
  "end",
  "confidence",
]);

export const FIELD_LABELS: Record<ScalarField, string> = {
  text: "转写文本",
  speakerId: "发言人",
  start: "开始时间",
  end: "结束时间",
  confidence: "置信度",
  reviewed: "已校对",
  lowConfidence: "低置信标记",
  dialect: "方言标记",
  properNoun: "专名标记",
};

// ---------------------------------------------------------------------------
// 草稿结构辅助
// ---------------------------------------------------------------------------

export function findTrackBySegment(project: ProjectData, segmentId: string) {
  return project.tracks.find((track) => track.segments.some((segment) => segment.id === segmentId));
}

export function findSegment(project: ProjectData, segmentId: string): Segment | null {
  for (const track of project.tracks) {
    const found = track.segments.find((segment) => segment.id === segmentId);
    if (found) return found;
  }
  return null;
}

export function getSegmentField(segment: Segment, field: ScalarField): string | number | boolean {
  if (field === "lowConfidence" || field === "dialect" || field === "properNoun") {
    return segment.flags[field];
  }
  return segment[field];
}

export function setSegmentField(segment: Segment, field: ScalarField, value: string | number | boolean) {
  if (field === "lowConfidence" || field === "dialect" || field === "properNoun") {
    segment.flags[field] = value as boolean;
    return;
  }
  if (field === "start" || field === "end") {
    segment[field] = value as number;
  } else if (field === "confidence") {
    segment.confidence = value as Segment["confidence"];
  } else if (field === "reviewed") {
    segment.reviewed = value as boolean;
  } else if (field === "speakerId") {
    segment.speakerId = value as string;
  } else {
    segment.text = value as string;
  }
}

// ---------------------------------------------------------------------------
// 确定性重放
//
// 所有标签页看到的 ops 集合一致时，重放结果（含待合并区）必须一致，
// 因此重放只能依赖操作自带的 at/id/tabId，不能依赖到达顺序。
// ---------------------------------------------------------------------------

interface FieldMeta {
  at: number;
  tabId: string;
  author: string;
}

interface ReplayContext {
  seen: Set<string>;
  versions: Map<string, number>;
  conflicts: FieldConflict[];
  /** 当前草稿中每个片段字段的值来自哪笔操作（用于分叉时构造 trunk 候选与 LWW）。 */
  fieldMeta: Map<string, FieldMeta>;
}

const fieldMetaKey = (segmentId: string, field: ScalarField) => `${segmentId}${field}`;

function conflictId(segmentId: string, field: ForkField, baseVersion: number) {
  return `${segmentId}::${field}@${baseVersion}`;
}

function bumpVersion(ctx: ReplayContext, segmentId: string) {
  ctx.versions.set(segmentId, (ctx.versions.get(segmentId) ?? 0) + 1);
}

function latestCandidate(candidates: ConflictCandidate[]): ConflictCandidate {
  return candidates.reduce((latest, candidate) => (candidate.at > latest.at ? candidate : latest), candidates[0]);
}

function applyFieldOp(project: ProjectData, ctx: ReplayContext, op: Extract<ChangeOp, { kind: "field" }>) {
  const track = findTrackBySegment(project, op.segmentId);
  const segment = track?.segments.find((item) => item.id === op.segmentId);
  // 片段已被删除等情况下，操作只计入历史与版本号，不再影响草稿。
  if (!track || !segment) {
    bumpVersion(ctx, op.segmentId);
    return;
  }
  const currentVersion = ctx.versions.get(op.segmentId) ?? 0;
  const metaKey = fieldMetaKey(op.segmentId, op.field);
  const currentValue = getSegmentField(segment, op.field);
  const noteMeta = () => ctx.fieldMeta.set(metaKey, { at: op.at, tabId: op.tabId, author: op.author });
  const openConflictForField = () =>
    ctx.conflicts.find((item) => !item.resolvedBy && item.segmentId === op.segmentId && item.field === op.field);

  // value 等于基线值的操作不携带任何修改：只计入版本，绝不参与分叉判断，
  // 从而与操作到达顺序无关（这是 diff 引擎不会产生、但乱序重放时必须稳健处理的情形）。
  if (op.value === op.baseValue) {
    bumpVersion(ctx, op.segmentId);
    return;
  }

  // 线性快进：基线就是当前版本，直接采用。
  if (op.baseVersion >= currentVersion) {    // 该字段上已有未裁决的分叉时，新编辑并入发起方那一版而不是静默顶掉待合并区。
    const open = FORK_FIELDS.has(op.field) ? openConflictForField() : undefined;
    if (open) {
      foldIntoConflict(open, op);
      const winner = latestCandidate(open.candidates);
      open.winnerKey = winner.key;
      setSegmentField(segment, op.field, winner.value);
      ctx.fieldMeta.set(metaKey, { at: winner.at, tabId: winner.tabId, author: winner.author });
      bumpVersion(ctx, op.segmentId);
      return;
    }
    if (op.value !== currentValue) {
      setSegmentField(segment, op.field, op.value);
      noteMeta();
    }
    bumpVersion(ctx, op.segmentId);
    return;
  }

  // baseVersion < currentVersion —— 本笔基于旧版本，做字段级三路合并：
  const trunkTouchedField = currentValue !== op.baseValue;
  const branchTouchedField = op.value !== op.baseValue;

  // 分支没有改这个字段（典型：版本号因其他字段而前进，或重复收到一笔空提交）：
  // 保留当前值，也不制造冲突。必须在分叉判断之前，与到达顺序无关。
  if (!branchTouchedField) {
    bumpVersion(ctx, op.segmentId);
    return;
  }
  // 分支提交的值与 trunk 当前值一致：她已经看到并接受了另一方的修改，无需合并。
  if (op.value === currentValue) {
    noteMeta();
    bumpVersion(ctx, op.segmentId);
    return;
  }
  // 只有分支改了、trunk 没动这个字段：直接采用分支值，字段层自动合并。
  if (!trunkTouchedField) {
    setSegmentField(segment, op.field, op.value);
    noteMeta();
    bumpVersion(ctx, op.segmentId);
    return;
  }

  // 双方都改了同一字段。
  if (FORK_FIELDS.has(op.field)) {
    let conflict = ctx.conflicts.find((item) => item.id === conflictId(op.segmentId, op.field as ForkField, op.baseVersion));
    if (!conflict) {
      const trunkMeta = ctx.fieldMeta.get(metaKey);
      // 同标签页基于自己已应用的旧值再提交（不应在正常单标签页流程中出现）：
      // 视为她本人的更新，不制造只有一方的“假冲突”。
      if (trunkMeta?.tabId && trunkMeta.tabId === op.tabId && !openConflictForField()) {
        setSegmentField(segment, op.field, op.value);
        noteMeta();
        bumpVersion(ctx, op.segmentId);
        return;
      }
      // 新分叉：trunk 一版取当前草稿（另一方已应用的修改，溯源其操作人），
      // incoming 一版取本笔；双方版本都保留，等待人工选择。
      const trunk: ConflictCandidate = {
        key: `trunk@${currentVersion}`,
        tabId: trunkMeta?.tabId ?? "",
        author: trunkMeta?.author ?? "基线版本",
        at: trunkMeta?.at ?? op.at - 1,
        value: currentValue,
        baseVersion: op.baseVersion,
        baseValue: op.baseValue,
      };
      conflict = {
        id: conflictId(op.segmentId, op.field as ForkField, op.baseVersion),
        kind: "field",
        trackId: track.id,
        segmentId: op.segmentId,
        field: op.field as ForkField,
        candidates: [trunk],
        winnerKey: trunk.key,
      };
      ctx.conflicts.push(conflict);
    }
    foldIntoConflict(conflict, op);

    // 未人工裁决时重放展示最新一笔；裁决值在全部操作重放后统一落盘。
    const winner = latestCandidate(conflict.candidates);
    conflict.winnerKey = winner.key;
    setSegmentField(segment, op.field, winner.value);
    ctx.fieldMeta.set(metaKey, { at: winner.at, tabId: winner.tabId, author: winner.author });
    bumpVersion(ctx, op.segmentId);
    return;
  }

  // reviewed / flags 不属于“两边都改留两版”的字段：双方都改按操作时间后者胜（LWW），
  // 任意副本重放结果一致。
  const localMeta = ctx.fieldMeta.get(metaKey);
  if (!localMeta || op.at >= localMeta.at) {
    setSegmentField(segment, op.field, op.value);
    noteMeta();
  }
  bumpVersion(ctx, op.segmentId);
}

/**
 * 同一待合并条目：同校对员（同一标签页）的后续修改并入她那一版；
 * 第三位校对员再分叉则成为第三版。
 */
function foldIntoConflict(conflict: FieldConflict, op: Extract<ChangeOp, { kind: "field" }>) {
  const sameCandidate = conflict.candidates.find((candidate) => candidate.tabId === op.tabId && op.tabId !== "");
  if (sameCandidate) {
    sameCandidate.value = op.value;
    sameCandidate.at = op.at;
    sameCandidate.author = op.author;
    sameCandidate.baseVersion = op.baseVersion;
    sameCandidate.baseValue = op.baseValue;
  } else {
    conflict.candidates.push({
      key: op.tabId,
      tabId: op.tabId,
      author: op.author,
      at: op.at,
      value: op.value,
      baseVersion: op.baseVersion,
      baseValue: op.baseValue,
    });
  }
}

function applyTagsOp(project: ProjectData, ctx: ReplayContext, op: Extract<ChangeOp, { kind: "tags" }>) {
  const track = findTrackBySegment(project, op.segmentId);
  const segment = track?.segments.find((item) => item.id === op.segmentId);
  if (!track || !segment) {
    bumpVersion(ctx, op.segmentId);
    return;
  }
  const currentVersion = ctx.versions.get(op.segmentId) ?? 0;
  if (op.baseVersion >= currentVersion) {
    segment.tagIds = [...op.tagIds];
  } else {
    // 分叉时主题关联取并集：两位校对员各自关联的实体都保留。
    segment.tagIds = [...new Set([...segment.tagIds, ...op.tagIds])];
  }
  bumpVersion(ctx, op.segmentId);
}

type CommentOp = Extract<
  ChangeOp,
  { kind: "comment-add" | "comment-remove" | "comment-toggle" | "reply-add" | "reply-remove" }
>;

function applyCommentOp(project: ProjectData, op: CommentOp) {
  const segment = findSegment(project, op.segmentId);
  if (!segment) return;
  switch (op.kind) {
    case "comment-add":
      if (op.comment && !segment.comments.some((item) => item.id === op.commentId)) {
        // 批注按新编号追加；最新批注排在前面。
        segment.comments.unshift(structuredClone(op.comment));
      }
      break;
    case "comment-remove":
      segment.comments = segment.comments.filter((item) => item.id !== op.commentId);
      break;
    case "comment-toggle": {
      const comment = segment.comments.find((item) => item.id === op.commentId);
      if (comment) comment.resolved = op.resolved ?? comment.resolved;
      break;
    }
    case "reply-add": {
      const comment = segment.comments.find((item) => item.id === op.commentId);
      if (comment && op.reply && !comment.replies.some((reply) => reply.id === op.reply!.id)) {
        comment.replies.push(structuredClone(op.reply));
      }
      break;
    }
    case "reply-remove": {
      const comment = segment.comments.find((item) => item.id === op.commentId);
      if (comment) comment.replies = comment.replies.filter((reply) => reply.id !== op.replyId);
      break;
    }
  }
}

function applyStructuralOp(project: ProjectData, op: Extract<ChangeOp, { kind: "segment-add" | "segment-remove" }>) {
  const track = project.tracks.find((item) => item.id === op.trackId);
  if (!track) return;
  if (op.kind === "segment-add" && op.segment) {
    if (track.segments.some((item) => item.id === op.segmentId)) return;
    const at = op.afterId ? track.segments.findIndex((item) => item.id === op.afterId) : -1;
    if (at >= 0) track.segments.splice(at + 1, 0, structuredClone(op.segment));
    else track.segments.push(structuredClone(op.segment));
  } else if (op.kind === "segment-remove") {
    track.segments = track.segments.filter((item) => item.id !== op.segmentId);
  }
}

function applyResolveOp(ctx: ReplayContext, op: Extract<ChangeOp, { kind: "conflict-resolve" }>) {
  const conflict = ctx.conflicts.find((item) => item.id === op.conflictId);
  if (!conflict || conflict.resolvedBy) return;
  const chosen = conflict.candidates.find((candidate) => candidate.key === op.candidateKey);
  if (!chosen) return;
  conflict.resolvedBy = { candidateKey: chosen.key, author: op.author, at: op.at };
  conflict.winnerKey = chosen.key;
}

/**
 * 从基线与操作日志重建整份草稿，并输出待合并区。
 * 纯函数：同输入必得同输出，因此刷新/重开后待合并区可以原样恢复。
 */
export function replay(baseline: ProjectData, ops: ChangeOp[]): { project: ProjectData; merge: MergeState } {
  const project = structuredClone(baseline);
  const ctx: ReplayContext = { seen: new Set(), versions: new Map(), conflicts: [], fieldMeta: new Map() };

  const sorted = [...ops].sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.at - b.at));
  for (const op of sorted) {
    if (ctx.seen.has(op.id)) continue;
    ctx.seen.add(op.id);
    switch (op.kind) {
      case "field":
        applyFieldOp(project, ctx, op);
        break;
      case "tags":
        applyTagsOp(project, ctx, op);
        break;
      case "comment-add":
      case "comment-remove":
      case "comment-toggle":
      case "reply-add":
      case "reply-remove":
        applyCommentOp(project, op);
        break;
      case "segment-add":
      case "segment-remove":
        applyStructuralOp(project, op);
        break;
      case "track-add":
        if (!project.tracks.some((track) => track.id === op.track.id)) {
          project.tracks.push(structuredClone(op.track));
        }
        break;
      case "title":
        project.title = op.title;
        break;
      case "conflict-resolve":
        applyResolveOp(ctx, op);
        break;
    }
  }

  // 人工裁决值在全部操作重放后统一落到草稿上，
  // 保证“已经确定的那一版”和待合并区展示的是同一份事实。
  for (const conflict of ctx.conflicts) {
    if (!conflict.resolvedBy) continue;
    const chosen = conflict.candidates.find((candidate) => candidate.key === conflict.resolvedBy!.candidateKey);
    const segment = findSegment(project, conflict.segmentId);
    if (chosen && segment) {
      setSegmentField(segment, conflict.field, chosen.value);
      ctx.fieldMeta.set(fieldMetaKey(conflict.segmentId, conflict.field), {
        at: conflict.resolvedBy.at,
        tabId: chosen.tabId,
        author: conflict.resolvedBy.author,
      });
    }
  }

  const segmentVersions: Record<string, number> = {};
  for (const [id, version] of ctx.versions) segmentVersions[id] = version;
  return {
    project,
    merge: {
      openConflicts: ctx.conflicts.filter((conflict) => !conflict.resolvedBy),
      segmentVersions,
      opCount: ctx.seen.size,
    },
  };
}

// ---------------------------------------------------------------------------
// 快照 diff —— 把一次 UI 编辑转成追加式字段变更
// ---------------------------------------------------------------------------

interface OpContext {
  tabId: string;
  author: string;
  at: number;
  versions: Record<string, number>;
}

const FLAGS: (keyof Segment["flags"])[] = ["lowConfidence", "dialect", "properNoun"];
const FORK_FIELDS_LIST: ForkField[] = ["text", "speakerId", "start", "end", "confidence"];

function makeFieldOp(
  ctx: OpContext,
  segmentId: string,
  field: ScalarField,
  before: string | number | boolean,
  after: string | number | boolean,
  version: number,
): ChangeOp {
  return {
    id: uid("op"),
    kind: "field",
    tabId: ctx.tabId,
    author: ctx.author,
    at: ctx.at,
    segmentId,
    field,
    baseVersion: version,
    baseValue: before,
    value: after,
  };
}

function diffSegment(before: Segment, after: Segment, ctx: OpContext): ChangeOp[] {
  const ops: ChangeOp[] = [];
  const version = ctx.versions[before.id] ?? 0;

  for (const field of FORK_FIELDS_LIST) {
    if (getSegmentField(before, field) !== getSegmentField(after, field)) {
      ops.push(makeFieldOp(ctx, before.id, field, getSegmentField(before, field), getSegmentField(after, field), version));
    }
  }
  for (const flag of FLAGS) {
    if (before.flags[flag] !== after.flags[flag]) {
      ops.push(makeFieldOp(ctx, before.id, flag, before.flags[flag], after.flags[flag], version));
    }
  }
  if (before.reviewed !== after.reviewed) {
    ops.push(makeFieldOp(ctx, before.id, "reviewed", before.reviewed, after.reviewed, version));
  }

  if (before.tagIds.join("") !== after.tagIds.join("")) {
    // 主题关联：完整集合也以字段变更形式记录，分叉时在重放层取并集。
    ops.push({
      id: uid("op"),
      kind: "tags",
      tabId: ctx.tabId,
      author: ctx.author,
      at: ctx.at,
      segmentId: before.id,
      baseVersion: version,
      baseValue: [...before.tagIds],
      tagIds: [...after.tagIds],
    });
  }

  // 批注按新编号追加：每条批注/回复都是独立追加操作，不会覆盖对方的批注。
  for (const comment of after.comments) {
    const oldComment = before.comments.find((item) => item.id === comment.id);
    if (!oldComment) {
      ops.push({
        id: uid("op"),
        kind: "comment-add",
        tabId: ctx.tabId,
        author: ctx.author,
        at: ctx.at,
        segmentId: before.id,
        commentId: comment.id,
        comment: structuredClone(comment),
      });
      continue;
    }
    if (oldComment.resolved !== comment.resolved) {
      ops.push({
        id: uid("op"),
        kind: "comment-toggle",
        tabId: ctx.tabId,
        author: ctx.author,
        at: ctx.at,
        segmentId: before.id,
        commentId: comment.id,
        resolved: comment.resolved,
      });
    }
    for (const reply of comment.replies) {
      if (!oldComment.replies.some((item) => item.id === reply.id)) {
        ops.push({
          id: uid("op"),
          kind: "reply-add",
          tabId: ctx.tabId,
          author: ctx.author,
          at: ctx.at,
          segmentId: before.id,
          commentId: comment.id,
          reply: structuredClone(reply),
        });
      }
    }
    for (const oldReply of oldComment.replies) {
      if (!comment.replies.some((item) => item.id === oldReply.id)) {
        ops.push({
          id: uid("op"),
          kind: "reply-remove",
          tabId: ctx.tabId,
          author: ctx.author,
          at: ctx.at,
          segmentId: before.id,
          commentId: comment.id,
          replyId: oldReply.id,
        });
      }
    }
  }
  for (const oldComment of before.comments) {
    if (!after.comments.some((item) => item.id === oldComment.id)) {
      ops.push({
        id: uid("op"),
        kind: "comment-remove",
        tabId: ctx.tabId,
        author: ctx.author,
        at: ctx.at,
        segmentId: before.id,
        commentId: oldComment.id,
      });
    }
  }

  return ops;
}

/** 比较编辑前后的整份快照，输出追加式变更。版本号以编辑前的重放状态为准。 */
export function diffProjects(before: ProjectData, after: ProjectData, ctx: OpContext): ChangeOp[] {
  const ops: ChangeOp[] = [];

  if (before.title !== after.title) {
    ops.push({ id: uid("op"), kind: "title", tabId: ctx.tabId, author: ctx.author, at: ctx.at, title: after.title });
  }

  for (const afterTrack of after.tracks) {
    const beforeTrack = before.tracks.find((track) => track.id === afterTrack.id);
    if (!beforeTrack) {
      ops.push({ id: uid("op"), kind: "track-add", tabId: ctx.tabId, author: ctx.author, at: ctx.at, track: structuredClone(afterTrack) });
      continue;
    }
    for (const afterSegment of afterTrack.segments) {
      const beforeSegment = beforeTrack.segments.find((item) => item.id === afterSegment.id);
      if (!beforeSegment) {
        // 拆分/导入产生的新片段：完整片段随结构操作追加，内容即操作人提交的值。
        const index = afterTrack.segments.findIndex((item) => item.id === afterSegment.id);
        ops.push({
          id: uid("op"),
          kind: "segment-add",
          tabId: ctx.tabId,
          author: ctx.author,
          at: ctx.at,
          trackId: afterTrack.id,
          segmentId: afterSegment.id,
          segment: structuredClone(afterSegment),
          afterId: index > 0 ? afterTrack.segments[index - 1].id : undefined,
        });
      } else {
        ops.push(...diffSegment(beforeSegment, afterSegment, ctx));
      }
    }
    for (const beforeSegment of beforeTrack.segments) {
      if (!afterTrack.segments.some((item) => item.id === beforeSegment.id)) {
        ops.push({
          id: uid("op"),
          kind: "segment-remove",
          tabId: ctx.tabId,
          author: ctx.author,
          at: ctx.at,
          trackId: afterTrack.id,
          segmentId: beforeSegment.id,
        });
      }
    }
  }

  return ops;
}

// ---------------------------------------------------------------------------
// 撤销/重做的逆变更裁剪
//
// 撤销时要从“当前快照”回到本页过去的快照，但当前快照可能已经合并进另一位
// 校对员的无关修改。逆变更只允许触碰本次操作原来改过的字段/批注/片段，
// 避免一次撤销顺手回退掉对方的工作。
// ---------------------------------------------------------------------------

function opScopeKey(op: ChangeOp): string {
  switch (op.kind) {
    case "field":
      return `field:${op.segmentId}:${op.field}`;
    case "tags":
      return `tags:${op.segmentId}`;
    case "comment-add":
    case "comment-remove":
    case "comment-toggle":
      return `comment:${op.segmentId}:${op.commentId}`;
    case "reply-add":
    case "reply-remove":
      return `reply:${op.segmentId}:${op.commentId}:${op.replyId ?? ""}`;
    case "segment-add":
    case "segment-remove":
      return `segment:${op.segmentId}`;
    case "track-add":
      return `track:${op.track.id}`;
    case "title":
      return "title";
    case "conflict-resolve":
      return `resolve:${op.conflictId}`;
  }
}

/** 从候选逆变更中挑出落在原操作范围内的部分。 */
export function scopeOpsTo(original: ChangeOp[], candidates: ChangeOp[]): ChangeOp[] {
  const allowed = new Set(original.map(opScopeKey));
  return candidates.filter((op) => allowed.has(opScopeKey(op)));
}

// ---------------------------------------------------------------------------
// 日志合并
// ---------------------------------------------------------------------------

export function mergeOps(existing: ChangeOp[], incoming: ChangeOp[]): ChangeOp[] {
  const byId = new Map<string, ChangeOp>();
  for (const op of existing) byId.set(op.id, op);
  for (const op of incoming) if (!byId.has(op.id)) byId.set(op.id, op);
  return [...byId.values()];
}

export function mergeEnvelopes(current: ChangeEnvelope | null, incoming: ChangeEnvelope): ChangeEnvelope {
  if (!current || current.baseline.id !== incoming.baseline.id) {
    return structuredClone(incoming);
  }
  return {
    schema: 2,
    tabId: incoming.tabId,
    savedAt: incoming.savedAt,
    baseline: current.baseline,
    ops: mergeOps(current.ops, incoming.ops),
  };
}

/** 人工选择待合并区的一版，返回要追加的裁决操作。 */
export function createResolveOp(
  conflict: FieldConflict,
  candidateKey: string,
  ctx: Pick<OpContext, "tabId" | "author" | "at">,
): ChangeOp {
  return {
    id: uid("op"),
    kind: "conflict-resolve",
    tabId: ctx.tabId,
    author: ctx.author,
    at: ctx.at,
    conflictId: conflict.id,
    candidateKey,
  };
}

/** 导出字幕时判断片段是否还有未定字段：有则该片段不属于“已经确定的那一版”。 */
export function segmentHasOpenConflict(merge: MergeState, segmentId: string) {
  return merge.openConflicts.some((conflict) => conflict.segmentId === segmentId);
}

export function openConflictsOfSegment(merge: MergeState, segmentId: string) {
  return merge.openConflicts.filter((conflict) => conflict.segmentId === segmentId);
}

export function trackTitle(track: TranscriptTrack | undefined) {
  return track?.name ?? "";
}
