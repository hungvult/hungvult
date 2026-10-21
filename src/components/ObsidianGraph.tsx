import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import ForceGraph2D, {
  ForceGraphMethods,
  NodeObject,
  LinkObject,
} from 'react-force-graph-2d';
import * as d3 from 'd3-force';

export interface GraphNodeData {
  id: string;
  title: string;
  path: string;
  parentId: string | null;
  depth: number;
  childrenIds: string[];
  tags: string[];
}

export interface GraphLinkData {
  source: string | GraphNodeObject;
  target: string | GraphNodeObject;
}

export interface TreeRootNode {
  id: string;
  title: string;
  path: string;
  depth: number;
  tags: string[];
  children: TreeRootNode[];
}

export interface GraphPayload {
  nodes: GraphNodeData[];
  links: GraphLinkData[];
  roots: TreeRootNode[];
}

type GraphNodeObject = NodeObject & GraphNodeData;
type GraphLinkObject = LinkObject & {
  source: string | GraphNodeObject;
  target: string | GraphNodeObject;
};

type DagMode = null | 'td' | 'radialout';

const COLORS = {
  background: '#1e1e1e',
  panelBg: '#252526',
  border: '#333333',
  rootAccent: '#a882ff',
  rootAccentDim: 'rgba(168, 130, 255, 0.15)',
  childNode: '#8b949e',
  childNodeDim: 'rgba(139, 148, 158, 0.15)',
  linkDefault: 'rgba(139, 148, 158, 0.35)',
  linkHighlight: 'rgba(168, 130, 255, 0.85)',
  linkDim: 'rgba(139, 148, 158, 0.15)',
  textDefault: '#dcddde',
  textMuted: '#8b949e',
  textDim: 'rgba(220, 221, 222, 0.15)',
};

function resolveEndpointId(endpoint: string | GraphNodeObject): string {
  return typeof endpoint === 'object' && endpoint !== null ? endpoint.id : String(endpoint);
}

function getNodeRadius(node: GraphNodeData): number {
  const depthFactor = Math.max(3.5, 8.5 - node.depth * 1.35);
  const childBoost = Math.min(4.5, Math.sqrt(node.childrenIds.length) * 1.1);
  return depthFactor + childBoost;
}

interface FileTreeItemProps {
  node: TreeRootNode;
  activeNodeId: string | null;
  onSelectNode: (node: TreeRootNode) => void;
}

const FileTreeItem: React.FC<FileTreeItemProps> = ({
  node,
  activeNodeId,
  onSelectNode,
}) => {
  const [expanded, setExpanded] = useState<boolean>(node.depth < 1);
  const hasChildren = node.children.length > 0;
  const isSelected = activeNodeId === node.id;

  return (
    <li className="select-none">
      <div
        className={`group flex items-center gap-1.5 py-1 px-2 rounded cursor-pointer text-xs transition-colors ${
          isSelected
            ? 'bg-[#a882ff]/20 text-[#a882ff] font-medium'
            : 'text-[#dcddde] hover:bg-white/5'
        }`}
        style={{ paddingLeft: `${node.depth * 12 + 8}px` }}
        onClick={() => onSelectNode(node)}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((prev) => !prev);
            }}
            className="w-4 h-4 flex items-center justify-center text-[#8b949e] hover:text-white"
            aria-label={expanded ? 'Collapse folder' : 'Expand folder'}
          >
            <span
              className={`inline-block transition-transform duration-150 ${
                expanded ? 'rotate-90' : ''
              }`}
            >
              ▸
            </span>
          </button>
        ) : (
          <span className="w-4 h-4 inline-flex items-center justify-center text-[#8b949e]">
            •
          </span>
        )}
        <span className="truncate">{node.title}</span>
        {hasChildren && (
          <span className="ml-auto text-[10px] text-[#8b949e]">
            {node.children.length}
          </span>
        )}
      </div>

      {hasChildren && expanded && (
        <ul className="border-l border-[#333333]/60 ml-3">
          {node.children.map((child) => (
            <FileTreeItem
              key={child.id}
              node={child}
              activeNodeId={activeNodeId}
              onSelectNode={onSelectNode}
            />
          ))}
        </ul>
      )}
    </li>
  );
};

export interface ObsidianGraphProps {
  onNavigate?: (routePath: string, nodeId: string) => void;
}

