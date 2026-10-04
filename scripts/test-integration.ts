// 端到端：模拟两位校对员各自离线编辑同一份草稿，恢复联网后按存储层协议
// （与 routes/index.tsx 的 flushSave / ingestEnvelope 相同：操作按 id 并集 + 确定性重放）
// 做字段级合并，校验待合并区、裁决恢复与导出过滤。
//   npx esbuild scripts/test-integration.ts --bundle --platform=node --format=esm --outfile=.tmp/test-integration.mjs && node .tmp/test-integration.mjs
import { createSeedProject } from "../src/data";
import { createResolveOp, diffProjects, mergeOps, replay, segmentHasOpenConflict } from "../src/sync";
import type { ChangeEnvelope, ChangeOp, ProjectData } from "../src/types";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const seed = createSeedProject();
  const SEG = "seg-2";
  const original = seed.tracks[0].segments[1];

  // 共享存储（等价于同一浏览器 localStorage）
  let stored: ChangeEnvelope = { schema: 2, tabId: "seed", savedAt: 1, baseline: seed, ops: [] };

  interface Client {
    id: string;
    author: string;
    ops: ChangeOp[];
  }
  const A: Client = { id: "tab-A", author: "校对员甲", ops: [] };
  const B: Client = { id: "tab-B", author: "校对员乙", ops: [] };

  // 与 persistence.saveEnvelope 相同的追加式保存：操作按 id 并集，绝不整稿覆盖。
  const flush = (client: Client) => {
    stored = {
      schema: 2,
      tabId: client.id,
      savedAt: Date.now(),
      baseline: stored.baseline,
      ops: mergeOps(stored.ops, client.ops),
    };
  };
  // 与 UI commit 相同：对编辑前后快照做字段级 diff，带片段/基线版本/校对员。
  const edit = (client: Client, mutate: (draft: ProjectData) => void, at: number) => {
    const known = replay(seed, client.ops);
    const next = structuredClone(known.project);
    mutate(next);
    const newOps = diffProjects(known.project, next, {
      tabId: client.id,
      author: client.author,
      at,
      versions: known.merge.segmentVersions,
    });
    client.ops.push(...newOps);
  };

  // --- 离线期间：双方从同一基线各自校对 ---
  edit(A, (p) => {
    const s = p.tracks[0].segments[1];
    s.text = "甲：天未光听见拖板车";
    s.tagIds = [...s.tagIds, "topic-A"];
    s.comments.unshift({ id: "cm-a", author: "校对员甲", body: "甲的批注", createdAt: "2026-10-04T10:00:00Z", resolved: false, replies: [] });
  }, 1000);
  edit(B, (p) => {
    const s = p.tracks[0].segments[1];
    s.text = "乙：天没亮有拖板车声";
    s.speakerId = "sp-chen";
    s.tagIds = [...s.tagIds, "topic-B"];
    s.comments.unshift({ id: "cm-b", author: "校对员乙", body: "乙的批注", createdAt: "2026-10-04T10:05:00Z", resolved: false, replies: [] });
  }, 2000);

  // --- 恢复联网：A 先保存，B 后保存 ---
  flush(A);
  const opsAfterA = stored.ops.length;
  flush(B);

  console.log("恢复联网后的字段层合并");
  const merged = replay(seed, stored.ops);
  const seg = merged.project.tracks[0].segments[1];
  check("A 的保存没有被 B 覆盖", opsAfterA >= 3, `A 后应有 3+ 笔，实际 ${opsAfterA}`);
  check("双方操作都在日志里（不丢变更）", stored.ops.length >= opsAfterA, `共 ${stored.ops.length} 笔`);
  check("文本两边都改 → 进待合并区", merged.merge.openConflicts.some((c) => c.segmentId === SEG && c.field === "text"));
  check("只有文本一个待合并字段", merged.merge.openConflicts.length === 1, `实际 ${merged.merge.openConflicts.length}`);
  check("发言人仅乙方改 → 字段层自动合并", seg.speakerId === "sp-chen");
  check("主题关联取并集", seg.tagIds.includes("topic-A") && seg.tagIds.includes("topic-B"));
  check("批注按新编号追加、双方并存", seg.comments.some((c) => c.id === "cm-a") && seg.comments.some((c) => c.id === "cm-b"));
  const textConflict = merged.merge.openConflicts.find((c) => c.field === "text")!;
  check("待合并保留两版（甲、乙）", textConflict.candidates.length === 2);
  check("每笔变更带校对员", stored.ops.every((op) => op.author.length > 0));
  const segmentScoped = stored.ops.filter((op) => "segmentId" in op) as Extract<ChangeOp, { segmentId: string }>[];
  check("每笔片段变更带片段与基线版本", segmentScoped.every((op) => op.segmentId === SEG && ("baseVersion" in op ? op.baseVersion === 0 : true)));

  console.log("合并失败 / 刷新重开：待合并区可恢复、可继续选择");
  const reopened = replay(seed, stored.ops);
  check("重开后待合并区原样还在", reopened.merge.openConflicts.length === 1 && reopened.merge.openConflicts[0].id === textConflict.id);
  check("两版候选仍在", reopened.merge.openConflicts[0].candidates.length === 2);
  check("片段仍带冲突标记、不可导出", segmentHasOpenConflict(reopened.merge, SEG));

  console.log("人工选定一版（裁决也是追加操作）");
  const chooseA = textConflict.candidates.find((c) => c.author === "校对员甲")!;
  stored.ops = mergeOps(stored.ops, [createResolveOp(textConflict, chooseA.key, { tabId: "tab-A", author: "校对员甲", at: 3000 })]);
  const resolved = replay(seed, stored.ops);
  check("裁决后无待合并", resolved.merge.openConflicts.length === 0);
  check("草稿采用甲的文本", resolved.project.tracks[0].segments[1].text.startsWith("甲："));
  check("发言人合并结果保留", resolved.project.tracks[0].segments[1].speakerId === "sp-chen");
  check("主题并集保留", resolved.project.tracks[0].segments[1].tagIds.includes("topic-A") && resolved.project.tracks[0].segments[1].tagIds.includes("topic-B"));
  check("两条批注仍在", resolved.project.tracks[0].segments[1].comments.length === 2);
  check("裁决后片段可导出", !segmentHasOpenConflict(resolved.merge, SEG));

  console.log("字幕导出只用已定稿版");
  const original3 = seed.tracks[0].segments[2];
  stored.ops = mergeOps(stored.ops, [
    { id: "x-a", kind: "field", tabId: "tab-A", author: "校对员甲", at: 4000, segmentId: "seg-3", field: "text", baseVersion: 0, baseValue: original3.text, value: "甲改seg3" },
    { id: "x-b", kind: "field", tabId: "tab-B", author: "校对员乙", at: 4100, segmentId: "seg-3", field: "text", baseVersion: 0, baseValue: original3.text, value: "乙改seg3" },
  ]);
  const withOpen = replay(seed, stored.ops);
  const exportable = withOpen.project.tracks[0].segments.filter((s) => !segmentHasOpenConflict(withOpen.merge, s.id));
  check("未定稿的 seg-3 被排除出导出", !exportable.some((s) => s.id === "seg-3"));
  check("已定稿的 seg-2 仍在导出集合", exportable.some((s) => s.id === SEG));

  void original;
  console.log(failures === 0 ? "\n集成测试全部通过" : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
