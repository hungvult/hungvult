#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

const CONTENT_DIR = path.resolve(process.cwd(), 'content');
const OUTPUT_FILE = path.resolve(process.cwd(), 'public', 'graph-data.json');
const LOWER_SNAKE_CASE_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const args = process.argv.slice(2);

function patternToRegex(pattern) {
  const p = pattern.trim();
  if (!p || p.startsWith('#')) return null;

  const regexLiteralMatch = p.match(/^\/(.+)\/([a-z]*)$/);
  if (regexLiteralMatch) {
    try {
      return { re: new RegExp(regexLiteralMatch[1], regexLiteralMatch[2]), isNegative: false };
    } catch {
      // Fall through to glob parser
    }
  }

  const isNegative = p.startsWith('!');
  const cleanP = isNegative ? p.slice(1) : p;

  let regexStr = '^';
  let i = 0;
  const len = cleanP.length;

  while (i < len) {
    const c = cleanP[i];
    if (c === '*') {
      if (cleanP[i + 1] === '*') {
        regexStr += '.*';
        i += 2;
        if (cleanP[i] === '/') i++;
      } else {
        regexStr += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      regexStr += '[^/]';
      i++;
    } else if (c === '.') {
      regexStr += '\\.';
      i++;
    } else if (c === '/') {
      regexStr += '\\/';
      i++;
    } else if ('+()[]{}|^$\\'.includes(c)) {
      regexStr += '\\' + c;
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }
  regexStr += '$';

  try {
    return { re: new RegExp(regexStr, 'i'), isNegative };
  } catch {
    return null;
  }
}

function loadIgnoreRules() {
  const rawPatterns = [];
  const customIgnoreFileIdx = args.indexOf('--ignore-file');
  const ignoreFilePath = customIgnoreFileIdx !== -1 && args[customIgnoreFileIdx + 1]
    ? path.resolve(process.cwd(), args[customIgnoreFileIdx + 1])
    : path.resolve(process.cwd(), '.graphignore');

  if (fs.existsSync(ignoreFilePath)) {
    const lines = fs.readFileSync(ignoreFilePath, 'utf8').split(/\r?\n/);
    rawPatterns.push(...lines);
  }

  for (let idx = 0; idx < args.length; idx++) {
    if (args[idx] === '--ignore' && args[idx + 1]) {
      rawPatterns.push(args[idx + 1]);
      idx++;
    }
  }

  const compiled = [];
  for (const raw of rawPatterns) {
    const parsed = patternToRegex(raw);
    if (parsed) compiled.push(parsed);
  }
  return compiled;
}

const IGNORE_RULES = loadIgnoreRules();

function isIgnored(filename, relPath) {
  if (IGNORE_RULES.length === 0) return false;
  let ignored = false;
  const basenameNoExt = filename.replace(/\.md$/i, '');

  for (const { re, isNegative } of IGNORE_RULES) {
    if (re.test(filename) || re.test(basenameNoExt) || re.test(relPath)) {
      ignored = !isNegative;
    }
  }
  return ignored;
}

function collectMarkdownFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(CONTENT_DIR, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (isIgnored(entry.name, relPath)) continue;
      collectMarkdownFiles(fullPath, acc);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      if (isIgnored(entry.name, relPath)) continue;
      acc.push(fullPath);
    }
  }
  return acc;
}

function normalizeSlug(raw) {
  return String(raw)
    .trim()
    .replace(/\\/g, '/')
    .replace(/\.md$/i, '')
    .split('/')
    .pop();
}

