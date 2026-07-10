export type KnowledgeFrameworkRequirement = {
  group: string;
  terms: string[];
};

export type KnowledgeFrameworkSource = {
  title: string;
  content?: string;
  relatedPath?: string;
};

export function buildKnowledgeFrameworkChecklist(references: KnowledgeFrameworkSource[]) {
  return references.flatMap((reference) => {
    const requirements = extractKnowledgeFrameworkRequirements(reference.content ?? "");
    if (!requirements.length) return [];
    return [{
      title: reference.title,
      relatedPath: reference.relatedPath,
      requirements,
    }];
  });
}

export function extractKnowledgeFrameworkRequirements(content: string): KnowledgeFrameworkRequirement[] {
  const lines = content.split(/\r?\n/);
  const results: KnowledgeFrameworkRequirement[] = [];
  for (let index = 0; index < lines.length - 2; index += 1) {
    const headers = markdownTableCells(lines[index]);
    if (headers.length < 2 || !/^\s*\|?\s*:?-{3}/.test(lines[index + 1] ?? "")) continue;
    const groupColumn = headers.findIndex((header) => /分组|状态|页面|模块|区域/.test(header));
    const requirementColumn = headers.findIndex((header) =>
      !/按需|可选|条件/.test(header) && /必须|字段|控件|展示内容|必须展示/.test(header),
    );
    if (groupColumn < 0 || requirementColumn < 0) continue;
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const cells = markdownTableCells(lines[rowIndex]);
      if (cells.length !== headers.length) break;
      const group = cleanKnowledgeTerm(cells[groupColumn]);
      const terms = cells[requirementColumn]
        .split(/、|，|；|;|<br\s*\/?>/i)
        .map(cleanKnowledgeTerm)
        .filter((term) => term.length >= 2 && term.length <= 24);
      if (group && terms.length) results.push({ group, terms: [...new Set(terms)] });
    }
  }
  return results;
}

function markdownTableCells(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function cleanKnowledgeTerm(value: string) {
  return value
    .replace(/[`*_~]/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/^(支持|展示|配置|包括|包含|需要|必须)/, "")
    .trim();
}
