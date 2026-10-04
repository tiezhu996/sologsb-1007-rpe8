import { createSeedProject } from "./data";
import { mergeEnvelopes } from "./sync";
import type { ChangeEnvelope, PersistedEnvelopeV1, ProjectData } from "./types";

export const STORAGE_KEY = "sologsb-1007-project-v2";
export const LEGACY_STORAGE_KEY = "sologsb-1007-project-v1";
export const SESSION_KEY = "sologsb-1007-session";
export const PROOFREADER_KEY = "sologsb-1007-proofreader";

function readRawEnvelope(): ChangeEnvelope | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as ChangeEnvelope;
    if (parsed?.schema === 2 && parsed.baseline?.tracks?.length) return parsed;
  } catch {
    // Malformed envelope: fall through to migration/seed.
  }
  return null;
}

function migrateV1(): ChangeEnvelope | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? "") as PersistedEnvelopeV1;
    if (parsed?.schema === 1 && parsed.project?.tracks?.length) {
      const envelope: ChangeEnvelope = {
        schema: 2,
        tabId: parsed.tabId ?? "legacy",
        savedAt: parsed.savedAt ?? Date.now(),
        baseline: parsed.project,
        ops: [],
      };
      persistEnvelope(envelope);
      return envelope;
    }
  } catch {
    // Ignore unreadable legacy draft.
  }
  return null;
}

/**
 * 载入追加式草稿：v2 日志优先；旧的 v1 整稿快照自动迁移为“基线 + 空日志”。
 */
export function loadEnvelope(): ChangeEnvelope {
  const existing = readRawEnvelope();
  if (existing) return existing;
  const migrated = migrateV1();
  if (migrated) return migrated;
  return {
    schema: 2,
    tabId: "seed",
    savedAt: Date.now(),
    baseline: createSeedProject(),
    ops: [],
  };
}

/** 直接写入信封（迁移等场景）。 */
export function persistEnvelope(envelope: ChangeEnvelope) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
}

/**
 * 追加式保存：以操作 id 与本机已有的日志并集，绝不整份覆盖对方操作。
 * 基线在所有标签页之间共享同一份（来自初次建稿/迁移）。
 */
export function saveEnvelope(envelope: ChangeEnvelope): ChangeEnvelope {
  if (typeof localStorage === "undefined") return envelope;
  const current = readRawEnvelope();
  const merged = mergeEnvelopes(current, envelope);
  persistEnvelope(merged);
  return merged;
}

export function readEnvelope(): ChangeEnvelope | null {
  return readRawEnvelope();
}

export function loadProofreaderName(fallback: string) {
  if (typeof localStorage === "undefined") return fallback;
  return localStorage.getItem(PROOFREADER_KEY)?.trim() || fallback;
}

export function saveProofreaderName(name: string) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PROOFREADER_KEY, name);
}

export function downloadText(filename: string, content: string, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function formatTime(seconds: number, withMillis = true) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  const head = [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
  return withMillis ? `${head}.${String(ms).padStart(3, "0")}` : head;
}

export function parseTime(value: string) {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(normalized) || 0;
}

export type { ProjectData };
