// 字段级三路合并的核心场景验证：用 esbuild 打包后由 node 运行。
//   npx esbuild scripts/test-merge.ts --bundle --platform=node --format=esm --outfile=.tmp/test-merge.mjs && node .tmp/test-merge.mjs
import { createSeedProject, uid } from "../src/data";
import {
  createResolveOp,
  diffProjects,
  findSegment,
  mergeOps,
  openConflictsOfSegment,
  replay,
  scopeOpsTo,
  segmentHasOpenConflict,
} from "../src/sync";
import type { ChangeOp, FieldConflict, ProjectData, ScalarField } from "../src/types";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const seed = createSeedProject();
const SEG = "seg-2";
const TRACK = "track-zh";

const fieldOp = (
  tabId: string,
  author: string,
  at: number,
  field: ScalarField,
  value: string | number | boolean,
  baseVersion: number,
  baseValue: string | number | boolean,
  segmentId = SEG,
): ChangeOp => ({
  id: uid("op"),
  kind: "field",
  tabId,
  author,
  at,
  segmentId,
  field,
  baseVersion,
  baseValue,
  value,
});

const tagsOp = (tabId: string, author: string, at: number, tagIds: string[], baseValue: string[], baseVersion = 0) => ({
  id: uid("op"),
  kind: "tags" as const,
  tabId,
  author,
  at,
  segmentId: SEG,
  baseVersion,
  baseValue,
  tagIds,
});

function editorSnapshot(project: ProjectData, mutate: (p: ProjectData) => void) {
  const next = structuredClone(project);
  mutate(next);
  return next;
}

// 1. 线性快进：A 改文本，B 基于 A 的版本再改 —— 无冲突
{
  console.log("线性编辑（无分叉）");
  const a1 = fieldOp("tab-A", "校对员甲", 1000, "text", "甲改的文本", 0, seed.tracks[0].segments[1].text);
  const stateAfterA = replay(seed, [a1]);
  const versionAfterA = stateAfterA.merge.segmentVersions[SEG];
  const b1 = fieldOp("tab-B", "校对员乙", 2000, "text", "乙在甲之后改", versionAfterA, "甲改的文本");
  const result = replay(seed, [a1, b1]);
  check("最终文本为乙的版本", findSegment(result.project, SEG)!.text === "乙在甲之后改");
  check("没有待合并条目", result.merge.openConflicts.length === 0);
  check("片段版本累计为 2", result.merge.segmentVersions[SEG] === 2);
}

// 2. 双方离线分叉同一字段：两边都改过 → 留两版进待合并区
{
  console.log("双方同改文本 → 待合并区两版");
  const original = seed.tracks[0].segments[1].text;
  const a1 = fieldOp("tab-A", "校对员甲", 1000, "text", "甲的版本", 0, original);
  const b1 = fieldOp("tab-B", "校对员乙", 2000, "text", "乙的版本", 0, original);
  // 无论到达顺序如何，重放结果必须一致
  const r1 = replay(seed, [a1, b1]);
  const r2 = replay(seed, [b1, a1]);
  check("产生 1 条待合并", r1.merge.openConflicts.length === 1, `实际 ${r1.merge.openConflicts.length}`);
  const conflict = r1.merge.openConflicts[0] as FieldConflict;
  check("保留两个候选版本", conflict.candidates.length === 2);
  check("候选包含甲和乙", conflict.candidates.some((c) => c.author === "校对员甲") && conflict.candidates.some((c) => c.author === "校对员乙"));
  check("未裁决时展示较新的乙版", findSegment(r1.project, SEG)!.text === "乙的版本");
  check("到达顺序不影响结果", findSegment(r2.project, SEG)!.text === "乙的版本" && r2.merge.openConflicts.length === 1);
  check("候选中保留甲的版本", conflict.candidates.some((c) => c.value === "甲的版本"));
}

// 3. 不同字段分叉 → 字段层自动合并
{
  console.log("不同字段分叉 → 字段层自动合并");
  const original = seed.tracks[0].segments[1];
  const a1 = fieldOp("tab-A", "校对员甲", 1000, "text", "甲只改文本", 0, original.text);
  const b1 = fieldOp("tab-B", "校对员乙", 2000, "speakerId", "sp-chen", 0, original.speakerId);
  const result = replay(seed, [a1, b1]);
  const seg = findSegment(result.project, SEG)!;
  check("文本采用甲的修改", seg.text === "甲只改文本");
  check("发言人采用乙的修改", seg.speakerId === "sp-chen");
  check("没有待合并条目", result.merge.openConflicts.length === 0);
}

