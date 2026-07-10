export function analyzeMarkdown(source) {
  const { lines } = splitSourceLines(source);
  const excludedLines = new Set([
    ...findFrontmatterLines(lines),
    ...findFencedLines(lines),
  ]);
  const tableLines = findTableLines(lines, excludedLines);
  const wikilinks = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (excludedLines.has(lineIndex)) continue;

    for (const link of findWikilinksInLine(lines[lineIndex])) {
      wikilinks.push({
        ...link,
        line: lineIndex + 1,
        column: link.start + 1,
        inTable: tableLines.has(lineIndex),
      });
    }
  }

  const unescapedTableAliasPipes = wikilinks
    .filter((link) => link.inTable && link.aliasSeparator && !link.aliasSeparator.escaped)
    .map((link) => ({
      line: link.line,
      column: link.aliasSeparator.index + 1,
      raw: link.raw,
    }));

  return {
    wikilinks,
    tableLines: [...tableLines].map((lineIndex) => lineIndex + 1),
    unescapedTableAliasPipes,
  };
}

export function escapeTableWikilinkAliases(source) {
  const { lines, endings } = splitSourceLines(source);
  const analysis = analyzeMarkdown(source);
  const replacementsByLine = new Map();

  for (const issue of analysis.unescapedTableAliasPipes) {
    const indexes = replacementsByLine.get(issue.line - 1) ?? [];
    indexes.push(issue.column - 1);
    replacementsByLine.set(issue.line - 1, indexes);
  }

  for (const [lineIndex, indexes] of replacementsByLine) {
    let line = lines[lineIndex];
    for (const index of indexes.sort((a, b) => b - a)) {
      line = `${line.slice(0, index)}\\${line.slice(index)}`;
    }
    lines[lineIndex] = line;
  }

  return {
    content: joinSourceLines(lines, endings),
    replacements: analysis.unescapedTableAliasPipes.length,
    changedLines: [...replacementsByLine.keys()].sort((a, b) => a - b).map((lineIndex) => lineIndex + 1),
  };
}

function splitSourceLines(source) {
  const lines = [];
  const endings = [];
  let start = 0;

  for (const match of source.matchAll(/\r\n|\n/g)) {
    lines.push(source.slice(start, match.index));
    endings.push(match[0]);
    start = match.index + match[0].length;
  }
  lines.push(source.slice(start));
  return { lines, endings };
}

function joinSourceLines(lines, endings) {
  return lines.map((line, index) => `${line}${endings[index] ?? ""}`).join("");
}

function findFrontmatterLines(lines) {
  const frontmatterLines = new Set();
  if (lines[0] !== "---") return frontmatterLines;

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    if (!/^(?:---|\.\.\.)[ \t]*$/.test(lines[lineIndex])) continue;
    for (let index = 0; index <= lineIndex; index += 1) frontmatterLines.add(index);
    break;
  }

  return frontmatterLines;
}

function findFencedLines(lines) {
  const fencedLines = new Set();
  let openFence;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (openFence) {
      fencedLines.add(lineIndex);
      if (isClosingFence(line, openFence)) openFence = undefined;
      continue;
    }

    const fence = parseOpeningFence(line);
    if (fence) {
      openFence = fence;
      fencedLines.add(lineIndex);
    }
  }

  return fencedLines;
}

function parseOpeningFence(line) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return undefined;
  if (match[1][0] === "`" && match[2].includes("`")) return undefined;
  return { marker: match[1][0], length: match[1].length };
}

function isClosingFence(line, fence) {
  const match = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
  return Boolean(match && match[1][0] === fence.marker && match[1].length >= fence.length);
}

function findTableLines(lines, excludedLines) {
  const tableLines = new Set();

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    if (excludedLines.has(lineIndex) || excludedLines.has(lineIndex - 1)) continue;

    const delimiterCells = parseTableDelimiter(lines[lineIndex]);
    const headerCells = splitTableRow(lines[lineIndex - 1]);
    if (!delimiterCells || !headerCells?.length) continue;

    tableLines.add(lineIndex - 1);
    tableLines.add(lineIndex);

    for (let rowIndex = lineIndex + 1; rowIndex < lines.length; rowIndex += 1) {
      if (excludedLines.has(rowIndex) || !splitTableRow(lines[rowIndex])?.length) break;
      tableLines.add(rowIndex);
    }
  }

  return tableLines;
}

