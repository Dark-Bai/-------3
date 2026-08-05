/**
 * Philia AI 综合分析 - 配置模态窗口
 *
 * 输入项:
 *  - API Key(强制, sk-or- 格式校验 + 实时校验)
 *  - AI 模型下拉(默认 deepseek-v4-flash 正式版)
 *  - 技能多选(读取 youzi-qijie-jinghua 目录)
 * 操作:
 *  - 开始分析: 保存配置并触发综合分析
 *  - 仅保存设置: 只保存配置, 不触发分析
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, Sparkles, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { usePhilia } from "./PhiliaContext";
import { api, type PhiliaModel } from "@/lib/api";

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
  const { config, skills, skillsLoaded, models, openModal, closeModal, saveSettings, runAnalysis } = usePhilia();

  /* 表单状态 */
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  /* 校验状态 */
  const [keyValidating, setKeyValidating] = useState(false);
  const [keyValidated, setKeyValidated] = useState<"valid" | "invalid" | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  /* 提交状态 */
  const [submitting, setSubmitting] = useState<"saving" | "analyzing" | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  /* 合并模型列表: 后端优先, 空则用兜底 */
  const modelOptions = useMemo(() => {
    if (models && models.length > 0) return models;
    return DEFAULT_MODELS;
  }, [models]);

  /* 打开时回填已有配置 */
  useEffect(() => {
    if (!openModal) return;
    setModel(config?.model || DEFAULT_MODELS.find((m) => m.default)?.id || modelOptions[0]?.id || "");
    setSelectedSkills(config?.skills ? [...config.skills] : []);
    setKey("");
    setKeyValidated(null);
    setKeyError(null);
    setSubmitError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openModal, config]);

  /* ESC 关闭 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeModal]);

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

  /** 开始分析: 保存配置并触发分析 */
  async function handleAnalyze() {
    if (needKey && !key.trim()) {
      setKeyError("请先填写 API Key");
      setKeyValidated("invalid");
      return;
    }
    if (needKey && !keyFormatValid(key.trim())) {
      setKeyError("API Key 格式不正确");
      setKeyValidated("invalid");
      return;
    }
    setSubmitError(null);
    setSubmitting("analyzing");
    try {
      await saveSettings({ key: key.trim() || undefined, model, skills: selectedSkills });
      await runAnalysis(model, selectedSkills, false);
      closeModal();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "分析失败，请重试");
    } finally {
      setSubmitting(null);
    }
  }

  /** 仅保存设置 */
  async function handleSave() {
    if (needKey && !key.trim()) {
      setKeyError("请先填写 API Key");
      setKeyValidated("invalid");
      return;
    }
    setSubmitError(null);
    setSubmitting("saving");
    try {
      await saveSettings({ key: key.trim() || undefined, model, skills: selectedSkills });
      closeModal();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSubmitting(null);
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
            PHILIA · 游资视角综合分析
          </h2>
          <div className="ml-auto flex items-center gap-1">
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

        {/* 内容区 */}
        <div className="max-h-[70vh] min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-[#6b5b3e]">
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

          {submitError && (
            <div className="rounded border border-[#b8533a]/40 bg-[#b8533a]/10 px-3 py-2 text-[12px] text-[#b8533a]">
              {submitError}
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <footer className="flex shrink-0 items-center gap-2 border-t border-[#e0d5c0] bg-[#f5f0e6]/60 px-4 py-3">
          <button
            type="button"
            disabled={!!submitting}
            onClick={handleSave}
            className="rounded border border-[#e0d5c0] bg-[#ede4d4] px-3 py-1.5 text-[12px] font-medium text-[#8b7a5e] transition-colors hover:border-[#d4943a]/60 hover:text-[#6b5b3e] disabled:opacity-50"
          >
            {submitting === "saving" ? (
              <span className="flex items-center gap-1.5">
                <Loader2 size={13} className="animate-spin" /> 保存中
              </span>
            ) : (
              "仅保存设置"
            )}
          </button>
          <button
            type="button"
            disabled={!!submitting}
            onClick={handleAnalyze}
            className="flex items-center gap-1.5 rounded bg-[#4a6b3f] px-4 py-1.5 text-[12px] font-medium text-[#f5f0e6] transition-colors hover:bg-[#3d5a35] disabled:opacity-50"
          >
            {submitting === "analyzing" ? (
              <>
                <Loader2 size={13} className="animate-spin" /> 分析中
              </>
            ) : (
              <>
                <Sparkles size={13} /> 开始分析
              </>
            )}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}