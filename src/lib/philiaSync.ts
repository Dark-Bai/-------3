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
  type: "philia-loading" | "philia-analysis" | "philia-state" | "philia-toggle" | "philia-sync-request" | "philia-main-beat" | "philia-stock";
  /** loading=true 表示某标签页开始重新分析 */
  loading?: boolean;
  /** 重新分析完成后的完整分析结果 */
  result?: unknown;
  /** 完整共享状态(analysis/loading/refreshing/error/pollLogs), 用于跨标签页全量同步 */
  state?: unknown;
  /** 自动轮询开关的目标状态 */
  enabled?: boolean;
  /** 当前个股(主页→/philia 镜像): 输入框值跨标签页保持一致 */
  stock?: { code?: string; name?: string } | null;
}

/** 主页面心跳: 主页面(驾驶舱 "/")周期性写入, /philia 新页面据此判断主页面是否仍打开 */
const MAIN_HEARTBEAT_KEY = "dash:main-heartbeat";
/** 心跳间隔: 主页面每 4s 写一次 */
const HEARTBEAT_INTERVAL = 4 * 1000;
/** 超过 12s(约 3 个周期)未收到心跳即视为主页面已关闭 */
const HEARTBEAT_TTL = 12 * 1000;

/** 判断主页面(驾驶舱)是否仍打开(心跳是否新鲜) */
export function isMainPageAlive(): boolean {
  try {
    const raw = localStorage.getItem(MAIN_HEARTBEAT_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    return Number.isFinite(ts) && Date.now() - ts < HEARTBEAT_TTL;
  } catch {
    return false;
  }
}

/** 主页面启动心跳: 周期性写本地时间戳 + 广播, 供 /philia 判断主页面存活。返回清理函数。 */
export function startMainHeartbeat(): () => void {
  const beat = () => {
    try {
      localStorage.setItem(MAIN_HEARTBEAT_KEY, String(Date.now()));
    } catch {
      /* 隐私/配额受限时忽略 */
    }
    try {
      bc?.postMessage({ type: "philia-main-beat" } satisfies PhiliaSyncMessage);
    } catch {
      /* 忽略 */
    }
  };
  beat();
  const t = setInterval(beat, HEARTBEAT_INTERVAL);
  return () => clearInterval(t);
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