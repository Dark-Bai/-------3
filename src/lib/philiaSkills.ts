/**
 * Philia AI - 技能列表本地读取
 *
 * 技能定义存放在项目根目录 `youzi-qijie-jinghua/SKILL.md`。
 * 这里通过 Vite 原生 `?raw` 在构建/开发期直接读取该文件并本地解析,
 * 从而:
 *  - 完全免除网络请求, 不再受仪表盘高频轮询占满的 6 路并发队列影响(技能列表即时可用)
 *  - 与 `server/philia-ai.cjs` 的 loadSkills 同构解析, 保证名称与后端一致
 *  - 不新增任何第三方依赖(vite/client 原生支持 *?raw)
 */
import skillMd from "../../youzi-qijie-jinghua/SKILL.md?raw";
import type { PhiliaSkill } from "./api";

/** 解析 SKILL.md, 提取 front-matter 与各「游资」小节(与 server/philia-ai.cjs loadSkills 同构) */
function parseSkills(text: string): PhiliaSkill[] {
  let docDesc = "";
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    const d = fm[1].match(/description:\s*"(.+?)"/);
    if (d) docDesc = d[1];
  }
  const skills: PhiliaSkill[] = [];
  const parts = text.split(/^## /m);
  for (const part of parts) {
    const firstLine = part.split("\n")[0].trim();
    const m = firstLine.match(/^[一二三四五六七八九十]、(.+?)(?:[（(](.+?)[）)])?$/);
    if (!m) continue;
    let name = m[1].trim();
    let tag = (m[2] || "").trim();
    // 兼容 "名称 · 标签" 形式(如 "炒股养家 · 情绪流交易系统")
    const sep = name.indexOf("·");
    if (sep > 0) {
      if (!tag) tag = name.slice(sep + 1).trim();
      name = name.slice(0, sep).trim();
    }
    skills.push({ name, description: tag || "游资交易思维", slug: `yg-${name}` });
  }
  // 提供"全览"选项
  if (skills.length) {
    skills.unshift({ name: "七大游资全览", description: docDesc || "七大顶级游资交易思维精华合集", slug: "all" });
  }
  return skills;
}

/** 构建期从本地技能文件直接解析出的技能列表(同步、即时可用) */
export const PHILIA_SKILLS: PhiliaSkill[] = parseSkills(skillMd);