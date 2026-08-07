/**
 * Philia AI 分析配置模态窗口
 *
 * 输入项:
 *  - API Key(强制, sk-or- 格式校验 + 实时校验)
 *  - AI 模型下拉(默认 deepseek-v4-flash 正式版)
 *  - 技能多选(读取 youzi-qijie-jinghua 目录)
 * 操作:
 *  - 保存配置: 加密存储后关闭; 分析由主面板「启动 AI 综合分析」按钮触发
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Sparkles, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { usePhilia } from "./PhiliaContext";
import { api, type PhiliaModel, type PhiliaConfig, type ThsAccountInfo } from "@/lib/api";

/** 后端模型接口未就绪/空时的兜底模型列表(含 deepseek-v4-flash 正式版) */
const DEFAULT_MODELS: PhiliaModel[] = [
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash（正式版）", isDeepSeekV4: true, default: true },
  { id: "deepseek/deepseek-chat", name: "DeepSeek V3", default: false },
  { id: "openai/gpt-4o", name: "OpenAI GPT-4o", default: false },
  { id: "anthropic/claude-3.5-sonnet", name: "Anthropic Claude Sonnet", default: false },
];

/** API Key 格式: OpenRouter(sk-or-) 或 DeepSeek(sk-) 前缀 + 字母数字 */
function keyFormatValid(key: string): boolean {
  const k = key.trim();
  return /^sk-or-[A-Za-z0-9_-]+$/.test(k) || /^sk-[A-Za-z0-9_-]{16,}$/.test(k);
}

