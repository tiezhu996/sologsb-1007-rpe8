export type Confidence = 1 | 2 | 3 | 4 | 5;

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
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

// ---------------------------------------------------------------------------
// 追加式字段变更日志
//
// 每次校对不再整份覆盖草稿，而是追加一条 ChangeOp。每笔都带：
//   segmentId —— 作用的片段（项目级操作除外）
//   baseVersion / baseValue —— 该字段被修改前的片段版本与基线值
//   author / tabId —— 校对员与其工作副本（标签页）
// 重放日志即可重建草稿；两人分叉修改同一字段时按基线做三路合并。
// ---------------------------------------------------------------------------

/** 需要双方都改就进待合并区的字段。 */
export type ForkField = "text" | "speakerId" | "start" | "end" | "confidence";

/** 其余标量字段（reviewed、flags）同样记录字段变更，但分叉时按时间后者胜自动合并。 */
export type ScalarField = ForkField | "reviewed" | "lowConfidence" | "dialect" | "properNoun";

export interface FieldChange {
  kind: "field";
  segmentId: string;
  field: ScalarField;
  /** 修改前该片段字段操作（field/tag）累计到的版本号，原始草稿为 0。 */
  baseVersion: number;
  /** 修改前的基线值，用于三路合并。 */
  baseValue: string | number | boolean;
  value: string | number | boolean;
}

export interface TagsChange {
  kind: "tags";
  segmentId: string;
  baseVersion: number;
  baseValue: string[];
  tagIds: string[];
}

export interface CommentChange {
  kind: "comment-add" | "comment-remove" | "reply-add" | "reply-remove" | "comment-toggle";
  segmentId: string;
  commentId: string;
  replyId?: string;
  comment?: ReviewComment;
  reply?: Reply;
  /** comment-toggle 使用；true=标记解决，false=重新打开。 */
  resolved?: boolean;
}

export interface SegmentStructuralChange {
  kind: "segment-add" | "segment-remove";
  trackId: string;
  segmentId: string;
  /** segment-add 时的完整片段；插入到 afterId 之后，缺省追加到轨道末尾。 */
  segment?: Segment;
  afterId?: string;
}

export interface TrackAddChange {
  kind: "track-add";
  track: TranscriptTrack;
}

export interface TitleChange {
  kind: "title";
  title: string;
}

/** 校对员在待合并区人工选定一版后追加的裁决，只追加、不改动历史。 */
export interface ConflictResolveChange {
  kind: "conflict-resolve";
  conflictId: string;
  candidateKey: string;
}

export type ChangeOp = {
  id: string;
  tabId: string;
  author: string;
  at: number;
} & (
  | FieldChange
  | TagsChange
  | CommentChange
  | SegmentStructuralChange
  | TrackAddChange
  | TitleChange
  | ConflictResolveChange
);

/** 待合并区中同一字段分叉后的一版（来自某位校对员）。 */
export interface ConflictCandidate {
  key: string;
  tabId: string;
  author: string;
  at: number;
  value: string | number | boolean;
  /** 这一版所依据的片段字段版本。 */
  baseVersion: number;
  baseValue: string | number | boolean;
}

export interface FieldConflict {
  id: string;
  kind: "field";
  trackId: string;
  segmentId: string;
  field: ForkField;
  candidates: ConflictCandidate[];
  /** 重放时实际采用（最新一版）的候选 key；未解决冲突期间双方版本都保留。 */
  winnerKey: string;
  /** 曾经的裁决；裁决后又收到基于旧基线的修改时，冲突重开，这里保留原裁决。 */
  resolvedBy?: { candidateKey: string; author: string; at: number };
}

export interface MergeState {
  /** 尚未人工选定的字段冲突。 */
  openConflicts: FieldConflict[];
  /** 每个片段当前的字段版本（field/tag 操作各计一次）。 */
  segmentVersions: Record<string, number>;
  /** 操作总数，用于状态栏显示“版本”。 */
  opCount: number;
}

export interface ChangeEnvelope {
  schema: 2;
  tabId: string;
  savedAt: number;
  /** 建立日志时的原始草稿；日志为空时即当前草稿。 */
  baseline: ProjectData;
  ops: ChangeOp[];
}

/** 旧版整稿覆盖式信封，仅用于自动迁移。 */
export interface PersistedEnvelopeV1 {
  schema: 1;
  revision: number;
  tabId: string;
  savedAt: number;
  project: ProjectData;
}