// 4. 一方改一方没改 → 直接采用改动方
{
  console.log("只有一方修改该字段 → 直接合并");
  const original = seed.tracks[0].segments[1];
  const a1 = fieldOp("tab-A", "校对员甲", 1000, "text", "甲改了", 0, original.text);
  const b1 = fieldOp("tab-B", "校对员乙", 2000, "text", "甲改了", 0, original.text); // B 没改文本
  const result = replay(seed, [a1, b1]);
  check("无冲突", result.merge.openConflicts.length === 0);
  check("文本为甲的修改", findSegment(result.project, SEG)!.text === "甲改了");
}

// 5. 冲突五个字段全覆盖：发言人、时间、置信度也留两版
{
  console.log("发言人/时间/置信度冲突同样留两版");
  const original = seed.tracks[0].segments[1];
  for (const [field, av, bv, base] of [
    ["speakerId", "sp-chen", "sp-interviewer", original.speakerId],
    ["start", 1.5, 2.5, original.start],
    ["end", 40, 42, original.end],
    ["confidence", 1, 5, original.confidence],
  ] as const) {
    const a1 = fieldOp("tab-A", "校对员甲", 1000, field, av as any, 0, base as any);
    const b1 = fieldOp("tab-B", "校对员乙", 2000, field, bv as any, 0, base as any);
    const result = replay(seed, [a1, b1]);
    check(`${field} 产生待合并`, result.merge.openConflicts.length === 1, `实际 ${result.merge.openConflicts.length}`);
  }
}

// 6. 主题关联取并集
{
  console.log("主题关联分叉 → 取并集");
  const base = seed.tracks[0].segments[1].tagIds;
  const a1 = tagsOp("tab-A", "校对员甲", 1000, [...base, "topic-A"], base);
  const afterA = replay(seed, [a1]);
  const v = afterA.merge.segmentVersions[SEG];
  const b1 = tagsOp("tab-B", "校对员乙", 2000, [...base, "topic-B"], base); // 基于同一旧基线
  void v;
  const result = replay(seed, [a1, b1]);
  const seg = findSegment(result.project, SEG)!;
  check("并集包含 A 的关联", seg.tagIds.includes("topic-A"));
  check("并集包含 B 的关联", seg.tagIds.includes("topic-B"));
  check("并集保留原有基线关联", base.every((id) => seg.tagIds.includes(id)));
  check("不产生字段冲突", result.merge.openConflicts.length === 0);
}

// 7. 批注按编号追加，互不覆盖
{
  console.log("批注并发追加 → 按编号并存");
  const a = editorSnapshot(seed, (p) => {
    findSegment(p, SEG)!.comments.unshift({
      id: "comment-A", author: "校对员甲", body: "甲的批注", createdAt: "2026-10-04T10:00:00Z", resolved: false, replies: [],
    });
  });
  const b = editorSnapshot(seed, (p) => {
    findSegment(p, SEG)!.comments.unshift({
      id: "comment-B", author: "校对员乙", body: "乙的批注", createdAt: "2026-10-04T10:01:00Z", resolved: false, replies: [],
    });
  });
  const opsA = diffProjects(seed, a, { tabId: "tab-A", author: "校对员甲", at: 1000, versions: {} });
  const opsB = diffProjects(seed, b, { tabId: "tab-B", author: "校对员乙", at: 2000, versions: {} });
  const result = replay(seed, mergeOps(opsA, opsB));
  const comments = findSegment(result.project, SEG)!.comments;
  check("两条批注都保留", comments.length === 2 && comments.some((c) => c.id === "comment-A") && comments.some((c) => c.id === "comment-B"));
  check("没有冲突", result.merge.openConflicts.length === 0);
}

// 8. 人工裁决：选甲版后草稿确定化，导出不再包含该片段的冲突
{
  console.log("人工裁决 → 草稿确定、可导出");
  const original = seed.tracks[0].segments[1].text;
  const a1 = fieldOp("tab-A", "校对员甲", 1000, "text", "甲的定稿", 0, original);
  const b1 = fieldOp("tab-B", "校对员乙", 2000, "text", "乙的定稿", 0, original);
  const conflicted = replay(seed, [a1, b1]);
  const conflict = conflicted.merge.openConflicts[0];
  check("裁决前片段不可导出", segmentHasOpenConflict(conflicted.merge, SEG));
  const resolve = createResolveOp(conflict, conflict.candidates.find((c) => c.author === "校对员甲")!.key, {
    tabId: "tab-A", author: "校对员甲", at: 3000,
  });
  const resolved = replay(seed, [a1, b1, resolve]);
  check("裁决后无待合并", resolved.merge.openConflicts.length === 0);
  check("草稿采用甲的定稿", findSegment(resolved.project, SEG)!.text === "甲的定稿");
  check("裁决后片段可导出", !segmentHasOpenConflict(resolved.merge, SEG));
}