export const ObsidianGraph: React.FC<ObsidianGraphProps> = ({ onNavigate }) => {
  const graphRef = useRef<ForceGraphMethods<GraphNodeObject, GraphLinkObject> | undefined>(
    undefined
  );
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [graphData, setGraphData] = useState<GraphPayload>({
    nodes: [],
    links: [],
    roots: [],
  });
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [dagMode, setDagMode] = useState<DagMode>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({
    width: 960,
    height: 680,
  });

  // Resolve basePath safely for GitHub Pages
  const baseUrl = useMemo(() => {
    const rawBase = import.meta.env.BASE_URL || '/';
    return rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
  }, []);

  // Fetch pre-built graph JSON
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;

    async function loadGraph() {
      try {
        setLoading(true);
        const response = await fetch(`${baseUrl}graph-data.json`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: Failed to load graph-data.json`);
        }
        const payload: GraphPayload = await response.json();
        if (!cancelled) {
          setGraphData(payload);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadGraph();
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  // Responsive canvas sizing via ResizeObserver
  useEffect(() => {
    if (typeof window === 'undefined' || !containerRef.current) return;
    const el = containerRef.current;

    const updateDimensions = () => {
      const rect = el.getBoundingClientRect();
      setDimensions({
        width: Math.max(300, Math.floor(rect.width)),
        height: Math.max(300, Math.floor(rect.height)),
      });
    };

    updateDimensions();
    const observer = new ResizeObserver(updateDimensions);
    observer.observe(el);
    return () => observer.disconnect();
  }, [sidebarOpen]);

  const nodeLookup = useMemo(() => {
    const map = new Map<string, GraphNodeData>();
    for (const n of graphData.nodes) {
      map.set(n.id, n);
    }
    return map;
  }, [graphData.nodes]);

  // Configure d3 forces so disjoint trees stay centered without drifting away
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg || graphData.nodes.length === 0) return;

    const chargeForce = fg.d3Force('charge') as d3.ForceManyBody<GraphNodeObject> | undefined;
    if (chargeForce) {
      chargeForce.strength(-140).distanceMax(320);
    }

    const linkForce = fg.d3Force('link') as
      | d3.ForceLink<GraphNodeObject, GraphLinkObject>
      | undefined;
    if (linkForce) {
      linkForce.distance((link) => {
        const srcId = resolveEndpointId(link.source);
        const srcNode = nodeLookup.get(srcId);
        return srcNode && srcNode.depth === 0 ? 68 : 46;
      });
    }

    // Center gravity forces pulling trees toward viewport center
    fg.d3Force('x', d3.forceX<GraphNodeObject>(0).strength(0.065));
    fg.d3Force('y', d3.forceY<GraphNodeObject>(0).strength(0.065));
    fg.d3ReheatSimulation();
  }, [graphData, dagMode, nodeLookup]);

  // Compute active highlight sets: hovered node + direct parent + immediate children + connecting links
  const { highlightedNodeIds, highlightedLinkKeys } = useMemo(() => {
    const nodeIds = new Set<string>();
    const linkKeys = new Set<string>();

    if (!hoveredNodeId) {
      return { highlightedNodeIds: nodeIds, highlightedLinkKeys: linkKeys };
    }

    const focusNode = nodeLookup.get(hoveredNodeId);
    if (!focusNode) {
      return { highlightedNodeIds: nodeIds, highlightedLinkKeys: linkKeys };
    }

    nodeIds.add(focusNode.id);

    if (focusNode.parentId) {
      nodeIds.add(focusNode.parentId);
      linkKeys.add(`${focusNode.parentId}->${focusNode.id}`);
    }

    for (const childId of focusNode.childrenIds) {
      nodeIds.add(childId);
      linkKeys.add(`${focusNode.id}->${childId}`);
    }

    return { highlightedNodeIds: nodeIds, highlightedLinkKeys: linkKeys };
  }, [hoveredNodeId, nodeLookup]);

  const navigateToNote = useCallback(
    (routePath: string, nodeId: string) => {
      setSelectedNodeId(nodeId);
      const cleanRoute = routePath.replace(/^\//, '');
      const fullUrl = `${baseUrl}${cleanRoute}`;

      if (onNavigate) {
        onNavigate(fullUrl, nodeId);
      } else if (typeof window !== 'undefined') {
        window.history.pushState({ nodeId }, '', fullUrl);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    },
    [baseUrl, onNavigate]
  );

  const handleTreeSelect = useCallback(
    (treeNode: TreeRootNode) => {
      setSelectedNodeId(treeNode.id);
      const targetGraphNode = graphData.nodes.find((n) => n.id === treeNode.id) as
        | GraphNodeObject
        | undefined;
      if (
        targetGraphNode &&
        typeof targetGraphNode.x === 'number' &&
        typeof targetGraphNode.y === 'number' &&
        graphRef.current
      ) {
        graphRef.current.centerAt(targetGraphNode.x, targetGraphNode.y, 600);
        graphRef.current.zoom(2.2, 600);
      }
      navigateToNote(treeNode.path, treeNode.id);
    },
    [graphData.nodes, navigateToNote]
  );

  // Custom HTML5 Canvas Node Rendering
  const renderNodeCanvas = useCallback(
    (node: GraphNodeObject, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const radius = getNodeRadius(node);
      const isRoot = node.parentId === null;
      const isFilterActive = hoveredNodeId !== null;
      const isHighlighted = !isFilterActive || highlightedNodeIds.has(node.id);
      const isHovered = hoveredNodeId === node.id;
      const isSelected = selectedNodeId === node.id;

      // Outer glow ring on hovered or selected node
      if (isHovered || isSelected) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 3.5 / globalScale, 0, 2 * Math.PI, false);
        ctx.fillStyle = 'rgba(168, 130, 255, 0.28)';
        ctx.fill();
      }

      // Main node circle
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
      if (isRoot) {
        ctx.fillStyle = isHighlighted ? COLORS.rootAccent : COLORS.rootAccentDim;
      } else {
        ctx.fillStyle = isHighlighted ? COLORS.childNode : COLORS.childNodeDim;
      }
      ctx.fill();

      // Crisp border when highlighted during hover
      if (isFilterActive && isHighlighted) {
        ctx.lineWidth = 1.5 / globalScale;
        ctx.strokeStyle = COLORS.rootAccent;
        ctx.stroke();
      }

      // Label visibility rule: show when globalScale > 1.2 or when node is highlighted
      const shouldShowLabel =
        globalScale > 1.2 || (isFilterActive && isHighlighted) || isSelected;

      if (shouldShowLabel) {
        const fontSize = Math.max(10 / globalScale, Math.min(13 / globalScale, 12));
        ctx.font = `${isHovered || isRoot ? '600' : '400'} ${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = isHighlighted ? COLORS.textDefault : COLORS.textDim;
        ctx.fillText(node.title, x, y + radius + 3 / globalScale);
      }
    },
    [hoveredNodeId, highlightedNodeIds, selectedNodeId]
  );

  const getLinkColor = useCallback(
    (link: GraphLinkObject): string => {
      if (!hoveredNodeId) return COLORS.linkDefault;
      const srcId = resolveEndpointId(link.source);
      const tgtId = resolveEndpointId(link.target);
      const key = `${srcId}->${tgtId}`;
      return highlightedLinkKeys.has(key) ? COLORS.linkHighlight : COLORS.linkDim;
    },
    [hoveredNodeId, highlightedLinkKeys]
  );

  const getLinkWidth = useCallback(
    (link: GraphLinkObject): number => {
      if (!hoveredNodeId) return 1.1;
      const srcId = resolveEndpointId(link.source);
      const tgtId = resolveEndpointId(link.target);
      return highlightedLinkKeys.has(`${srcId}->${tgtId}`) ? 2.2 : 0.8;
    },
    [hoveredNodeId, highlightedLinkKeys]
  );

  const filteredRoots = useMemo(() => {
    if (!searchQuery.trim()) return graphData.roots;
    const q = searchQuery.toLowerCase();

    function filterTree(node: TreeRootNode): TreeRootNode | null {
      const matchedChildren = node.children
        .map(filterTree)
        .filter((c): c is TreeRootNode => c !== null);
      const selfMatches =
        node.title.toLowerCase().includes(q) ||
        node.id.toLowerCase().includes(q) ||
        node.tags.some((t) => t.includes(q));

      if (selfMatches || matchedChildren.length > 0) {
        return { ...node, children: matchedChildren };
      }
      return null;
    }

    return graphData.roots
      .map(filterTree)
      .filter((r): r is TreeRootNode => r !== null);
  }, [graphData.roots, searchQuery]);

  if (typeof window === 'undefined') {
    return null;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#1e1e1e] text-[#dcddde]">
      {/* Collapsible File Tree Explorer Sidebar */}
      <aside
        className={`${
          sidebarOpen ? 'w-72 border-r' : 'w-0'
        } transition-all duration-200 bg-[#252526] border-[#333333] flex flex-col shrink-0 overflow-hidden`}
      >
        <div className="p-3 border-b border-[#333333] flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-[#8b949e]">
            Vault Explorer ({graphData.nodes.length})
          </span>
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#a882ff]/15 text-[#a882ff]">
            Directed Forest
          </span>
        </div>

        <div className="p-2 border-b border-[#333333]">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter notes or #tags..."
            className="w-full bg-[#1e1e1e] text-xs text-[#dcddde] placeholder-[#8b949e] px-2.5 py-1.5 rounded border border-[#333333] focus:outline-none focus:border-[#a882ff]"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {filteredRoots.length === 0 ? (
            <p className="text-xs text-[#8b949e] px-2 py-4">No matching notes found.</p>
          ) : (
            <ul className="space-y-0.5">
              {filteredRoots.map((root) => (
                <FileTreeItem
                  key={root.id}
                  node={root}
                  activeNodeId={selectedNodeId}
                  onSelectNode={handleTreeSelect}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* Main Graph Viewport */}
      <main ref={containerRef} className="relative flex-1 h-full overflow-hidden">
        {/* Top-Left Sidebar Toggle & Layout Mode Switcher */}
        <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setSidebarOpen((prev) => !prev)}
            className="px-2.5 py-1.5 rounded text-xs font-medium bg-[#252526]/90 border border-[#333333] text-[#dcddde] hover:border-[#a882ff] transition-colors"
          >
            {sidebarOpen ? 'Hide Explorer' : 'Show Explorer'}
          </button>

          <div className="flex items-center rounded bg-[#252526]/90 border border-[#333333] p-0.5 text-xs">
            {(
              [
                { mode: null, label: 'Free Physics' },
                { mode: 'td', label: 'Top-Down Tree' },
                { mode: 'radialout', label: 'Radial Outward' },
              ] as const
            ).map(({ mode, label }) => {
              const active = dagMode === mode;
              return (
                <button
                  key={String(mode)}
                  type="button"
                  onClick={() => setDagMode(mode)}
                  className={`px-2.5 py-1 rounded transition-colors ${
                    active
                      ? 'bg-[#a882ff] text-[#1e1e1e] font-semibold'
                      : 'text-[#8b949e] hover:text-[#dcddde]'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => graphRef.current?.zoomToFit(400, 48)}
            className="px-2.5 py-1.5 rounded text-xs bg-[#252526]/90 border border-[#333333] text-[#8b949e] hover:text-[#dcddde]"
          >
            Fit View
          </button>
        </div>

        {/* Legend Overlay */}
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-4 px-3 py-1.5 rounded bg-[#252526]/90 border border-[#333333] text-xs text-[#8b949e]">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[#a882ff]" />
            Root (depth 0)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[#8b949e]" />
            Child Node
          </span>
        </div>

        {loading && (
          <div className="flex items-center justify-center h-full text-sm text-[#8b949e]">
            Loading Directed Forest Graph...
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-full text-sm text-red-400 px-4">
            {error}
          </div>
        )}

        {!loading && !error && (
          <ForceGraph2D
            ref={graphRef}
            width={dimensions.width}
            height={dimensions.height}
            graphData={graphData}
            backgroundColor={COLORS.background}
            dagMode={dagMode ?? undefined}
            dagLevelDistance={dagMode ? 65 : undefined}
            nodeId="id"
            nodeRelSize={5}
            nodeCanvasObject={renderNodeCanvas}
            nodePointerAreaPaint={(node, color, ctx) => {
              const r = getNodeRadius(node as GraphNodeData) + 3;
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, 2 * Math.PI, false);
              ctx.fill();
            }}
            linkColor={getLinkColor}
            linkWidth={getLinkWidth}
            linkDirectionalArrowLength={3.5}
            linkDirectionalArrowRelPos={1}
            onNodeHover={(node) => setHoveredNodeId(node ? node.id : null)}
            onNodeClick={(node) => navigateToNote(node.path, node.id)}
            cooldownTicks={120}
            onEngineStop={() => {
              if (!selectedNodeId) {
                graphRef.current?.zoomToFit(400, 48);
              }
            }}
          />
        )}
      </main>
    </div>
  );
};

export default ObsidianGraph;
