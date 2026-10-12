import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, File, Folder } from 'lucide-react';

export interface TreeNode {
  id: string;
  label: string;
  /** 节点图标（缺省时按有无子级显示文件夹/文件图标） */
  icon?: ReactNode;
  children?: TreeNode[];
  /** 是否默认展开 */
  defaultExpanded?: boolean;
}

export interface TreeProps {
  nodes: TreeNode[];
  /** 点击叶子节点时触发（有子级的节点仅展开/折叠） */
  onSelect?: (node: TreeNode) => void;
  className?: string;
}

/** 可折叠树（用于占位的文档结构 / 云文件） */
export function Tree({ nodes, onSelect, className }: TreeProps) {
  return (
    <div role="tree" className={`select-none text-ui ${className ?? ''}`}>
      {nodes.map((node) => (
        <TreeItem key={node.id} node={node} depth={0} onSelect={onSelect} />
      ))}
    </div>
  );
}

function TreeItem({
  node,
  depth,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  onSelect?: (node: TreeNode) => void;
}) {
  const [expanded, setExpanded] = useState(node.defaultExpanded ?? false);
  const children = node.children ?? [];
  const hasChildren = children.length > 0;

  return (
    <div role="none">
      <div
        role="treeitem"
        aria-expanded={hasChildren ? expanded : undefined}
        className="flex h-7 cursor-pointer items-center gap-1 rounded-sm hover:bg-hover"
        style={{ paddingLeft: depth * 16 + 4 }}
        onClick={() => {
          if (hasChildren) {
            setExpanded((value) => !value);
          } else {
            onSelect?.(node);
          }
        }}
      >
        {hasChildren ? (
          expanded ? (
            <ChevronDown size={14} className="shrink-0 text-muted" aria-hidden="true" />
          ) : (
            <ChevronRight size={14} className="shrink-0 text-muted" aria-hidden="true" />
          )
        ) : (
          <span className="w-3.5 shrink-0" aria-hidden="true" />
        )}
        {node.icon ??
          (hasChildren ? (
            <Folder size={14} className="shrink-0 text-muted" aria-hidden="true" />
          ) : (
            <File size={14} className="shrink-0 text-muted" aria-hidden="true" />
          ))}
        <span className="truncate text-fg">{node.label}</span>
      </div>
      {hasChildren && expanded ? (
        <div role="group">
          {children.map((child) => (
            <TreeItem key={child.id} node={child} depth={depth + 1} onSelect={onSelect} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