// 9. 合并失败恢复：仅追加、不丢操作；重开能接着选
{
  console.log("合并失败后恢复 / 重开继续选择");
  const original = seed.tracks[0].segments[1].text;
  const a1 = fieldOp("tab-A", "校对员甲", 1000, "text", "甲版", 0, original);
  const b1 = fieldOp("tab-B", "校对员乙", 2000, "text", "乙版", 0, original);
  // 模拟“保存失败”：日志在内存中仍然只有各自的操作；双方操作都不丢
  const recovered = replay(seed, mergeOps([a1], [b1]));
  check("双方变更都恢复", recovered.merge.openConflicts.length === 1 && recovered.merge.openConflicts[0].candidates.length === 2);
  // 模拟刷新重开：用同一日志再放一遍，待合并区原样还在
  const reopened = replay(seed, [a1, b1]);
  check("重开后仍可继续选择", reopened.merge.openConflicts[0]?.id === recovered.merge.openConflicts[0]?.id);
  const conflict = reopened.merge.openConflicts[0];
  const chooseB = conflict.candidates.find((c) => c.author === "校对员乙")!.key;
  const done = replay(seed, [a1, b1, createResolveOp(conflict, chooseB, { tabId: "tab-B", author: "校对员乙", at: 4000 })]);
  check("重开后裁决生效", findSegment(done.project, SEG)!.text === "乙版" && done.merge.openConflicts.length === 0);
}

// 10. 同校对员在冲突上的后续修改并入她那一版
{
  console.log("同一校对员继续改 → 并入她的候选版本");
  const original = seed.tracks[0].segments[1].text;
  const a1 = fieldOp("tab-A", "校对员甲", 1000, "text", "甲第一版", 0, original);
  const b1 = fieldOp("tab-B", "校对员乙", 2000, "text", "乙版", 0, original);
  const a2 = fieldOp("tab-A", "校对员甲", 3000, "text", "甲修订版", 0, original); // 仍基于旧基线
  const result = replay(seed, [a1, b1, a2]);
  const conflict = result.merge.openConflicts[0];
  check("仍是同一个待合并条目", result.merge.openConflicts.length === 1);
  check("仍是两个候选（按校对员折叠）", conflict.candidates.length === 2, `实际 ${conflict.candidates.length}`);
  const candA = conflict.candidates.find((c) => c.tabId === "tab-A")!;
  check("甲的候选更新为修订版", candA.value === "甲修订版");
}

// 11. 撤销也是追加：不会抹掉对方的操作
{
  console.log("撤销操作以追加方式表达");
  const original = seed.tracks[0].segments[1];
  const a1 = fieldOp("tab-A", "校对员甲", 1000, "confidence", 2, 0, original.confidence);
  // 甲撤销 = 基于当前版本把值改回去（一笔新操作）
  const undo = fieldOp("tab-A", "校对员甲", 1500, "confidence", original.confidence, 1, 2);
  const b1 = fieldOp("tab-B", "校对员乙", 2000, "text", "乙改文本", 0, original.text);
  const result = replay(seed, [a1, undo, b1]);
  const seg = findSegment(result.project, SEG)!;
  check("撤销后置信度恢复", seg.confidence === original.confidence);
  check("乙的文本修改仍在", seg.text === "乙改文本");
  check("历史操作全部保留（追加式）", result.merge.opCount === 3);
}

// 12. diffProjects：基线版本随重放状态传入
{
  console.log("编辑快照 → 追加字段变更（带片段/基线/校对员）");
  const after = editorSnapshot(seed, (p) => {
    const seg = findSegment(p, SEG)!;
    seg.text = "改后的文本";
    seg.confidence = 1;
  });
  const ops = diffProjects(seed, after, { tabId: "tab-A", author: "校对员甲", at: 1000, versions: { [SEG]: 0 } });
  check("生成 2 笔字段变更", ops.length === 2, `实际 ${ops.length}`);
  check("每笔带片段 id", ops.every((op) => "segmentId" in op && op.segmentId === SEG));
  check("每笔带基线版本 0", ops.every((op) => "baseVersion" in op && op.baseVersion === 0));
  check("每笔带校对员", ops.every((op) => op.author === "校对员甲" && op.tabId === "tab-A"));
  const replayed = replay(seed, ops);
  check("重放得到编辑后快照", findSegment(replayed.project, SEG)!.text === "改后的文本" && findSegment(replayed.project, SEG)!.confidence === 1);
  check("opCount 计入 2 笔", replayed.merge.opCount === 2);
}

