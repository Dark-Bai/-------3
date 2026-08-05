/**
 * Philia AI 综合分析 - 全局状态管理
 *
 * 统一管理:
 *  - 配置(API Key / 模型 / 技能多选), 由后端加密存储, 前端仅持有掩码
 *  - 静态数据(技能列表 / 可用模型列表)
 *  - 分析状态(进行中 / 结果 / 错误)与降频缓存命中标记
 *  - 配置模态窗口开关
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  api,
  type PhiliaConfig,
  type PhiliaSkill,
  type PhiliaModel,
  type PhiliaAnalysis,
} from "@/lib/api";
import { PHILIA_SKILLS } from "@/lib/philiaSkills";

interface PhiliaState {
  /* 配置 */
  config: PhiliaConfig | null;
  configLoaded: boolean;
  /* 静态数据 */
  skills: PhiliaSkill[];
  skillsLoaded: boolean;
  models: PhiliaModel[];
  /* 分析 */
  analyzing: boolean;
  analysis: PhiliaAnalysis | null;
  analysisError: string | null;
  /* 弹窗 */
  modalOpen: boolean;
  /* actions */
  openModal: () => void;
  closeModal: () => void;
  refreshConfig: () => Promise<void>;
  saveSettings: (cfg: { key?: string; model: string; skills: string[] }) => Promise<void>;
  runAnalysis: (model: string, skills: string[], force?: boolean) => Promise<void>;
}

const PhiliaContext = createContext<PhiliaState | null>(null);

export function PhiliaProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<PhiliaConfig | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [models, setModels] = useState<PhiliaModel[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<PhiliaAnalysis | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  // 防止组件卸载后 setState(异步请求回环守护)
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** 加载配置(不含明文 key) */
  const refreshConfig = useCallback(async () => {
    try {
      const c = await api.philia.getConfig();
      if (mounted.current) {
        setConfig(c);
        setConfigLoaded(true);
      }
    } catch {
      if (mounted.current) setConfigLoaded(true);
    }
  }, []);

  /** 加载可用模型列表 */
  const loadModels = useCallback(async () => {
    try {
      const m = await api.philia.models();
      if (mounted.current) setModels(m || []);
    } catch {
      /* 后端未就绪时保持空, 前端提供默认模型选项兜底 */
    }
  }, []);

  /** 冷启动恢复: 从后端历史拉取最近一次分析结果, 避免刷新后回到"启动"配置页 */
  const loadLatestAnalysis = useCallback(async () => {
    try {
      const list = await api.philia.history();
      if (mounted.current && list && list.length > 0) setAnalysis(list[0]);
    } catch {
      /* 无历史/后端未就绪时保持空, 正常展示"启动"入口 */
    }
  }, []);

  useEffect(() => {
    refreshConfig();
    loadModels();
    loadLatestAnalysis();
  }, [refreshConfig, loadModels, loadLatestAnalysis]);

  const openModal = useCallback(() => setModalOpen(true), []);
  const closeModal = useCallback(() => setModalOpen(false), []);

  /** 保存配置(含 key 时一并加密存储) */
  const saveSettings = useCallback(
    async (cfg: { key?: string; model: string; skills: string[] }) => {
      const c = await api.philia.saveConfig(cfg);
      if (mounted.current) setConfig(c);
    },
    []
  );

  /** 触发综合分析(后端降频缓存, force 绕过) */
  const runAnalysis = useCallback(
    async (model: string, skills: string[], force = false) => {
      setAnalyzing(true);
      setAnalysisError(null);
      try {
        const r = await api.philia.analyze({ model, skills, force });
        if (mounted.current) setAnalysis(r);
      } catch (e) {
        if (mounted.current) {
          setAnalysisError(e instanceof Error ? e.message : "分析失败");
          throw e;
        }
      } finally {
        if (mounted.current) setAnalyzing(false);
      }
    },
    []
  );

  return (
    <PhiliaContext.Provider
      value={{
        config,
        configLoaded,
        skills: PHILIA_SKILLS,
        skillsLoaded: true,
        models,
        analyzing,
        analysis,
        analysisError,
        modalOpen,
        openModal,
        closeModal,
        refreshConfig,
        saveSettings,
        runAnalysis,
      }}
    >
      {children}
    </PhiliaContext.Provider>
  );
}

export function usePhilia(): PhiliaState {
  const ctx = useContext(PhiliaContext);
  if (!ctx) throw new Error("usePhilia 必须在 <PhiliaProvider> 内使用");
  return ctx;
}