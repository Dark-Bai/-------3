import { isTv } from "./tv";

/**
 * 遥控器方向键空间导航(仅 TV 模式启用):
 * - 常规态: [data-tv-focusable] 为候选(面板 + 导航链接);
 * - 放大浮层态: 仅面板内部控件(按钮/链接/输入框)为候选, 面板本身作为兜底落点;
 * - 方向打分 = 边缘间距(主) + 轴心偏移(次) - 轴向重叠奖励, 正对面的候选优先;
 * - ↑/↓ 焦点在面板上时先滚内部滚动区, 滚到头再移动焦点;
 * - OK(Enter) 触发焦点元素 click(面板 = 放大/还原, 按钮/链接 = 原生行为);
 * - 放大态且焦点在面板本身时 ←/→ 幻灯片式切换相邻面板;
 * - DOM 变化后焦点丢失时自动聚焦第一个可聚焦元素。
 */

const SEL = "[data-tv-focusable]";
const SCROLL_STEP = 160;

type Dir = "up" | "down" | "left" | "right";

const KEY_DIR: Record<string, Dir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

const isVisible = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

function zoomedPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>("section[data-tv-zoomed]");
}

function focusables(): HTMLElement[] {
  const zoomed = zoomedPanel();
  if (zoomed) {
    // 放大浮层: 仅内部控件 + 可滚动区域(成分股侧栏等)为候选 —
    // 全屏面板自身若参与打分, 任何方向都可能跳回它(导航"乱"的主因)
    const controls = Array.from(zoomed.querySelectorAll<HTMLElement>("button, a, input"));
    const scrollers = Array.from(zoomed.querySelectorAll<HTMLElement>(".overflow-y-auto, .overflow-auto")).filter(
      (el) => el.scrollHeight > el.clientHeight + 4
    );
    for (const s of scrollers) {
      if (s.tabIndex < 0) s.tabIndex = -1; // div 需 tabIndex 才可聚焦
      s.setAttribute("data-tv-scroll", "");
    }
    return [...controls, ...scrollers].filter(isVisible);
  }
  return Array.from(document.querySelectorAll<HTMLElement>(SEL)).filter(isVisible);
}

const overlap = (a1: number, a2: number, b1: number, b2: number) =>
  Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