// 13. 导出只走确定版：同一轨道另一片段冲突时，只导出无冲突片段
{
  console.log("字幕导出只用已确定版本");
  const original2 = seed.tracks[0].segments[1];
  const original3 = seed.tracks[0].segments[2];
  const ops = [
    fieldOp("tab-A", "校对员甲", 1000, "text", "seg2 甲", 0, original2.text, "seg-2"),
    fieldOp("tab-B", "校对员乙", 2000, "text", "seg2 乙", 0, original2.text, "seg-2"),
    fieldOp("tab-A", "校对员甲", 1000, "speakerId", "sp-chen", 0, original3.speakerId, "seg-3"),
  ];
  const result = replay(seed, ops);
  check("seg-2 待人工选择", segmentHasOpenConflict(result.merge, "seg-2"));
  check("seg-3 已确定", !segmentHasOpenConflict(result.merge, "seg-3"));
  check("seg-3 的发言人修改生效", findSegment(result.project, "seg-3")!.speakerId === "sp-chen");
  check("可导出片段集合排除 seg-2", openConflictsOfSegment(result.merge, "seg-2").length === 1);
}

// 14. reviewed / flags 双方都改 → 时间后者胜，无待合并
{
  console.log("校对标记双方都改 → LWW 自动合并");
  const original = seed.tracks[0].segments[1];
  const a1 = fieldOp("tab-A", "校对员甲", 1000, "dialect", true, 0, original.flags.dialect);
  const b1 = fieldOp("tab-B", "校对员乙", 2000, "dialect", false, 0, original.flags.dialect);
  const result = replay(seed, [a1, b1]);
  check("较晚的乙方值生效", findSegment(result.project, SEG)!.flags.dialect === false);
  check("不进待合并区", result.merge.openConflicts.length === 0);
}

// 15. 第三个校对员分叉 → 三个候选都保留
{
  console.log("三方分叉 → 三个候选版本都保留");
  const original = seed.tracks[0].segments[1].text;
  const trunk = fieldOp("tab-A", "校对员甲", 1000, "text", "甲版", 0, original);
  const state = replay(seed, [trunk]);
  void state;
  const b1 = fieldOp("tab-B", "校对员乙", 2000, "text", "乙版", 0, original);
  const c1 = fieldOp("tab-C", "校对员丙", 2500, "text", "丙版", 0, original);
  const result = replay(seed, [trunk, b1, c1]);
  const conflict = result.merge.openConflicts[0];
  check("三个候选并存", conflict.candidates.length === 3, `实际 ${conflict.candidates.length}`);
}

// 16. 撤销裁剪：逆变更只触碰本步改过的字段，不回退对方的无关修改
{
  console.log("撤销 → 不抹掉对方合入的无关字段修改");
  const seg2 = seed.tracks[0].segments[1];
  const seg3 = seed.tracks[0].segments[2];
  // 甲把 seg-2 置信度改为 1
  const a1 = fieldOp("tab-A", "校对员甲", 1000, "confidence", 1, 0, seg2.confidence);
  const afterA = replay(seed, [a1]);
  // 乙随后改了 seg-2 的发言人（不同字段，已合并进来）和 seg-3 文本
  const b1 = fieldOp("tab-B", "校对员乙", 2000, "speakerId", "sp-chen", afterA.merge.segmentVersions[SEG], seg2.speakerId);
  const b2 = fieldOp("tab-B", "校对员乙", 2000, "text", "乙改seg3", 0, seg3.text, "seg-3");
  const mergedState = replay(seed, [a1, b1, b2]);
  // 甲撤销她的置信度修改：快照 diff 会想把 confidence 改回；scopeOpsTo 必须只放行 confidence
  const target = structuredClone(mergedState.project);
  const s2 = findSegment(target, SEG)!;
  s2.confidence = seg2.confidence;
  s2.speakerId = seg2.speakerId; // 模拟“回到她编辑前的整份快照”会错误带上发言人回退
  const candidates = diffProjects(mergedState.project, target, {
    tabId: "tab-A", author: "校对员甲", at: 3000, versions: mergedState.merge.segmentVersions,
  });
  const scoped = scopeOpsTo([a1], candidates);
  check("裁剪后只剩置信度逆变更", scoped.length === 1 && scoped[0].kind === "field" && (scoped[0] as any).field === "confidence",
    `实际 ${scoped.length} 笔`);
  const undone = replay(seed, mergeOps([a1, b1, b2], scoped));
  check("撤销后置信度恢复", findSegment(undone.project, SEG)!.confidence === seg2.confidence);
  check("乙的发言人修改保留", findSegment(undone.project, SEG)!.speakerId === "sp-chen");
  check("乙的 seg-3 修改保留", findSegment(undone.project, "seg-3")!.text === "乙改seg3");
  check("无冲突", undone.merge.openConflicts.length === 0);
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