export function PhiliaModal() {
  const { config, skills, skillsLoaded, models, closeModal, saveSettings } = usePhilia();

  /* 表单状态 */
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  /* 校验状态 */
  const [keyValidating, setKeyValidating] = useState(false);
  const [keyValidated, setKeyValidated] = useState<"valid" | "invalid" | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  /* 提交状态 */
  const [submitting, setSubmitting] = useState<boolean | "saving">(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /* 保存成功反馈(保存成功后短暂展示再关闭) */
  const [saved, setSaved] = useState(false);
  /* 防止 config 引用变化(后台刷新)时重置用户正在编辑的表单 */
  const initializedRef = useRef<PhiliaConfig | null>(null);
  /* 分页: config=分析配置, ths=同花顺账号 */
  const [tab, setTab] = useState<"config" | "ths">("config");
  /* 同花顺 THS 账号表单(密码不回显, 仅展示已配置状态) */
  const [thsInfo, setThsInfo] = useState<ThsAccountInfo | null>(null);
  const [thsUsername, setThsUsername] = useState("");
  const [thsPassword, setThsPassword] = useState("");
  const [thsMac, setThsMac] = useState("");
  const [thsHexinExe, setThsHexinExe] = useState("");
  const [thsError, setThsError] = useState<string | null>(null);

  /* 合并模型列表: 后端优先, 空则用兜底 */
  const modelOptions = useMemo(() => {
    if (models && models.length > 0) return models;
    return DEFAULT_MODELS;
  }, [models]);

  /* 弹窗打开(挂载): 从已保存配置回填表单。
   * 仅当 config 首次就绪时初始化一次, 之后 config 引用变化不再重置用户编辑中的选择,
   * 从而保证「技能选择」等表单状态在重新进入页面时正确保留为已保存值。 */
  useEffect(() => {
    if (!config || config === initializedRef.current) return;
    initializedRef.current = config;
    setModel(config?.model || DEFAULT_MODELS.find((m) => m.default)?.id || modelOptions[0]?.id || "");
    setSelectedSkills(config?.skills ? [...config.skills] : []);
    setKey("");
    setKeyValidated(null);
    setKeyError(null);
    setSubmitError(null);
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  /* ESC 关闭 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeModal]);

  /* 弹窗打开时读取已保存的同花顺账号(后端不回传明文密码) */
  useEffect(() => {
    let on = true;
    api.thsAccount.get().then((info) => {
      if (!on) return;
      setThsInfo(info);
      setThsUsername(info.username || "");
      setThsMac(info.mac || "");
      setThsHexinExe(info.hexinExe || "");
    }).catch(() => {
      if (on) setThsInfo({ configured: false, username: "", mac: "", hexinExe: "", gatewayAlive: false });
    });
    return () => { on = false; };
  }, []);

  /* 是否需要 Key: 仅当尚未配置(hasKey=false)时强制填写 */
  const needKey = !config?.hasKey;

  /* 校验 Key 格式(失焦/输入时) */
  async function handleValidate() {
    const k = key.trim();
    if (!k) {
      setKeyError("请输入 API Key");
      setKeyValidated("invalid");
      return;
    }
    if (!keyFormatValid(k)) {
      setKeyError("Key 格式不正确，应为 sk-or-（OpenRouter）或 sk-（DeepSeek）Key");
      setKeyValidated("invalid");
      return;
    }
    setKeyValidating(true);
    setKeyError(null);
    try {
      const r = await api.philia.validate(k);
      setKeyValidated(r.valid ? "valid" : "invalid");
      setKeyError(r.error || (r.valid ? null : "Key 无效或被拒绝"));
    } catch (e) {
      setKeyValidated("invalid");
      setKeyError(e instanceof Error ? e.message : "校验失败");
    } finally {
      setKeyValidating(false);
    }
  }

  /** 切换分页时清理提交状态, 避免残留成功/错误反馈跨页展示 */
  function switchTab(t: "config" | "ths") {
    if (t === tab) return;
    setTab(t);
    setSubmitError(null);
    setSaved(false);
    setThsError(null);
  }

  /** 保存配置(含 key 时一并加密存储), 成功后展示反馈再关闭; 当前在「同花顺账号」页则保存 THS 账号 */
  async function handleSave() {
    if (tab === "ths") return handleSaveThs();
    if (needKey && !key.trim()) {
      setKeyError("请先填写 API Key");
      setKeyValidated("invalid");
      return;
    }
    setSubmitError(null);
    setSubmitting("saving");
    setSaved(false);
    try {
      await saveSettings({ key: key.trim() || undefined, model, skills: selectedSkills });
      setSaved(true);
      setSubmitting(false);
      // 短暂展示成功反馈后自动关闭
      setTimeout(closeModal, 700);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "保存失败");
      setSubmitting(false);
    }
  }

  /** 保存同花顺账号: 写本地配置并热重连 THS 网关; 密码留空则保留原密码 */
  async function handleSaveThs() {
    const u = thsUsername.trim();
    if (!u) {
      setThsError("请输入同花顺账号");
      return;
    }
    if (!thsInfo?.configured && !thsPassword.trim()) {
      setThsError("首次配置需填写密码");
      return;
    }
    setThsError(null);
    setSubmitError(null);
    setSubmitting("saving");
    setSaved(false);
    try {
      const info = await api.thsAccount.save({ username: u, password: thsPassword.trim() || undefined, mac: thsMac.trim(), hexinExe: thsHexinExe.trim() });
      setThsInfo(info);
      setThsPassword("");
      setSaved(true);
      setSubmitting(false);
      // 短暂展示成功反馈后自动关闭
      setTimeout(closeModal, 700);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "保存失败");
      setSubmitting(false);
    }
  }

  function toggleSkill(name: string) {
    setSelectedSkills((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  }

  return createPortal(
    <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/40 p-4" onClick={closeModal}>
      <div
        className="flex w-full max-w-[520px] flex-col overflow-hidden rounded-sm border border-[#d4943a]/50 bg-[#faf6ee] shadow-[0_8px_40px_rgba(0,0,0,0.25)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[#e0d5c0] bg-gradient-to-r from-[#f5f0e6] via-[#faf6ee] to-[#f5f0e6] px-4">
          <Sparkles size={15} className="text-[#d4943a]" />
          <h2 className="text-[14px] font-bold tracking-wide text-[#6b5b3e] font-newspaper-heading">
            PHILIA · 分析配置
          </h2>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={closeModal}
              title="关闭"
              className="flex h-7 w-7 items-center justify-center rounded text-[#8b7a5e] transition-colors hover:bg-[#ede4d4] hover:text-[#6b5b3e]"
            >
              <X size={15} />
            </button>
          </div>
        </header>

        {/* 分页: 分析配置 / 同花顺账号 */}
        <nav className="flex shrink-0 border-b border-[#e0d5c0] bg-[#f5f0e6]/60 px-2">
          {(
            [
              ["config", "分析配置"],
              ["ths", "同花顺账号"],
            ] as const
          ).map(([t, label]) => (
            <button
              key={t}
              type="button"
              onClick={() => switchTab(t)}
              className={`-mb-px border-b-2 px-4 py-2 text-[12px] font-semibold transition-colors ${
                tab === t
                  ? "border-[#d4943a] text-[#6b5b3e]"
                  : "border-transparent text-[#a8987e] hover:text-[#6b5b3e]"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        {/* 内容区 */}
        <div className="max-h-[70vh] min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-[#6b5b3e]">
          {tab === "config" ? (
            <>
          {/* API Key */}
          <div>
            <label className="mb-1 flex items-center gap-1 text-[12px] font-semibold text-[#8b7a5e]">
              API Key
              {needKey && <span className="rounded bg-[#b8533a]/15 px-1 text-[10px] text-[#b8533a]">必填</span>}
              {!needKey && (
                <span className="rounded bg-[#4a6b3f]/15 px-1 text-[10px] text-[#4a6b3f]">已配置</span>
              )}
            </label>
            <div className="relative">
              <input
                type="password"
                value={key}
                placeholder={
                  needKey
                    ? "sk-or-… / sk-…（OpenRouter 或 DeepSeek Key）"
                    : config?.keyMask ? `已保存 ${config.keyMask}，输入新 Key 可替换` : "sk-or-… / sk-…"
                }
                disabled={!!submitting}
                onChange={(e) => {
                  setKey(e.target.value);
                  setKeyValidated(null);
                  setKeyError(null);
                }}
                onBlur={() => key && handleValidate()}
                className="w-full rounded border border-[#e0d5c0] bg-[#f5f0e6] px-3 py-2 pr-9 text-[13px] text-[#6b5b3e] outline-none transition-colors placeholder:text-[#c9b99a] focus:border-[#d4943a]/70"
              />
              {keyValidating ? (
                <Loader2 size={15} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-[#a8987e]" />
              ) : keyValidated === "valid" ? (
                <CheckCircle2 size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#4a6b3f]" />
              ) : keyValidated === "invalid" ? (
                <AlertCircle size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#b8533a]" />
              ) : null}
            </div>
            {keyError && <p className="mt-1 text-[11px] text-[#b8533a]">{keyError}</p>}
            <p className="mt-1 text-[10px] text-[#a8987e]">
              密钥将加密存储于本机服务端，绝不出现在前端缓存与日志中。
            </p>
          </div>

          {/* AI 模型 */}
          <div>
            <label className="mb-1 block text-[12px] font-semibold text-[#8b7a5e]">AI 模型</label>
            <select
              value={model}
              disabled={!!submitting}
              onChange={(e) => setModel(e.target.value)}
              className="w-full appearance-none rounded border border-[#e0d5c0] bg-[#f5f0e6] px-3 py-2 text-[13px] text-[#6b5b3e] outline-none transition-colors focus:border-[#d4943a]/70"
            >
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          {/* 技能选择 */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-[12px] font-semibold text-[#8b7a5e]">技能选择</label>
              <div className="flex items-center gap-2">
                {skills.length > 0 && (
                  <button
                    type="button"
                    disabled={!!submitting}
                    onClick={() =>
                      setSelectedSkills(
                        selectedSkills.length === skills.length ? [] : skills.map((s) => s.name)
                      )
                    }
                    className="text-[11px] text-[#4a6b3f] underline-offset-2 hover:underline"
                  >
                    {selectedSkills.length === skills.length ? "取消全选" : "全选"}
                  </button>
                )}
                <span className="text-[10px] text-[#a8987e]">
                  {selectedSkills.length > 0 ? `已选 ${selectedSkills.length} 项` : "未选（通用分析）"}
                </span>
              </div>
            </div>
            {!skillsLoaded ? (
              <div className="flex h-16 items-center justify-center gap-2 rounded border border-[#e0d5c0] bg-[#f5f0e6]/60 text-[11px] text-[#a8987e]">
                <Loader2 size={13} className="animate-spin" /> 正在读取技能库…
              </div>
            ) : skills.length === 0 ? (
              <div className="flex h-16 items-center justify-center rounded border border-[#e0d5c0] bg-[#f5f0e6]/60 text-[11px] text-[#a8987e]">
                未发现技能库，将使用通用市场分析模式
              </div>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto rounded border border-[#e0d5c0] bg-[#f5f0e6]/60 p-1.5">
                {skills.map((s) => {
                  const checked = selectedSkills.includes(s.name);
                  return (
                    <label
                      key={s.slug}
                      onClick={(e) => e.stopPropagation()}
                      className={`flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 transition-colors ${
                        checked ? "bg-[#4a6b3f]/10" : "hover:bg-[#ede4d4]"
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 h-3.5 w-3.5 accent-[#4a6b3f]"
                        checked={checked}
                        disabled={!!submitting}
                        onChange={() => toggleSkill(s.name)}
                      />
                      <span className="min-w-0">
                        <span className={`block text-[12px] font-medium ${checked ? "text-[#4a6b3f]" : "text-[#6b5b3e]"}`}>
                          {s.name}
                        </span>
                        <span className="block truncate text-[10px] text-[#a8987e]">{s.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
            </>
          ) : (
            <>
              {/* 网关状态条 */}
              <div className="flex items-center gap-2 rounded border border-[#e0d5c0] bg-[#f5f0e6]/60 px-3 py-2 text-[11px]">
                <span className={`h-2 w-2 rounded-full ${thsInfo == null ? "bg-[#c9b99a]" : thsInfo.gatewayAlive ? "bg-[#4a6b3f]" : "bg-[#b8533a]"}`} />
                <span>
                  THS 数据网关 {thsInfo == null ? "检测中…" : thsInfo.gatewayAlive ? "在线" : "离线"}
                </span>
                <span className="ml-auto">账号 {thsInfo?.configured ? "已配置" : "未配置"}</span>
              </div>

              {/* 同花顺账号 */}
              <div>
                <label className="mb-1 flex items-center gap-1 text-[12px] font-semibold text-[#8b7a5e]">
                  同花顺账号
                  {!thsInfo?.configured && <span className="rounded bg-[#b8533a]/15 px-1 text-[10px] text-[#b8533a]">必填</span>}
                </label>
                <input
                  type="text"
                  value={thsUsername}
                  disabled={!!submitting}
                  onChange={(e) => { setThsUsername(e.target.value); setThsError(null); }}
                  placeholder="请输入同花顺账号"
                  className="w-full rounded border border-[#e0d5c0] bg-[#f5f0e6] px-3 py-2 text-[13px] text-[#6b5b3e] outline-none transition-colors placeholder:text-[#c9b99a] focus:border-[#d4943a]/70"
                />
              </div>

              {/* 密码 */}
              <div>
                <label className="mb-1 flex items-center gap-1 text-[12px] font-semibold text-[#8b7a5e]">
                  密码
                  {!thsInfo?.configured && <span className="rounded bg-[#b8533a]/15 px-1 text-[10px] text-[#b8533a]">必填</span>}
                </label>
                <input
                  type="password"
                  value={thsPassword}
                  disabled={!!submitting}
                  onChange={(e) => { setThsPassword(e.target.value); setThsError(null); }}
                  placeholder={thsInfo?.configured ? "已配置，留空保持不变" : "请输入同花顺登录密码"}
                  className="w-full rounded border border-[#e0d5c0] bg-[#f5f0e6] px-3 py-2 text-[13px] text-[#6b5b3e] outline-none transition-colors placeholder:text-[#c9b99a] focus:border-[#d4943a]/70"
                />
              </div>

              {/* MAC 地址 */}
              <div>
                <label className="mb-1 block text-[12px] font-semibold text-[#8b7a5e]">MAC 地址</label>
                <input
                  type="text"
                  value={thsMac}
                  disabled={!!submitting}
                  onChange={(e) => { setThsMac(e.target.value); setThsError(null); }}
                  placeholder="如 FC:9D:05:26:42:EF"
                  className="w-full rounded border border-[#e0d5c0] bg-[#f5f0e6] px-3 py-2 text-[13px] text-[#6b5b3e] outline-none transition-colors placeholder:text-[#c9b99a] focus:border-[#d4943a]/70"
                />
              </div>

              {/* 同花顺客户端路径(hexin.exe): 供自选股卡片「唤起同花顺」按钮使用 */}
              <div>
                <label className="mb-1 block text-[12px] font-semibold text-[#8b7a5e]">同花顺客户端路径 (hexin.exe)</label>
                <input
                  type="text"
                  value={thsHexinExe}
                  disabled={!!submitting}
                  onChange={(e) => { setThsHexinExe(e.target.value); setThsError(null); }}
                  placeholder="如 D:\同花顺\hexin.exe（留空用默认路径）"
                  className="w-full rounded border border-[#e0d5c0] bg-[#f5f0e6] px-3 py-2 text-[13px] text-[#6b5b3e] outline-none transition-colors placeholder:text-[#c9b99a] focus:border-[#d4943a]/70"
                />
                <p className="mt-1 text-[10px] text-[#a8987e]">
                  用于自选股卡片「唤起同花顺」按钮；留空时使用默认路径 D:\同花顺\hexin.exe。
                </p>
              </div>

              {thsError && <p className="text-[11px] text-[#b8533a]">{thsError}</p>}

              <p className="text-[10px] text-[#a8987e]">
                账号凭据仅保存于本机 server/ths-account.json，供 THS 数据网关连接使用，密码不会回传前端。
              </p>
            </>
          )}

          {submitError && (
            <div className="rounded border border-[#b8533a]/40 bg-[#b8533a]/10 px-3 py-2 text-[12px] text-[#b8533a]">
              {submitError}
            </div>
          )}

          {saved && (
            <div className="flex items-center gap-1.5 rounded border border-[#4a6b3f]/40 bg-[#4a6b3f]/10 px-3 py-2 text-[12px] font-medium text-[#4a6b3f]">
              <CheckCircle2 size={14} /> 配置已保存成功
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <footer className="flex shrink-0 items-center gap-2 border-t border-[#e0d5c0] bg-[#f5f0e6]/60 px-4 py-3">
          <button
            type="button"
            disabled={!!submitting || saved}
            onClick={handleSave}
            title={
              tab === "config"
                ? "保存当前配置：将所选技能与模型持久化保存到本机，供「启动 AI 综合分析」使用"
                : "保存同花顺账号配置并热重连 THS 数据网关"
            }
            className="flex items-center gap-1.5 rounded border border-[#4a6b3f]/60 bg-[#4a6b3f] px-5 py-2 text-[13px] font-bold text-[#faf6ee] shadow-sm transition-colors hover:bg-[#3d5a35] hover:shadow disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 size={13} className="animate-spin" /> 保存中
              </>
            ) : saved ? (
              <>
                <CheckCircle2 size={13} /> 已保存
              </>
            ) : (
              <>
                <CheckCircle2 size={13} /> 保存配置
              </>
            )}
          </button>
          <span className="ml-auto text-[10px] text-[#a8987e]">
            {tab === "config"
              ? "保存后请前往主面板点击「启动 AI 综合分析」"
              : "保存后将立即生效并重连 THS 数据网关"}
          </span>
        </footer>
      </div>
    </div>,
    document.body
  );
}