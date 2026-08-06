/**
 * PHILIA 跨标签页同步(主面板 / 新页面 / 悬浮小窗)。
 *
 * 背景: 主页面 "/" 与「新页面」"/philia" 是独立标签页, 各自持有独立的模块级 reviewState,
 * 以往新页面点「重新分析」只更新它自己, 主页不会同步。这里用 BroadcastChannel 广播,
 * 让任意标签页触发的重新分析结果同步到其他标签页, 保证各页 PHILIA 数据一致。
 *
 * 只广播结果/加载信号, 接收方仅更新本地状态、不反向广播, 因此不会产生循环。
 */
export interface PhiliaSyncMessage {
  type: "philia-loading" | "philia-analysis" | "philia-state" | "philia-toggle" | "philia-sync-request";
  /** loading=true 表示某标签页开始重新分析 */
  loading?: boolean;
  /** 重新分析完成后的完整分析结果 */
  result?: unknown;
  /** 完整共享状态(analysis/loading/refreshing/error/pollLogs), 用于跨标签页全量同步 */
  state?: unknown;
  /** 自动轮询开关的目标状态 */
  enabled?: boolean;
}

const CHANNEL = "philia-sync";
let bc: BroadcastChannel | null = null;
try {
  bc = new BroadcastChannel(CHANNEL);
} catch {
  bc = null; // 极老浏览器无 BroadcastChannel: 仅本标签页内同步(无跨页能力)
}

/** 广播一条 PHILIA 同步消息(发起方调用, 接收方不广播) */
export function postPhiliaSync(msg: PhiliaSyncMessage): void {
  try {
    bc?.postMessage(msg);
  } catch {
    /* 忽略 */
  }
}

/** 订阅 PHILIA 同步消息, 返回取消订阅函数 */
export function onPhiliaSync(cb: (msg: PhiliaSyncMessage) => void): () => void {
  if (!bc) return () => {};
  const handler = (ev: MessageEvent) => cb(ev.data as PhiliaSyncMessage);
  bc.addEventListener("message", handler);
  return () => bc?.removeEventListener("message", handler);
}