function formatTag(rawTag, filePath) {
  const normalized = String(rawTag)
    .trim()
    .toLowerCase()
    .replace(/[\/\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  if (!normalized || !LOWER_SNAKE_CASE_RE.test(normalized)) {
    throw new Error(
      `[GraphBuildError] Invalid tag "${rawTag}" in ${filePath}. Tags must conform to lower_snake_case.`
    );
  }
  return normalized;
}

function generateGraphData() {
  const files = collectMarkdownFiles(CONTENT_DIR);
  if (files.length === 0) {
    if (fs.existsSync(OUTPUT_FILE)) {
      console.log(`[generate-graph] Strategy A active: ${OUTPUT_FILE} already exists. Skipping content scan.`);
      return;
    }
    console.warn(`[generate-graph] Warning: No markdown files found in ${CONTENT_DIR} and no ${OUTPUT_FILE} found.`);
  }

  const nodeMap = new Map();
  const parentAssignments = new Map(); // childId -> Set<parentId>

  for (const absPath of files) {
    const relPath = path.relative(CONTENT_DIR, absPath).replace(/\\/g, '/');
    const id = path.basename(absPath, '.md');

    if (nodeMap.has(id)) {
      throw new Error(
        `[GraphBuildError] Duplicate note ID "${id}" found at "${relPath}" and "${nodeMap.get(id).path}".`
      );
    }

    const rawContent = fs.readFileSync(absPath, 'utf8');
    const { data } = matter(rawContent);

    // Validate single parent constraint in frontmatter
    if (Array.isArray(data.parent)) {
      throw new Error(
        `[GraphBuildError] Directed Forest violation in "${relPath}": "parent" cannot be an array (${JSON.stringify(data.parent)}). Each node may have at most 1 parent.`
      );
    }

    let parentId = null;
    if (data.parent !== undefined && data.parent !== null && String(data.parent).trim() !== '') {
      const rawParent = String(data.parent).trim();
      if (rawParent.includes(',')) {
        throw new Error(
          `[GraphBuildError] Directed Forest violation in "${relPath}": Multiple parents specified ("${rawParent}").`
        );
      }
      parentId = normalizeSlug(rawParent);
      if (parentId === id) {
        throw new Error(
          `[GraphBuildError] Self-loop detected in "${relPath}": node "${id}" cannot be its own parent.`
        );
      }

      if (!parentAssignments.has(id)) {
        parentAssignments.set(id, new Set());
      }
      parentAssignments.get(id).add(parentId);
    }

    // Also validate optional `children` frontmatter if present to prevent >1 in-degree
    if (Array.isArray(data.children)) {
      for (const rawChild of data.children) {
        const childId = normalizeSlug(rawChild);
        if (!parentAssignments.has(childId)) {
          parentAssignments.set(childId, new Set());
        }
        parentAssignments.get(childId).add(id);
      }
    }

    const rawTags = Array.isArray(data.tags)
      ? data.tags
      : data.tags
        ? [data.tags]
        : [];
    const tags = Array.from(new Set(rawTags.map((t) => formatTag(t, relPath))));

    nodeMap.set(id, {
      id,
      title: data.title ? String(data.title).trim() : id,
      path: `/notes/${relPath.replace(/\.md$/i, '')}`,
      parentId,
      depth: 0,
      childrenIds: [],
      tags,
    });
  }

  // Enforce in-degree <= 1 across all parent assignments
  for (const [childId, parents] of parentAssignments.entries()) {
    if (parents.size > 1) {
      throw new Error(
        `[GraphBuildError] Directed Forest violation: Node "${childId}" is assigned multiple parents: [${Array.from(parents).join(', ')}]. Every node must have in-degree <= 1.`
      );
    }
    const [singleParent] = parents;
    const childNode = nodeMap.get(childId);
    if (!childNode) {
      throw new Error(
        `[GraphBuildError] Dangling child reference: "${childId}" referenced by parent "${singleParent}" does not exist.`
      );
    }
    if (!nodeMap.has(singleParent)) {
      throw new Error(
        `[GraphBuildError] Missing parent node: "${childId}" declares parent "${singleParent}", which does not exist in ${CONTENT_DIR}.`
      );
    }
    childNode.parentId = singleParent;
  }

  // Verify existence of all declared parentIds
  for (const node of nodeMap.values()) {
    if (node.parentId && !nodeMap.has(node.parentId)) {
      throw new Error(
        `[GraphBuildError] Missing parent node: "${node.id}" declares parent "${node.parentId}", which does not exist in ${CONTENT_DIR}.`
      );
    }
  }

  // Cycle detection via 3-color DFS along parent pointers
  // 0 = unvisited, 1 = visiting (on current stack), 2 = visited (verified acyclic)
  const visitState = new Map();
  for (const startId of nodeMap.keys()) {
    if ((visitState.get(startId) ?? 0) !== 0) continue;

    const chain = [];
    const onStack = new Set();
    let currId = startId;

    while (currId !== null) {
      if (onStack.has(currId)) {
        const cycleStartIdx = chain.indexOf(currId);
        const cycleNodes = [...chain.slice(cycleStartIdx), currId].reverse();
        throw new Error(
          `[GraphBuildError] Circular dependency detected: ${cycleNodes.join(' -> ')}`
        );
      }
      if ((visitState.get(currId) ?? 0) === 2) break;

      visitState.set(currId, 1);
      chain.push(currId);
      onStack.add(currId);

      const currNode = nodeMap.get(currId);
      currId = currNode ? currNode.parentId : null;
    }

    for (const id of chain) {
      visitState.set(id, 2);
    }
  }

  // Populate childrenIds and links
  const links = [];
  for (const node of nodeMap.values()) {
    if (node.parentId) {
      const parentNode = nodeMap.get(node.parentId);
      parentNode.childrenIds.push(node.id);
      links.push({
        source: node.parentId,
        target: node.id,
      });
    }
  }

  // Sort children deterministically
  for (const node of nodeMap.values()) {
    node.childrenIds.sort((a, b) => a.localeCompare(b));
  }

  // Compute node depth (roots have depth = 0)
  const depthCache = new Map();
  function computeDepth(nodeId) {
    if (depthCache.has(nodeId)) return depthCache.get(nodeId);
    const node = nodeMap.get(nodeId);
    if (!node || node.parentId === null) {
      depthCache.set(nodeId, 0);
      return 0;
    }
    const depth = computeDepth(node.parentId) + 1;
    depthCache.set(nodeId, depth);
    return depth;
  }

  for (const node of nodeMap.values()) {
    node.depth = computeDepth(node.id);
  }

  // Build nested tree structure for collapsible Sidebar File Explorer
  function buildTreeNode(nodeId) {
    const node = nodeMap.get(nodeId);
    return {
      id: node.id,
      title: node.title,
      path: node.path,
      depth: node.depth,
      tags: node.tags,
      children: node.childrenIds.map(buildTreeNode),
    };
  }

  const nodes = Array.from(nodeMap.values()).sort((a, b) => a.id.localeCompare(b.id));
  const roots = nodes
    .filter((n) => n.parentId === null)
    .map((rootNode) => buildTreeNode(rootNode.id));

  const payload = {
    nodes,
    links,
    roots,
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  console.log(
    `[generate-graph] Generated ${nodes.length} nodes, ${links.length} links, ${roots.length} roots -> ${OUTPUT_FILE}`
  );
}

generateGraphData();
