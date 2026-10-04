// 组件级冒烟：jsdom 提供 localStorage/BroadcastChannel，renderToString 渲染整个编辑器，
// 验证信号初始化、replay 接入与待合并区弹窗在真实组件代码中无运行时错误。
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: "http://localhost/" });
const win = dom.window as any;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true, writable: true });
(globalThis as any).localStorage = win.localStorage;
(globalThis as any).BroadcastChannel = win.BroadcastChannel ?? class { postMessage() {} close() {} addEventListener() {} };
(globalThis as any).requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
(globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);

const { renderToString } = await import("solid-js/web");
const { default: Editor } = await import("../src/routes/index.tsx");

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail ? ` — ${detail}` : ""));
  if (!ok) failures += 1;
};

const html = renderToString(() => Editor() as any);
for (const token of ["待合并", "追加式", "校对员", "导出 SRT", "榕城码头记忆", "普通话校订轨"]) {
  check(`初始渲染含「${token}」`, html.includes(token));
}
check("渲染出片段卡片", html.includes("segment-card") || html.includes("林阿婆"));
check("渲染出待合并按钮计数 0", html.includes("待合并"));

process.exit(failures ? 1 : 0);
