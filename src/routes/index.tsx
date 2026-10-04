import { Checkbox } from "@kobalte/core/checkbox";
import { Dialog } from "@kobalte/core/dialog";
import { Tabs } from "@kobalte/core/tabs";
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { uid } from "../data";
import {
  downloadText,
  formatTime,
  loadEnvelope,
  loadProofreaderName,
  parseTime,
  persistEnvelope,
  readEnvelope,
  saveEnvelope,
  saveProofreaderName,
} from "../persistence";
import {
  FIELD_LABELS,
  createResolveOp,
  diffProjects,
  findSegment,
  mergeOps,
  openConflictsOfSegment,
  replay,
  scopeOpsTo,
  segmentHasOpenConflict,
} from "../sync";
import type {
  ChangeEnvelope,
  ChangeOp,
  Confidence,
  FieldConflict,
  MergeState,
  ProjectData,
  Segment,
  TranscriptTrack,
} from "../types";

const CHANNEL_NAME = "sologsb-1007-editor-v2";
const TAB_ID = uid("tab");
const DEFAULT_PROOFREADER = `校对员-${TAB_ID.slice(-4)}`;

function statusText(status: "saved" | "saving" | "offline") {
  if (status === "saving") return "正在保存变更";
  if (status === "offline") return "离线草稿（恢复联网后字段合并）";
  return "已自动保存（追加式）";
}

function parseTimedTranscript(input: string, trackName: string): TranscriptTrack {
  const blocks = input.trim().split(/\n\s*\n/);
  const segments: Segment[] = [];
  const srtPattern = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
  const bracketPattern = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*(.*)$/;

  const build = (start: number, end: number, text: string): Segment => {
    const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
    return {
      id: uid("seg"),
      start,
      end,
      speakerId: speakerName ? "sp-custom" : "sp-interviewer",
      text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
      confidence: 3,
      reviewed: false,
      flags: { lowConfidence: false, dialect: false, properNoun: false },
      tagIds: [],
      comments: [],
    };
  };

  for (const rawBlock of blocks) {
    const lines = rawBlock.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const srtIndex = lines.findIndex((line) => srtPattern.test(line));
    if (srtIndex >= 0) {
      const match = srtPattern.exec(lines[srtIndex]);
      const text = lines.slice(srtIndex + 1).join(" ");
      segments.push(build(parseTime(match?.[1] ?? "0"), parseTime(match?.[2] ?? "1"), text));
      continue;
    }
    for (const line of lines) {
      const match = bracketPattern.exec(line);
      if (!match) continue;
      const start = parseTime(match[1]);
      const text = match[2];
      segments.push(build(start, start + Math.max(3, text.length / 5), text));
    }
  }

  if (!segments.length && input.trim()) {
    input.split("\n").map((line) => line.trim()).filter(Boolean).forEach((text, index) => {
      segments.push(build(index * 6, index * 6 + 5.4, text));
    });
  }

  return {
    id: uid("track"),
    name: trackName || "导入轨",
    language: "待识别",
    status: "待校对",
    segments,
  };
}

interface UndoEntry {
  /** 撤销目标：应用 undoOps 后回到的快照。 */
  snapshot: ProjectData;
  /** 本次编辑产生的操作；撤销时追加它们的逆操作。 */
  redoOps: ChangeOp[];
  versions: Record<string, number>;
  selectedId: string;
}