function parseTableDelimiter(line) {
  const cells = splitTableRow(line);
  if (!cells?.length) return undefined;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim())) ? cells : undefined;
}

function splitTableRow(line) {
  if (/^(?: {4}|\t)/.test(line)) return undefined;
  const codeRanges = findInlineCodeRanges(line);
  const pipeIndexes = [];

  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "|" || isEscaped(line, index) || isInsideRanges(codeRanges, index)) continue;
    pipeIndexes.push(index);
  }

  if (!pipeIndexes.length) return undefined;

  const cells = [];
  let start = 0;
  for (const index of pipeIndexes) {
    cells.push(line.slice(start, index));
    start = index + 1;
  }
  cells.push(line.slice(start));

  if (!cells[0].trim()) cells.shift();
  if (cells.length && !cells.at(-1).trim()) cells.pop();
  return cells;
}

function findWikilinksInLine(line) {
  const codeRanges = findInlineCodeRanges(line);
  const links = [];

  for (let index = 0; index < line.length - 1; index += 1) {
    const codeRange = rangeContaining(codeRanges, index);
    if (codeRange) {
      index = codeRange.end - 1;
      continue;
    }
    if (line[index] !== "[" || line[index + 1] !== "[" || isEscaped(line, index)) continue;

    const closeIndex = findWikilinkClose(line, index + 2, codeRanges);
    if (closeIndex === -1) continue;
    links.push(parseWikilink(line, index, closeIndex));
    index = closeIndex + 1;
  }

  return links;
}

function findWikilinkClose(line, start, codeRanges) {
  for (let index = start; index < line.length - 1; index += 1) {
    const codeRange = rangeContaining(codeRanges, index);
    if (codeRange) {
      index = codeRange.end - 1;
      continue;
    }
    if (line[index] === "]" && line[index + 1] === "]" && !isEscaped(line, index)) return index;
  }
  return -1;
}

function parseWikilink(line, start, closeIndex) {
  const contentStart = start + 2;
  const content = line.slice(contentStart, closeIndex);
  let aliasSeparator;

  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "|") continue;
    aliasSeparator = {
      escaped: isEscaped(content, index),
      index: contentStart + index,
    };
    break;
  }

  let destination = aliasSeparator
    ? content.slice(0, aliasSeparator.index - contentStart)
    : content;
  if (aliasSeparator?.escaped) destination = destination.slice(0, -1);

  const anchorIndex = findUnescapedCharacter(destination, "#");
  const target = (anchorIndex === -1 ? destination : destination.slice(0, anchorIndex)).trim();
  const anchor = anchorIndex === -1 ? undefined : destination.slice(anchorIndex + 1).trim();
  const alias = aliasSeparator
    ? content.slice(aliasSeparator.index - contentStart + 1).trim()
    : undefined;

  return {
    start,
    end: closeIndex + 2,
    raw: line.slice(start, closeIndex + 2),
    target,
    anchor,
    alias,
    aliasSeparator,
  };
}

function findUnescapedCharacter(value, character) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === character && !isEscaped(value, index)) return index;
  }
  return -1;
}

function findInlineCodeRanges(line) {
  const ranges = [];

  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "`") continue;
    const openerLength = countRun(line, index, "`");
    let cursor = index + openerLength;
    let closeIndex = -1;

    while (cursor < line.length) {
      if (line[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      const closerLength = countRun(line, cursor, "`");
      if (closerLength === openerLength) {
        closeIndex = cursor;
        break;
      }
      cursor += closerLength;
    }

    if (closeIndex === -1) {
      index += openerLength - 1;
      continue;
    }

    const end = closeIndex + openerLength;
    ranges.push({ start: index, end });
    index = end - 1;
  }

  return ranges;
}

function countRun(value, start, character) {
  let end = start;
  while (value[end] === character) end += 1;
  return end - start;
}

function isEscaped(value, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function isInsideRanges(ranges, index) {
  return Boolean(rangeContaining(ranges, index));
}

function rangeContaining(ranges, index) {
  return ranges.find((range) => index >= range.start && index < range.end);
}
