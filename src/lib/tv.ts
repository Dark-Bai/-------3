/**
 * TV 模式: Android TV 壳 App 通过 ?tv=1 启用; 也按 UA 自动识别常见电视/盒子。
 * 命中后 <html> 加 .tv class, 并启用遥控器方向键空间导航。
 */
function detectTv(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get("tv") === "1") return true;
  const ua = navigator.userAgent;
  return /Android/i.test(ua) && /TV|AFT|BRAVIA|MiTV|SHIELD|Nexus Player/i.test(ua);
}

export const isTv = detectTv();

/** 挂载 TV 模式的根 class(样式见 index.css); 非 TV 环境零副作用 */
export function initTvMode() {
  if (!isTv) return;
  document.documentElement.classList.add("tv");
  // 固定 1920 CSS 像素视口: 部分 4K 电视 WebView 按高密度上报(如 960dp),
  // 会走移动端断点且字体成倍放大; 固定宽度后任意密度下布局与字号一致
  let meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "viewport";
    document.head.appendChild(meta);
  }
  // 不写 initial-scale/maximum-scale: 会禁用 WebView 概览缩放, 1920 布局无法缩小适配, 页面溢出屏幕
  meta.content = "width=1920";
  showDebugBadge();
}

/** 左下角调试角标: WebView 内核版本 + 前端构建时间 + 实时FPS/JS堆内存(定位电视卡顿瓶颈) */
function showDebugBadge() {
  const ua = navigator.userAgent;
  const engine = ua.match(/Chrome\/[\d.]+/)?.[0] ?? "非Chromium内核";
  const el = document.createElement("div");
  el.title = ua;
  el.style.cssText =
    "position:fixed;left:8px;bottom:8px;z-index:9999;font-size:11px;line-height:1.6;" +
    "color:#64748b;background:rgba(2,6,23,.85);padding:2px 8px;border-radius:6px;pointer-events:none";
  document.body.appendChild(el);

  let frames = 0;
  const countFrame = () => {
    frames++;
    requestAnimationFrame(countFrame);
  };
  requestAnimationFrame(countFrame);
  window.setInterval(() => {
    const fps = frames;
    frames = 0;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const memStr = mem ? ` · 内存 ${Math.round(mem.usedJSHeapSize / 1048576)}MB` : "";
    const hub = (window as unknown as { __hubStatus?: { t: number; changed: boolean } }).__hubStatus;
    const hubStr = hub ? ` · 报价 ${Math.round((Date.now() - hub.t) / 1000)}s前${hub.changed ? "(有变化)" : "(无变化)"}` : "";
    el.textContent = `${engine} · 构建 ${__BUILD_TIME__} · ${fps}fps${memStr}${hubStr}`;
  }, 1000);
}
