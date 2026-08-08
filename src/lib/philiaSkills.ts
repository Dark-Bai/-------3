/**
 * Philia AI - 技能列表本地读取(多「大 skill」自动发现)
 *
 * 技能库根目录 `skills/` 下每个子文件夹 = 一个大 skill(主题, 如 短线龙头 / 趋势波段),
 * 内含 SKILL.md。这里通过 Vite `import.meta.glob` 在构建/开发期自动收集全部
 * skills 各子目录下的 SKILL.md(?raw)并本地解析, 从而:
 *  - 完全免除网络请求, 不再受仪表盘高频轮询占满的 6 路并发队列影响(技能列表即时可用)
 *  - 与 server/philia-ai.cjs 的 loadSkills/parseSkillFile 同构解析, 保证名称与后端一致
 *  - 不新增任何第三方依赖(vite/client 原生支持 import.meta.glob + ?raw)
 *
 * 新增大 skill: 只需在 skills/ 下新建文件夹并放入 SKILL.md
 * (front-matter `name` 字段为中文显示名, 缺省用目录名), 本文件无需任何改动。
 */
import type { PhiliaSkill } from "./api";

/** 自动收集 skills/ 下全部大 skill 的 SKILL.md 原文(目录名作 slug) */
const modules = import.meta.glob("../../skills/*/SKILL.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as unknown as Record<string, string>;

/** 大 skill 列表: slug(目录名) + 显示名(front-matter name) + 原文(与后端 loadSkillGroups 同构) */
const SKILL_GROUPS: { slug: string; name: string; md: string }[] = Object.entries(modules)
  .map(([p, md]) => {
    const slug = /skills\/([^/]+)\/SKILL\.md$/.exec(p)?.[1] ?? "";
    const name = /^---\n[\s\S]*?^name:\s*(.+?)\s*$/m.exec(md)?.[1]?.trim() || slug;
    return { slug, name, md };
  })
  .sort((a, b) => a.slug.localeCompare(b.slug));

/** 解析单个大 skill 的 SKILL.md, 提取 front-matter 与各技能小节(与后端 parseSkillFile 同构) */
function parseSkills(text: string, groupSlug: string, groupName: string): PhiliaSkill[] {
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
    skills.push({
      name,
      description: tag || "交易思维",
      slug: `${groupSlug}:${name}`,
      group: groupSlug,
      groupName,
      isAll: false,
    });
  }
  // 提供"全览"选项(短线龙头沿用历史名称以兼容已保存配置)
  if (skills.length) {
    const allName = groupSlug === "duanxian-longtou" ? "七大游资全览" : `${groupName}全览`;
    skills.unshift({
      name: allName,
      description: docDesc || `${groupName}交易思维合集`,
      slug: `${groupSlug}:all`,
      group: groupSlug,
      groupName,
      isAll: true,
    });
  }
  return skills;
}

/** 构建期从本地技能文件自动解析出的全部技能列表(同步、即时可用) */
export const PHILIA_SKILLS: PhiliaSkill[] = SKILL_GROUPS.flatMap((g) => parseSkills(g.md, g.slug, g.name));

/** 大 skill 列表(slug → 显示名), 供「技能选择」旁的下拉按钮切换 */
export const PHILIA_GROUPS: { slug: string; name: string }[] = SKILL_GROUPS.map((g) => ({ slug: g.slug, name: g.name }));
