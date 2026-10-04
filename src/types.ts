export type Confidence = 1 | 2 | 3 | 4 | 5;

export interface Reply {
  id: string;
  /** 创建方分配的原始编号；跨标签页合并重新编号后仍可用它定位回复。 */
  originId?: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  /** 创建方分配的原始编号；合并进来的批注会按新编号追加，但保留 originId 以便回复/解决操作定位。 */
  originId?: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

export interface Speaker {
  id: string;
  name: string;
  role: string;
  color: string;
}

export interface Tag {
  id: string;
  label: string;
  type: "topic" | "event" | "person";
  color: string;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  speakerId: string;
  text: string;
  confidence: Confidence;
  reviewed: boolean;
  flags: {
    lowConfidence: boolean;
    dialect: boolean;
    properNoun: boolean;
  };
  tagIds: string[];
  comments: ReviewComment[];
}

export interface TranscriptTrack {
  id: string;
  name: string;
  language: string;
  status: "待校对" | "校对中" | "已完成";
  segments: Segment[];
}

export interface ProjectData {
  id: string;
  title: string;
  interviewee: string;
  recordingDate: string;
  activeTrackId: string;
  speakers: Speaker[];
  tags: Tag[];
  tracks: TranscriptTrack[];
  updatedAt: string;
}

export interface PersistedEnvelope {
  schema: 1;
  revision: number;
  tabId: string;
  savedAt: number;
  /** 快照已折叠到的操作日志长度；加载时从该位置继续重放。 */
  opCursor: number;
  project: ProjectData;
}

/** 双方同时修改时需要人工选择的字段。 */
export type ConflictField = "text" | "speakerId" | "start" | "end" | "confidence";

export type OpField =
  | ConflictField
  | "title"
  | "reviewed"
  | "lowConfidence"
  | "dialect"
  | "properNoun"
  | "tags"
  | "comment.add"
  | "comment.remove"
  | "comment.resolved"
  | "reply.add"
  | "reply.remove"
  | "segment.add"
  | "segment.remove"
  | "track.add"
  | "resolve";

/** 追加式字段变更：整份草稿的协作真源，逐笔追加到共享操作日志。 */
export interface FieldOp {
  id: string;
  tabId: string;
  /** 校对员 */
  author: string;
  /** 基线版本：创建该变更时已见到的操作日志长度，用于判定并发修改。 */
  baseRevision: number;
  createdAt: string;
  trackId: string;
  segmentId: string;
  field: OpField;
  value: unknown;
  /** 变更前的字段值（冲突时作为基线版本展示与回退）。 */
  baseValue?: unknown;
}

export interface ConflictSide {
  tabId: string;
  author: string;
  value: unknown;
  at: string;
}

/** 待合并区条目：同一字段的两个版本，等待人工选择。 */
export interface PendingConflict {
  id: string;
  trackId: string;
  segmentId: string;
  field: ConflictField;
  baselineValue: unknown;
  sides: ConflictSide[];
  createdAt: string;
}