export default function OralHistoryEditor() {
  const initialEnvelope = loadEnvelope();
  const initial = replay(initialEnvelope.baseline, initialEnvelope.ops);
  const [baseline] = createSignal<ProjectData>(initialEnvelope.baseline);
  const [ops, setOps] = createSignal<ChangeOp[]>(initialEnvelope.ops);
  const [project, setProject] = createSignal<ProjectData>(initial.project);
  const [merge, setMerge] = createSignal<MergeState>(initial.merge);
  const [past, setPast] = createSignal<UndoEntry[]>([]);
  const [future, setFuture] = createSignal<{ snapshot: ProjectData; undoOps: ChangeOp[]; versions: Record<string, number> }[]>([]);
  const [activeTrackId, setActiveTrackId] = createSignal(initial.project.activeTrackId);
  const [selectedId, setSelectedId] = createSignal(initial.project.tracks[0]?.segments[0]?.id ?? "");
  const [saveStatus, setSaveStatus] = createSignal<"saved" | "saving" | "offline">("saved");
  const [lastAction, setLastAction] = createSignal("草稿已按追加式变更载入");
  const [online, setOnline] = createSignal(true);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [pendingOpen, setPendingOpen] = createSignal(false);
  const [exportConfirmOpen, setExportConfirmOpen] = createSignal(false);
  const [proofreader, setProofreader] = createSignal(loadProofreaderName(DEFAULT_PROOFREADER));
  const [commentDraft, setCommentDraft] = createSignal("");
  const [replyDrafts, setReplyDrafts] = createSignal<Record<string, string>>({});
  const [trackFilter, setTrackFilter] = createSignal<"all" | "unreviewed" | "low">("all");
  const [notice, setNotice] = createSignal<{ kind: "merged" | "conflict"; text: string } | null>(null);
  let editorRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let proofreaderRef: HTMLInputElement | undefined;
  let saveTimer: number | undefined;
  let noticeTimer: number | undefined;
  let hydrated = false;

  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;
  const activeTrack = createMemo(() => {
    const data = project();
    return data.tracks.find((track) => track.id === activeTrackId()) ?? data.tracks[0];
  });
  const activeSegment = createMemo(() => activeTrack()?.segments.find((item) => item.id === selectedId()) ?? null);
  const visibleSegments = createMemo(() => {
    const segments = activeTrack()?.segments ?? [];
    if (trackFilter() === "unreviewed") return segments.filter((segment) => !segment.reviewed);
    if (trackFilter() === "low") return segments.filter((segment) => segment.confidence <= 2 || segment.flags.lowConfidence);
    return segments;
  });
  const completedPercent = createMemo(() => {
    const segments = project().tracks.flatMap((track) => track.segments);
    if (!segments.length) return 0;
    return Math.round((segments.filter((segment) => segment.reviewed).length / segments.length) * 100);
  });
  const speakerById = (speakerId: string) =>
    project().speakers.find((speaker) => speaker.id === speakerId) ?? project().speakers[0];
  const tagById = (tagId: string) => project().tags.find((tag) => tag.id === tagId);

  const flashNotice = (kind: "merged" | "conflict", text: string) => {
    setNotice({ kind, text });
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => setNotice(null), 6000);
  };

  /**
   * 一次 UI 编辑的统一入口：
   * 不再整份覆盖草稿，而是对编辑前后快照做字段级 diff，把变更追加进日志；
   * 每笔都带片段、基线版本与校对员。撤销栈保存快照与对应操作。
   */
  const commit = (label: string, mutate: (draft: ProjectData) => void) => {
    const before = project();
    const beforeVersions = merge().segmentVersions;
    const beforeSelected = selectedId();
    const next = structuredClone(before);
    mutate(next);
    next.updatedAt = new Date().toISOString();
    const newOps = diffProjects(before, next, {
      tabId: TAB_ID,
      author: proofreader(),
      at: Date.now(),
      versions: beforeVersions,
    });
    const allOps = mergeOps(ops(), newOps);
    const replayed = replay(baseline(), allOps);
    batch(() => {
      setPast((items) => [...items.slice(-49), { snapshot: before, redoOps: newOps, versions: beforeVersions, selectedId: beforeSelected }]);
      setFuture([]);
      setOps(allOps);
      setProject(replayed.project);
      setMerge(replayed.merge);
      setLastAction(label);
    });

    if (replayed.merge.openConflicts.length > merge().openConflicts.length) {
      flashNotice("conflict", "恢复的变更与本页在同一字段上分叉，已留两版放进待合并区。");
    }
  };

  const commitSegment = (label: string, mutate: (segment: Segment, draft: ProjectData) => void) => {
    const id = selectedId();
    commit(label, (draft) => {
      const segment = findSegment(draft, id);
      if (segment) mutate(segment, draft);
    });
  };

  /** 撤销不是删除历史，而是向追加日志再补一笔“改回去”的字段变更。 */
  const undo = () => {
    const stack = past();
    if (!stack.length) return;
    const entry = stack[stack.length - 1];
    const current = project();
    const targetSnapshot = entry.snapshot;
    const allUndoOps = diffProjects(current, targetSnapshot, {
      tabId: TAB_ID,
      author: proofreader(),
      at: Date.now(),
      versions: merge().segmentVersions,
    });
    // 只回退本步触碰过的字段；期间合入的对方修改不受影响。
    const undoOps = scopeOpsTo(entry.redoOps, allUndoOps);
    const allOps = mergeOps(ops(), undoOps);
    const replayed = replay(baseline(), allOps);
    batch(() => {
      setFuture((items) => [{ snapshot: current, undoOps: entry.redoOps, versions: merge().segmentVersions }, ...items].slice(0, 50));
      setPast(stack.slice(0, -1));
      setOps(allOps);
      setProject(replayed.project);
      setMerge(replayed.merge);
      setSelectedId(entry.selectedId);
      setLastAction("已撤销上一步（以追加变更记录）");
    });

  };

  const redo = () => {
    const stack = future();
    if (!stack.length) return;
    const head = stack[0];
    const targetSnapshot = head.snapshot;
    const allRedoOps = diffProjects(project(), targetSnapshot, {
      tabId: TAB_ID,
      author: proofreader(),
      at: Date.now(),
      versions: merge().segmentVersions,
    });
    // 重做也只恢复本步范围，避免把期间合入的对方修改带回去。
    const redoOps = scopeOpsTo(head.undoOps, allRedoOps);
    const allOps = mergeOps(ops(), redoOps);
    const replayed = replay(baseline(), allOps);
    batch(() => {
      setPast((items) => [
        ...items.slice(-49),
        { snapshot: project(), redoOps: head.undoOps, versions: head.versions, selectedId: selectedId() },
      ]);
      setFuture(stack.slice(1));
      setOps(allOps);
      setProject(replayed.project);
      setMerge(replayed.merge);
      setLastAction("已重做（以追加变更记录）");
    });

  };

  const switchTrack = (trackId: string) => {
    setActiveTrackId(trackId);
    const first = project().tracks.find((track) => track.id === trackId)?.segments[0]?.id ?? "";
    setSelectedId(first);
  };

  const moveSelection = (direction: 1 | -1) => {
    const segments = activeTrack()?.segments ?? [];
    if (!segments.length) return;
    const index = Math.max(0, segments.findIndex((segment) => segment.id === selectedId()));
    const nextIndex = (index + direction + segments.length) % segments.length;
    setSelectedId(segments[nextIndex].id);
    document.getElementById(`segment-${segments[nextIndex].id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const splitSelection = () => {
    const segment = activeSegment();
    if (!segment || segment.text.trim().length < 2) return;
    const cursor = editorRef?.selectionStart ?? Math.floor(segment.text.length / 2);
    const safeCursor = Math.max(1, Math.min(cursor, segment.text.length - 1));
    const firstText = segment.text.slice(0, safeCursor).trim();
    const secondText = segment.text.slice(safeCursor).trim();
    if (!firstText || !secondText) return;
    const ratio = firstText.length / segment.text.length;
    const boundary = segment.start + (segment.end - segment.start) * ratio;
    const secondId = uid("seg");
    commitSegment("拆分片段", (current, draft) => {
      const track = draft.tracks.find((item) => item.id === activeTrackId());
      current.text = firstText;
      current.end = Number(boundary.toFixed(1));
      const segmentIndex = track?.segments.findIndex((item) => item.id === current.id) ?? -1;
      if (track && segmentIndex >= 0) {
        track.segments.splice(segmentIndex + 1, 0, {
          ...structuredClone(current),
          id: secondId,
          start: Number(boundary.toFixed(1)),
          text: secondText,
          reviewed: false,
          comments: [],
          tagIds: [],
        });
      }
      setSelectedId(secondId);
    });
  };

  const mergeWithNext = () => {
    const track = activeTrack();
    const segment = activeSegment();
    if (!track || !segment) return;
    const index = track.segments.findIndex((item) => item.id === segment.id);
    const next = track.segments[index + 1];
    if (!next) return;
    commitSegment("合并下一片段", (current, draft) => {
      current.text = `${current.text.trim()} ${next.text.trim()}`;
      current.end = next.end;
      current.tagIds = [...new Set([...current.tagIds, ...next.tagIds])];
      current.comments.push(...structuredClone(next.comments));
      current.confidence = Math.min(current.confidence, next.confidence) as Confidence;
      const sourceTrack = draft.tracks.find((item) => item.id === activeTrackId());
      if (sourceTrack) sourceTrack.segments = sourceTrack.segments.filter((item) => item.id !== next.id);
      current.reviewed = false;
    });
  };

  const toggleFlag = (flag: keyof Segment["flags"]) => {
    commitSegment("修改校对标记", (segment) => {
      segment.flags[flag] = !segment.flags[flag];
      segment.reviewed = false;
    });
  };

  const setConfidence = (confidence: Confidence) => {
    commitSegment("校正置信度", (segment) => {
      segment.confidence = confidence;
      segment.flags.lowConfidence = confidence <= 2;
      segment.reviewed = false;
    });
  };

  const addComment = () => {
    const body = commentDraft().trim();
    if (!body) return;
    commitSegment("追加批注", (segment) => {
      segment.comments.unshift({
        id: uid("comment"),
        author: proofreader(),
        body,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      });
      segment.reviewed = false;
    });
    setCommentDraft("");
  };

  const addReply = (commentId: string) => {
    const body = (replyDrafts()[commentId] ?? "").trim();
    if (!body) return;
    commitSegment("追加批注回复", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      comment?.replies.push({
        id: uid("reply"),
        author: proofreader(),
        body,
        createdAt: new Date().toISOString(),
      });
    });
    setReplyDrafts((drafts) => ({ ...drafts, [commentId]: "" }));
  };

  const toggleComment = (commentId: string) => {
    commitSegment("更新批注状态", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      if (comment) comment.resolved = !comment.resolved;
    });
  };

  const toggleTag = (tagId: string) => {
    commitSegment("更新主题关联", (segment) => {
      segment.tagIds = segment.tagIds.includes(tagId)
        ? segment.tagIds.filter((id) => id !== tagId)
        : [...segment.tagIds, tagId];
      segment.reviewed = false;
    });
  };

  // -- 待合并区：人工从两版中选定一版（裁决本身也是一条追加操作）--------------

  const resolveConflict = (conflict: FieldConflict, candidateKey: string) => {
    const resolveOp = createResolveOp(conflict, candidateKey, {
      tabId: TAB_ID,
      author: proofreader(),
      at: Date.now(),
    });
    const allOps = mergeOps(ops(), [resolveOp]);
    const replayed = replay(baseline(), allOps);
    batch(() => {
      setOps(allOps);
      setProject(replayed.project);
      setMerge(replayed.merge);
      setLastAction("已在待合并区选定一版");
    });

  };

  /** 合并失败后从日志恢复双方变更：直接重放当前日志（双方操作都还在）。 */
  const restoreFromLog = () => {
    const replayed = replay(baseline(), ops());
    batch(() => {
      setProject(replayed.project);
      setMerge(replayed.merge);
      setLastAction("已从待合并区恢复双方变更");
    });
  };

  // -- 字幕导出：只用已经确定（没有未解决冲突）的那一版 ------------------------

  const exportableSegments = (track: TranscriptTrack) =>
    track.segments.filter((segment) => !segmentHasOpenConflict(merge(), segment.id));

  const runExport = () => {
    const track = activeTrack();
    const lines = exportableSegments(track).map((segment, index) => {
      const speaker = speakerById(segment.speakerId)?.name ?? "未知";
      return `${index + 1}\n${formatTime(segment.start)} --> ${formatTime(segment.end)}\n${speaker}：${segment.text}\n`;
    });
    downloadText(`${project().title}-${track.name}-已定稿.srt`, lines.join("\n"), "application/x-subrip;charset=utf-8");
    setExportConfirmOpen(false);
  };

  const exportSrt = () => {
    const blocked = activeTrack().segments.filter((segment) => segmentHasOpenConflict(merge(), segment.id));
    if (blocked.length) {
      setExportConfirmOpen(true);
      return;
    }
    runExport();
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    const imported = parseTimedTranscript(text, file.name.replace(/\.[^.]+$/, ""));
    if (!imported.segments.length) {
      setLastAction("未识别到带时间码的文本");
      return;
    }
    commit("导入转写文本", (draft) => {
      draft.tracks.push(imported);
      setActiveTrackId(imported.id);
      setSelectedId(imported.segments[0].id);
    });
  };

  // -- 多标签页：只在字段层合并，绝不整稿覆盖 --------------------------------

  const ingestEnvelope = (incoming: ChangeEnvelope, announce: boolean) => {
    if (incoming.schema !== 2 || incoming.baseline.id !== baseline().id) return;
    const mergedOps = mergeOps(ops(), incoming.ops);
    if (mergedOps.length === ops().length) return;
    const replayed = replay(baseline(), mergedOps);
    const beforeConflictCount = merge().openConflicts.length;
    batch(() => {
      setOps(mergedOps);
      setProject(replayed.project);
      setMerge(replayed.merge);
      if (replayed.project.tracks.every((track) => track.id !== activeTrackId())) {
        setActiveTrackId(replayed.project.tracks[0]?.id ?? "");
      }
      if (!findSegment(replayed.project, selectedId())) {
        setSelectedId(activeTrack()?.segments[0]?.id ?? "");
      }
    });
    if (announce) {
      const newCount = replayed.merge.openConflicts.length - beforeConflictCount;
      if (newCount > 0) {
        flashNotice("conflict", `对方恢复联网后的字段变更已合并；${newCount} 个字段两边都改过，已留两版待人工选择。`);
      } else {
        flashNotice("merged", "已在字段层合并对方变更，未覆盖本页修改。");
      }
      setLastAction("已合并其他校对员的追加变更");
    }
    // 合并结果立即落盘：所有标签页都以“操作并集”收敛，保存失败也不丢任何一方。
    const envelope: ChangeEnvelope = {
      schema: 2,
      tabId: TAB_ID,
      savedAt: Date.now(),
      baseline: baseline(),
      ops: mergedOps,
    };
    persistEnvelope(envelope);
  };

  const flushSave = (announce = false) => {
    const envelope: ChangeEnvelope = {
      schema: 2,
      tabId: TAB_ID,
      savedAt: Date.now(),
      baseline: baseline(),
      ops: ops(),
    };
    // 离线时只写本地日志；恢复联网后 handleOnline 再做字段合并。
    const merged = saveEnvelope(envelope);
    if (merged.ops.length !== ops().length) {
      // 本地存储里已有其他标签页的操作（例如另一标签页先写入）：顺手并入。
      ingestEnvelope(merged, announce);
    }
    channel?.postMessage(envelope);

  };

  onMount(() => {
    hydrated = true;
    const handleOnline = () => {
      setOnline(true);
      // 恢复联网：拉取本机其他标签页写下的日志，只在字段层合并。
      const stored = readEnvelope();
      if (stored) ingestEnvelope(stored, true);
      flushSave(true);
    };
    const handleOffline = () => setOnline(false);
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "sologsb-1007-project-v2" || !event.newValue) return;
      try {
        const incoming = JSON.parse(event.newValue) as ChangeEnvelope;
        if (incoming.tabId !== TAB_ID) ingestEnvelope(incoming, online());
      } catch {
        // Ignore malformed storage events.
      }
    };
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches("input, textarea, select, [contenteditable='true']");
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        flushSave();
        setSaveStatus("saved");
        setLastAction("已把追加变更写入本地日志");
        return;
      }
      if (editing) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(-1);
      } else if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        mergeWithNext();
      } else if (event.key.toLowerCase() === "r" && activeSegment()) {
        event.preventDefault();
        commitSegment("标记片段已校对", (segment) => { segment.reviewed = true; });
      } else if (event.key === "?" || (event.shiftKey && event.key === "/")) {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("storage", handleStorage);
    window.addEventListener("keydown", handleKeydown);
    setOnline(navigator.onLine);
    onCleanup(() => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("keydown", handleKeydown);
    });
  });

  channel?.addEventListener("message", (event: MessageEvent<ChangeEnvelope>) => {
    const incoming = event.data;
    if (incoming.tabId !== TAB_ID) ingestEnvelope(incoming, online());
  });

  createEffect(() => {
    // 跟踪日志与草稿变化，触发防抖保存。
    ops();
    project();
    if (!hydrated) return;
    setSaveStatus(online() ? "saving" : "offline");
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      flushSave();
      setSaveStatus(online() ? "saved" : "offline");
    }, 420);
  });

  onCleanup(() => {
    window.clearTimeout(saveTimer);
    window.clearTimeout(noticeTimer);
    channel?.close();
  });

  const clickSegment = (id: string) => {
    setSelectedId(id);
    queueMicrotask(() => editorRef?.focus());
  };

  const commitProofreaderName = () => {
    const name = proofreaderRef?.value.trim() || DEFAULT_PROOFREADER;
    setProofreader(name);
    saveProofreaderName(name);
  };

  const candidateDisplay = (conflict: FieldConflict, value: string | number | boolean) => {
    if (conflict.field === "speakerId") return speakerById(String(value))?.name ?? String(value);
    if (conflict.field === "start" || conflict.field === "end") return formatTime(Number(value));
    if (conflict.field === "confidence") return `${value} / 5`;
    return String(value);
  };

  const segmentConflictCount = (segmentId: string) => openConflictsOfSegment(merge(), segmentId).length;

  return (
    <div class="app-shell">
      <Show when={notice()}>
        {(item) => (
          <div class={`merge-banner ${item().kind}`} role="status">
            <span>{item().kind === "conflict" ? "⚠" : "✓"}</span>
            <strong>{item().text}</strong>
            {item().kind === "conflict" ? (
              <button class="btn btn-quiet" onClick={() => setPendingOpen(true)}>打开待合并区（{merge().openConflicts.length}）</button>
            ) : null}
          </div>
        )}
      </Show>

      <header class="topbar">
        <div class="brand-mark" aria-hidden="true"><span>口述</span><b>1007</b></div>
        <div class="project-heading">
          <input
            aria-label="项目标题"
            value={project().title}
            onChange={(event) => commit("修改项目标题", (draft) => { draft.title = event.currentTarget.value; })}
          />
          <div class="project-meta">
            <span>{project().interviewee}</span>
            <span>{project().recordingDate}</span>
            <span class={`save-state ${saveStatus()}`}>{statusText(saveStatus())}</span>
          </div>
        </div>
        <div class="top-actions">
          <label class="proofreader-field" title="校对员姓名会随每笔字段变更一起保存">
            校对员
            <input
              ref={proofreaderRef}
              value={proofreader()}
              onChange={commitProofreaderName}
              onBlur={commitProofreaderName}
            />
          </label>
          <button class="pending-btn" classList={{ active: merge().openConflicts.length > 0 }} onClick={() => setPendingOpen(true)}>
            待合并 {merge().openConflicts.length > 0 ? `(${merge().openConflicts.length})` : ""}
          </button>
          <span class={`network-chip ${online() ? "online" : "offline"}`}>{online() ? "在线" : "离线可编辑"}</span>
          <button class="icon-btn" title="撤销 Ctrl/Cmd+Z" disabled={!past().length} onClick={undo}>↶</button>
          <button class="icon-btn" title="重做 Ctrl/Cmd+Shift+Z" disabled={!future().length} onClick={redo}>↷</button>
          <button class="btn btn-quiet" onClick={() => setHelpOpen(true)}>快捷键 <kbd>?</kbd></button>
          <button class="btn btn-primary" onClick={exportSrt}>导出 SRT</button>
        </div>
      </header>

      <div class="workspace">
        <aside class="left-panel">
          <section class="panel-section overview-card">
            <div class="eyebrow">校对进度</div>
            <div class="progress-row">
              <strong>{completedPercent()}%</strong>
              <span>{project().tracks.flatMap((track) => track.segments).filter((segment) => segment.reviewed).length} / {project().tracks.flatMap((track) => track.segments).length} 片段</span>
            </div>
            <div class="progress-track"><i style={{ width: `${completedPercent()}%` }} /></div>
            <p>修改以追加式字段变更保存，每笔带片段、基线版本和校对员；断网期间继续编辑，恢复联网后只在字段层合并。</p>
          </section>

          <section class="panel-section">
            <div class="section-title"><h2>文本轨道</h2><span>{project().tracks.length}</span></div>
            <div class="track-list">
              <For each={project().tracks}>
                {(track) => (
                  <button class={`track-card ${track.id === activeTrackId() ? "active" : ""}`} onClick={() => switchTrack(track.id)}>
                    <span class="track-icon">{track.language === "English" ? "EN" : track.language === "福州话转写" ? "方" : "普"}</span>
                    <span class="track-info"><strong>{track.name}</strong><small>{track.segments.length} 段 · {track.status}</small></span>
                    <span class="track-dot" style={{ background: track.status === "已完成" ? "#15803d" : track.status === "校对中" ? "#d97706" : "#94a3b8" }} />
                  </button>
                )}
              </For>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".srt,.txt,.vtt"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importFile(file);
                event.currentTarget.value = "";
              }}
            />
            <button class="wide-action" onClick={() => fileInputRef?.click()}><span>＋</span> 导入带时间码文本</button>
            <div class="hint">支持 SRT / VTT / 每行 `[00:12] 文本`</div>
          </section>

          <section class="panel-section tag-summary">
            <div class="section-title"><h2>标注实体</h2><span>{project().tags.length}</span></div>
            <div class="legend">
              <span><i style={{ background: "#2563eb" }} />主题</span>
              <span><i style={{ background: "#b45309" }} />事件</span>
              <span><i style={{ background: "#be185d" }} />人物</span>
            </div>
            <p>主题关联分叉时自动取并集；文本、发言人、时间、置信度两边都改则留两版进待合并区。</p>
          </section>
        </aside>

        <main class="transcript-panel">
          <div class="panel-toolbar">
            <div>
              <div class="eyebrow">当前轨道</div>
              <h1>{activeTrack()?.name}</h1>
            </div>
            <div class="filters" role="group" aria-label="片段筛选">
              <button class={trackFilter() === "all" ? "active" : ""} onClick={() => setTrackFilter("all")}>全部</button>
              <button class={trackFilter() === "unreviewed" ? "active" : ""} onClick={() => setTrackFilter("unreviewed")}>未校对</button>
              <button class={trackFilter() === "low" ? "active" : ""} onClick={() => setTrackFilter("low")}>低置信</button>
            </div>
          </div>

          <div class="transcript-list" role="listbox" aria-label="转写片段">
            <For each={visibleSegments()}>
              {(segment, index) => (
                <article
                  id={`segment-${segment.id}`}
                  role="option"
                  aria-selected={segment.id === selectedId()}
                  class={`segment-card ${segment.id === selectedId() ? "selected" : ""} ${segment.reviewed ? "reviewed" : ""} ${segmentHasOpenConflict(merge(), segment.id) ? "conflicted" : ""}`}
                  onClick={() => clickSegment(segment.id)}
                >
                  <div class="segment-rail" style={{ background: speakerById(segment.speakerId)?.color ?? "#64748b" }} />
                  <div class="segment-time">
                    <span>{formatTime(segment.start, false)}</span>
                    <small>{formatTime(segment.end, false)}</small>
                  </div>
                  <div class="segment-body">
                    <div class="segment-meta">
                      <b>{speakerById(segment.speakerId)?.name ?? "未知发言人"}</b>
                      <span class={`confidence c${segment.confidence}`}>置信 {segment.confidence}/5</span>
                      <Show when={segmentHasOpenConflict(merge(), segment.id)}>
                        <button
                          class="pill conflict"
                          onClick={(event) => { event.stopPropagation(); setSelectedId(segment.id); setPendingOpen(true); }}
                        >待合并 ×{segmentConflictCount(segment.id)}</button>
                      </Show>
                      <Show when={segment.flags.lowConfidence}><span class="pill alert">低置信</span></Show>
                      <Show when={segment.flags.dialect}><span class="pill dialect">方言</span></Show>
                      <Show when={segment.flags.properNoun}><span class="pill proper">专名</span></Show>
                      <Show when={segment.reviewed}><span class="pill done">✓ 已校对</span></Show>
                    </div>
                    <p>{segment.text}</p>
                    <div class="segment-tags">
                      <For each={segment.tagIds.map(tagById).filter(Boolean)}>
                        {(tag) => <span style={{ "--tag-color": tag!.color } as any}>#{tag!.label}</span>}
                      </For>
                    </div>
                  </div>
                  <span class="segment-index">{index() + 1}</span>
                </article>
              )}
            </For>
            <Show when={!visibleSegments().length}>
              <div class="empty-state"><b>没有符合筛选条件的片段</b><span>切换到“全部”继续校对。</span></div>
            </Show>
          </div>
        </main>

        <aside class="inspector">
          <Show when={activeSegment()} fallback={<div class="empty-inspector"><b>选择一个片段</b><p>在中间列表点击片段后即可校正发言人、置信度、标记和批注。</p></div>}>
            {(segment) => (
              <Tabs defaultValue="correct" class="inspector-tabs">
                <Tabs.List class="tab-list">
                  <Tabs.Trigger value="correct">校对</Tabs.Trigger>
                  <Tabs.Trigger value="annotate">标注</Tabs.Trigger>
                  <Tabs.Trigger value="comments">批注 <span>{segment().comments.length}</span></Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="correct" class="tab-content">
                  <div class="inspector-heading">
                    <div><span>片段 {(activeTrack()?.segments.findIndex((item) => item.id === segment().id) ?? -1) + 1} · 字段基线 v{merge().segmentVersions[segment().id] ?? 0}</span><strong>{formatTime(segment().start, false)} — {formatTime(segment().end, false)}</strong></div>
                    <button class={`review-button ${segment().reviewed ? "done" : ""}`} onClick={() => commitSegment("标记片段已校对", (item) => { item.reviewed = true; })}>
                      {segment().reviewed ? "✓ 已校对" : "标记已校对"}
                    </button>
                  </div>

                  <Show when={openConflictsOfSegment(merge(), segment().id).length}>
                    <div class="inline-conflicts">
                      <strong>⚠ {openConflictsOfSegment(merge(), segment().id).length} 个字段两边都改过，尚未选定</strong>
                      <For each={openConflictsOfSegment(merge(), segment().id)}>
                        {(conflict) => (
                          <div class="inline-conflict-row">
                            <span>{FIELD_LABELS[conflict.field]}</span>
                            <button onClick={() => setPendingOpen(true)}>去选择</button>
                          </div>
                        )}
                      </For>
                      <small>当前显示最新一版，仅供参考；字幕导出会跳过这些字段未定的片段。</small>
                    </div>
                  </Show>

                  <label class="field-label" for="speaker-select">发言人</label>
                  <select
                    id="speaker-select"
                    value={segment().speakerId}
                    onChange={(event) => commitSegment("校正发言人", (item) => { item.speakerId = event.currentTarget.value; item.reviewed = false; })}
                  >
                    <For each={project().speakers}>{(speaker) => <option value={speaker.id}>{speaker.name} · {speaker.role}</option>}</For>
                  </select>

                  <div class="time-grid">
                    <label>开始<input type="text" value={formatTime(segment().start)} onChange={(event) => commitSegment("修改开始时间", (item) => { item.start = parseTime(event.currentTarget.value); })} /></label>
                    <label>结束<input type="text" value={formatTime(segment().end)} onChange={(event) => commitSegment("修改结束时间", (item) => { item.end = parseTime(event.currentTarget.value); })} /></label>
                  </div>

                  <label class="field-label" for="transcript-editor">转写文本</label>
                  <textarea
                    id="transcript-editor"
                    ref={editorRef}
                    rows="7"
                    value={segment().text}
                    onChange={(event) => commitSegment("校正转写文本", (item) => { item.text = event.currentTarget.value; item.reviewed = false; })}
                  />
                  <div class="textarea-help">光标停在句中后点击“拆分”，系统会保留两侧时间码比例。</div>

                  <div class="field-label">置信度</div>
                  <div class="confidence-picker" role="radiogroup" aria-label="置信度">
                    <For each={[1, 2, 3, 4, 5] as Confidence[]}>
                      {(value) => <button class={segment().confidence === value ? "active" : ""} onClick={() => setConfidence(value)}>{value}</button>}
                    </For>
                  </div>

                  <div class="field-label">校对标记</div>
                  <div class="flag-list">
                    <Checkbox checked={segment().flags.lowConfidence} onChange={() => toggleFlag("lowConfidence")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>低置信词或句</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.dialect} onChange={() => toggleFlag("dialect")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>方言表达</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.properNoun} onChange={() => toggleFlag("properNoun")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>专有名词</Checkbox.Label>
                    </Checkbox>
                  </div>

                  <div class="split-actions">
                    <button onClick={splitSelection}>⌁ 按光标拆分</button>
                    <button disabled={activeTrack()?.segments.at(-1)?.id === segment().id} onClick={mergeWithNext}>合并下一段</button>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="annotate" class="tab-content">
                  <div class="content-title"><h3>关联主题、事件与人物</h3><p>分叉时两边的关联自动取并集，不会互相取消；复核后颜色会显示在列表中。</p></div>
                  <For each={project().tags}>
                    {(tag) => (
                      <button class={`tag-option ${segment().tagIds.includes(tag.id) ? "selected" : ""}`} onClick={() => toggleTag(tag.id)}>
                        <i style={{ background: tag.color }} />
                        <span><strong>#{tag.label}</strong><small>{tag.type === "topic" ? "主题" : tag.type === "event" ? "事件" : "人物"}</small></span>
                        <b>{segment().tagIds.includes(tag.id) ? "✓" : "＋"}</b>
                      </button>
                    )}
                  </For>
                </Tabs.Content>

                <Tabs.Content value="comments" class="tab-content comments-content">
                  <div class="content-title"><h3>批注与回复</h3><p>批注以新编号追加，两位校对员的批注并存，不互相覆盖。</p></div>
                  <div class="comment-compose">
                    <textarea rows="3" placeholder="记录读音、词义或专名依据…" value={commentDraft()} onInput={(event) => setCommentDraft(event.currentTarget.value)} />
                    <button class="btn btn-primary" onClick={addComment}>添加批注</button>
                  </div>
                  <For each={segment().comments} fallback={<div class="mini-empty">当前片段还没有批注。</div>}>
                    {(comment) => (
                      <article class={`comment-card ${comment.resolved ? "resolved" : ""}`}>
                        <header><strong>{comment.author}</strong><time>{new Date(comment.createdAt).toLocaleString()}</time></header>
                        <p>{comment.body}</p>
                        <For each={comment.replies}>
                          {(reply) => <div class="reply"><b>{reply.author}</b><span>{reply.body}</span></div>}
                        </For>
                        <div class="reply-row">
                          <input
                            value={replyDrafts()[comment.id] ?? ""}
                            placeholder="回复…"
                            onInput={(event) => setReplyDrafts((drafts) => ({ ...drafts, [comment.id]: event.currentTarget.value }))}
                            onKeyDown={(event) => { if (event.key === "Enter") addReply(comment.id); }}
                          />
                          <button onClick={() => addReply(comment.id)}>回复</button>
                        </div>
                        <button class="resolve-link" onClick={() => toggleComment(comment.id)}>{comment.resolved ? "重新打开" : "标记已解决"}</button>
                      </article>
                    )}
                  </For>
                </Tabs.Content>
              </Tabs>
            )}
          </Show>
        </aside>
      </div>

      <footer class="statusbar">
        <span>最近操作：{lastAction()}</span>
        <span>变更 {merge().opCount} 笔 · 追加式日志 · 基线版本 v0</span>
        <span class="status-shortcuts">J/K 浏览　R 已校对　M 合并　? 帮助</span>
      </footer>

      {/* 待合并区：刷新/重开后仍从日志恢复，可继续逐个人工选择 */}
      <Dialog open={pendingOpen()} onOpenChange={setPendingOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content pending-dialog">
            <Dialog.Title>待合并区</Dialog.Title>
            <Dialog.Description>
              两位校对员离线期间改了同一字段，双方版本都已保留。逐条选定一版后，字幕导出才会使用该片段。
            </Dialog.Description>
            <div class="pending-list">
              <For each={merge().openConflicts} fallback={<div class="mini-empty">没有待人工选择的分叉；字段层合并已自动完成。</div>}>
                {(conflict) => {
                  const track = project().tracks.find((item) => item.id === conflict.trackId);
                  const seg = findSegment(project(), conflict.segmentId);
                  const index = track?.segments.findIndex((item) => item.id === conflict.segmentId) ?? -1;
                  return (
                    <article class="pending-item">
                      <header>
                        <div>
                          <strong>{FIELD_LABELS[conflict.field]} 分叉</strong>
                          <small>{track?.name} · 片段 {index + 1} · 基于字段基线 v{conflict.candidates[0]?.baseVersion ?? 0}</small>
                        </div>
                        <button
                          class="locate-link"
                          onClick={() => {
                            if (track) setActiveTrackId(track.id);
                            setSelectedId(conflict.segmentId);
                            setPendingOpen(false);
                            document.getElementById(`segment-${conflict.segmentId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
                          }}
                        >定位片段</button>
                      </header>
                      <Show when={seg}><p class="pending-context">原文上下文：{seg!.text.slice(0, 48)}{seg!.text.length > 48 ? "…" : ""}</p></Show>
                      <div class="candidate-list">
                        <For each={conflict.candidates}>
                          {(candidate) => (
                            <button
                              class="candidate-card"
                              classList={{ winning: candidate.key === conflict.winnerKey }}
                              onClick={() => resolveConflict(conflict, candidate.key)}
                              title="选定这一版（裁决会以追加变更保存）"
                            >
                              <div class="candidate-meta">
                                <b>{candidate.author}</b>
                                <span>{new Date(candidate.at).toLocaleString()}</span>
                                {candidate.key === conflict.winnerKey ? <em>当前显示版</em> : null}
                              </div>
                              <p>{candidateDisplay(conflict, candidate.value)}</p>
                              <span class="choose-link">采用这一版</span>
                            </button>
                          )}
                        </For>
                      </div>
                    </article>
                  );
                }}
              </For>
            </div>
            <div class="pending-footer">
              <button class="btn btn-quiet" onClick={restoreFromLog} title="合并失败后，从追加日志重新恢复双方变更">从日志恢复双方变更</button>
              <button class="btn btn-primary" onClick={() => setPendingOpen(false)}>稍后继续选择</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      {/* 导出确认：只导出已经确定的那一版 */}
      <Dialog open={exportConfirmOpen()} onOpenChange={setExportConfirmOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content small-dialog">
            <Dialog.Title>存在未定稿片段</Dialog.Title>
            <Dialog.Description as="div">
              <p>
                当前轨道有{" "}
                {activeTrack()?.segments.filter((item) => segmentHasOpenConflict(merge(), item.id)).length ?? 0}{" "}
                个片段还在待合并区。字幕导出只会使用已经确定的那一版，未定片段将从 SRT 中跳过。
              </p>
            </Dialog.Description>
            <div class="dialog-footer" style={{ gap: "8px" }}>
              <button class="btn btn-quiet" onClick={() => { setExportConfirmOpen(false); setPendingOpen(true); }}>先去待合并区选择</button>
              <button class="btn btn-primary" onClick={runExport}>只导出已定稿片段</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      <Dialog open={helpOpen()} onOpenChange={setHelpOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content">
            <Dialog.Title>键盘校对</Dialog.Title>
            <Dialog.Description>光标在输入框中时，单键快捷键不会抢占文字输入。撤销/重做同样以追加变更保存，不会覆盖另一位校对员的操作。</Dialog.Description>
            <div class="shortcut-grid">
              <span><kbd>J</kbd><kbd>↓</kbd> 下一片段</span>
              <span><kbd>K</kbd><kbd>↑</kbd> 上一片段</span>
              <span><kbd>R</kbd> 标记已校对</span>
              <span><kbd>M</kbd> 合并下一片段</span>
              <span><kbd>Ctrl/⌘ Z</kbd> 撤销（追加逆变更）</span>
              <span><kbd>Ctrl/⌘ ⇧ Z</kbd> 重做</span>
              <span><kbd>Ctrl/⌘ S</kbd> 立即保存</span>
              <span><kbd>?</kbd> 显示本帮助</span>
            </div>
            <div class="dialog-footer"><button class="btn btn-primary" onClick={() => setHelpOpen(false)}>开始校对</button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </div>
  );
}