/** 方向打分: 边缘间距×3 + 轴心偏移×1.5 - 重叠奖励(正对面的候选必然赢过斜对角) */
function nearest(from: DOMRect, dir: Dir, candidates: HTMLElement[]): HTMLElement | null {
  const fcx = from.left + from.width / 2;
  const fcy = from.top + from.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    let primary: number;
    let secondary: number;
    let ov: number;
    if (dir === "down") {
      primary = r.top - from.bottom;
      secondary = Math.abs(r.left + r.width / 2 - fcx);
      ov = overlap(r.left, r.right, from.left, from.right);
    } else if (dir === "up") {
      primary = from.top - r.bottom;
      secondary = Math.abs(r.left + r.width / 2 - fcx);
      ov = overlap(r.left, r.right, from.left, from.right);
    } else if (dir === "left") {
      primary = from.left - r.right;
      secondary = Math.abs(r.top + r.height / 2 - fcy);
      ov = overlap(r.top, r.bottom, from.top, from.bottom);
    } else {
      primary = r.left - from.right;
      secondary = Math.abs(r.top + r.height / 2 - fcy);
      ov = overlap(r.top, r.bottom, from.top, from.bottom);
    }
    if (primary < -8) continue; // 不在该方向上
    const score = Math.max(0, primary) * 3 + secondary * 1.5 - Math.min(ov, 300) * 2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/** 焦点元素最近的纵向可滚动祖先(焦点在列表内元素时), 或其内部第一个可滚动区域(焦点在面板容器上时) */
function scrollableIn(el: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = el;
  while (node) {
    const s = getComputedStyle(node);
    if (/(auto|scroll)/.test(s.overflowY) && node.scrollHeight > node.clientHeight + 4) return node;
    node = node.parentElement;
  }
  const inner = el?.querySelector<HTMLElement>(".overflow-y-auto, .overflow-auto");
  if (inner && inner.scrollHeight > inner.clientHeight + 4) return inner;
  return null;
}

/** ↑/↓ 先滚滚动区, 滚不动(到头)返回 false */
function scrollStep(el: HTMLElement | null, dir: "up" | "down"): boolean {
  const scroller = scrollableIn(el);
  if (!scroller) return false;
  const atTop = scroller.scrollTop <= 0;
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
  if ((dir === "up" && atTop) || (dir === "down" && atBottom)) return false;
  scroller.scrollBy({ top: dir === "up" ? -SCROLL_STEP : SCROLL_STEP, behavior: "smooth" });
  return true;
}

function ensureFocus() {
  const ae = document.activeElement as HTMLElement | null;
  if (ae && ae !== document.body && ae.isConnected) return;
  const zoomed = zoomedPanel();
  (zoomed ?? focusables()[0])?.focus({ preventScroll: true });
}

function onKeyDown(e: KeyboardEvent) {
  const dir = KEY_DIR[e.key];
  const active = (document.activeElement as HTMLElement | null) ?? document.body;
  const zoomed = zoomedPanel();

  if (e.key === "Enter") {
    // 滚动区域仅用于聚焦滚动, OK 不触发 click(冒泡到面板会被当作放大/还原)
    if (active.hasAttribute?.("data-tv-scroll")) {
      e.preventDefault();
      return;
    }
    // 面板(带SEL)或放大浮层内的控件
    if (active.matches?.(SEL) || (zoomed && active !== zoomed && zoomed.contains(active))) {
      e.preventDefault();
      active.click();
    }
    return;
  }
  if (!dir) return;
  e.preventDefault();

  // ===== 放大浮层态 =====
  if (zoomed) {
    if (active === zoomed) {
      // 焦点在面板本身: ←/→ 幻灯片切换相邻面板
      if (dir === "left" || dir === "right") {
        const panels = Array.from(document.querySelectorAll<HTMLElement>("section[data-tv-focusable]"));
        const i = panels.indexOf(zoomed);
        if (i >= 0) {
          const next = panels[(i + (dir === "right" ? 1 : panels.length - 1)) % panels.length];
          next?.click();
          next?.focus({ preventScroll: true });
        }
        return;
      }
      // ↑/↓ 先滚内容; 滚到顶后 ↑ 聚焦第一个内部控件(页签),
      // (面板是全屏矩形, 控件在其内部而非几何上方, 方向打分找不到)
      if (scrollStep(zoomed, dir)) return;
      if (dir === "up") focusables()[0]?.focus({ preventScroll: true });
      return;
    }
    // 焦点在内部控件: ↑/↓ 先滚所在滚动区(成分股侧栏/列表), 滚到头再控件间导航;
    // 该方向没有候选则回退到面板本身(恢复幻灯片/滚动)
    if ((dir === "up" || dir === "down") && scrollStep(active, dir)) return;
    const next = nearest(active.getBoundingClientRect(), dir, focusables().filter((el) => el !== active));
    (next ?? zoomed).focus({ preventScroll: true });
    return;
  }

  // ===== 常规态 =====
  if (dir === "up" || dir === "down") {
    if (scrollStep(active.matches?.(SEL) ? active : null, dir)) return;
  }
  const from = active.matches?.(SEL)
    ? active.getBoundingClientRect()
    : new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0);
  const next = nearest(from, dir, focusables().filter((el) => el !== active));
  next?.focus({ preventScroll: false });
}

export function initTvFocus() {
  if (!isTv) return;
  window.addEventListener("keydown", onKeyDown, true);
  // 路由切换/数据重渲染后焦点元素可能被移除, 焦点回退到第一个可聚焦元素
  let timer = 0;
  new MutationObserver(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(ensureFocus, 300);
  }).observe(document.body, { childList: true, subtree: true });
  window.setTimeout(ensureFocus, 500);
}
