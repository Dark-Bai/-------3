/**
 * Philia AI - 技能列表本地读取(多「大 skill」自动发现)
 *
 * 技能库根目录 `skills/` 下每个子文件夹 = 一个大 skill(主题, 如 短线龙头 / 趋势波段)。
 * 支持两种结构(与 server/philia-ai.cjs 同构):
 *  - 经典结构(如 短线龙头): <slug>/SKILL.md, 技能项 = 文件内 "## X、名称" 小节;
 *  - 知识库结构(如 趋势波段): <slug>/<子目录>/SKILL.md + references/*.md,
 *    技能项 = references 下每个 md 文件。
 * 这里通过 Vite `import.meta.glob` 在构建/开发期自动收集全部 skills 子目录下的
 * md 文件(?raw)并本地解析, 从而:
 *  - 完全免除网络请求, 不再受仪表盘高频轮询占满的 6 路并发队列影响(技能列表即时可用)
 *  - 与后端 loadSkills/parseSkillGroup 同构解析, 保证名称与后端一致
 *  - 不新增任何第三方依赖(vite/client 原生支持 import.meta.glob + ?raw)
 *
 * 新增大 skill: 只需在 skills/ 下新建文件夹并放入 SKILL.md
 * (front-matter `name` 字段为中文显示名, 缺省用目录名), 本文件无需任何改动。
 */
import type { PhiliaSkill } from "./api";

/** 自动收集 skills/ 下全部 md 文件(目录名作 slug) */
const modules = import.meta.glob("../../skills/*/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as unknown as Record<string, string>;

interface GroupSource {
  slug: string;
  name: string;
  main: string;
  refs: { name: string; content: string; full?: string }[];
}

/** 大 skill 列表: 目录名作 slug, front-matter name 作显示名(与后端 loadSkillGroups 同构) */
const SKILL_GROUPS: GroupSource[] = (() => {
  const bySlug = new Map<string, { path: string; md: string }[]>();
  for (const [p, md] of Object.entries(modules)) {
    const slug = /skills\/([^/]+)\//.exec(p)?.[1];
    if (!slug) continue;
    const arr = bySlug.get(slug) || [];
    arr.push({ path: p, md });
    bySlug.set(slug, arr);
  }
  return Array.from(bySlug.keys())
    .sort()
    .map((slug) => {
      const files = bySlug.get(slug)!;
      // 主文件 = front-matter 开头的 SKILL.md; 技能项 = references/ 下的 md
      const main = files.find((f) => f.md.trimStart().startsWith("---"));
      // references/full/ 子目录 = 独立因子注入的「详版」(仅用于单项 chars/展示, 不计入全览)
      const fullByBase = new Map<string, string>();
      for (const f of files) {
        const fm = /\/references\/full\/([^/]+)\.md$/.exec(f.path);
        if (fm) fullByBase.set(fm[1], f.md);
      }
      // 技能项 = references/ 根目录直接 md(精版); 单项注入/标注用 full 同名详版(存在时)
      const refs = files
        .filter((f) => f !== main && /\/references\/[^/]+\.md$/.test(f.path))
        .map((f) => {
          const base = f.path.split("/").pop()!.replace(/\.md$/, "");
          return {
            name: base.replace(/^\d+[_\s]*/, "").trim() || base,
            content: f.md,
            full: fullByBase.get(base) ?? f.md,
          };
        });
      const name = (/^---\n[\s\S]*?^name:\s*(.+?)\s*$/m.exec(main?.md ?? "")?.[1]?.trim() || slug).replace(/^["'\s]+|["'\s]+$/g, "");
      return { slug, name, main: main?.md ?? "", refs };
    });
})();

/** 解析单个大 skill 为可选技能项(与后端 parseSkillGroup 同构) */
function parseSkills(g: GroupSource): PhiliaSkill[] {
  let docDesc = "";
  const fm = g.main.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    const d = fm[1].match(/description:\s*"(.+?)"/);
    if (d) docDesc = d[1];
  }
  const skills: PhiliaSkill[] = [];
  // 1) 知识库结构: references/ 下每个 md 文件 = 一个技能项
  if (g.refs.length) {
    for (const r of g.refs) {
      const title = r.full.match(/^# (.+)$/m)?.[1]?.trim();
      skills.push({
        name: r.name,
        description: title || `${g.name}方法论模块`,
        slug: `${g.slug}:${r.name}`,
        group: g.slug,
        groupName: g.name,
        isAll: false,
        chars: r.full.length,
      });
    }
  } else {
    // 2) 经典小节结构: "## X、名称（标签）"
    const parts = g.main.split(/^## /m);
    for (const part of parts) {
      const firstLine = part.split("\n")[0].trim();
      const m = firstLine.match(/^[一二三四五六七八九十]+、(.+?)(?:[（(](.+?)[）)])?$/);
      if (!m) continue;
      let name = m[1].trim();
      let tag = (m[2] || "").trim();
      const sep = name.indexOf("·");
      if (sep > 0) {
        if (!tag) tag = name.slice(sep + 1).trim();
        name = name.slice(0, sep).trim();
      }
      skills.push({
        name,
        description: tag || "交易思维",
        slug: `${g.slug}:${name}`,
        group: g.slug,
        groupName: g.name,
        isAll: false,
        chars: part.trim().length,
      });
    }
  }
  // 全览选项(短线龙头沿用历史名称以兼容已保存配置); chars 与后端注入长度一致(main + 每个 ref 前加 "\n\n")
  if (skills.length) {
    const allName = g.slug === "duanxian-longtou" ? "七大游资全览" : `${g.name}全览`;
    const allChars = g.refs.length
      ? g.main.length + g.refs.reduce((a, r) => a + r.content.length + 2, 0)
      : g.main.length;
    skills.unshift({
      name: allName,
      description: docDesc || `${g.name}交易思维合集`,
      slug: `${g.slug}:all`,
      group: g.slug,
      groupName: g.name,
      isAll: true,
      chars: allChars,
    });
  }
  return skills;
}

/** 构建期从本地技能文件自动解析出的全部技能列表(同步、即时可用) */
export const PHILIA_SKILLS: PhiliaSkill[] = SKILL_GROUPS.flatMap(parseSkills);

/** 大 skill 列表(slug → 显示名), 供「技能选择」旁的下拉按钮切换 */
export const PHILIA_GROUPS: { slug: string; name: string }[] = SKILL_GROUPS.map((g) => ({ slug: g.slug, name: g.name }));
