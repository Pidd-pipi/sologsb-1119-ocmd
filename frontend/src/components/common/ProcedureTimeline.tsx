import { useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import UndoIcon from '@mui/icons-material/Undo';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { ConflictError } from '../../utils/occ';
import { ConflictPanel } from './ConflictPanel';
import type { PrepProcedure } from '../../types/procedure';

export interface ProcedureTimelineProps {
  items: PrepProcedure[];
  /** 完成节点（收到的 node 带打开页面时的版本） */
  onFinish?: (node: PrepProcedure) => Promise<void> | void;
  /** 回退节点并退料（收到的 node 带打开页面时的版本） */
  onRollback?: (node: PrepProcedure) => Promise<void> | void;
  onOpenPhoto?: (procedureId: string) => void;
}

function fmtTime(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 纵向工序节点流：步骤图标、状态、耗时、环境参数、材料领用/退料折叠区。
 * 被标本详情页、工序录入页消费。
 *
 * 完成/回退均把带版本的整个节点交回上层；若上层事务报冲突，
 * 在节点就地列出差异，可用最新版本重试（时间线由上层缓存刷新后显示结果）。
 */
export function ProcedureTimeline({ items, onFinish, onRollback, onOpenPhoto }: ProcedureTimelineProps) {
  const [expanded, setExpanded] = useState<string | null>(items[0]?.id ?? null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ id: string; diffs: ConflictError['diffs'] } | null>(null);

  if (items.length === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          该标本暂无工序节点，请到「新建工序节点」登记。
        </Typography>
      </Paper>
    );
  }

  const runAction = async (node: PrepProcedure, action: (n: PrepProcedure) => Promise<void> | void) => {
    setBusyId(node.id);
    setConflict(null);
    try {
      await action(node);
      setExpanded((cur) => cur);
    } catch (err) {
      if (err instanceof ConflictError) {
        setConflict({ id: node.id, diffs: err.diffs });
      } else {
        setConflict({
          id: node.id,
          diffs: [
            {
              objectLabel: '操作',
              objectKey: `#${node.seq}`,
              expectedVersion: node.version,
              actualVersion: null,
              changes: [],
              reason: err instanceof Error ? err.message : '操作失败，请重试',
            },
          ],
        });
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Stack spacing={1} data-testid="procedure-timeline">
      {items.map((node, index) => {
        const isDone = node.state === 'done';
        const isRolledback = node.state === 'rolledback';
        const open = expanded === node.id;
        const activeMaterials = node.materials.filter((m) => !m.returnedAt);
        const returnedMaterials = node.materials.filter((m) => m.returnedAt);
        const nodeConflict = conflict?.id === node.id ? conflict.diffs : [];
        return (
          <Box key={node.id} sx={{ display: 'flex', gap: 1.5 }}>
            <Stack alignItems="center" sx={{ pt: 0.5 }}>
              {isDone ? (
                <CheckCircleIcon color="success" fontSize="small" />
              ) : (
                <RadioButtonUncheckedIcon color={isRolledback ? 'error' : 'disabled'} fontSize="small" />
              )}
              {index < items.length - 1 ? (
                <Box sx={{ flex: 1, width: '2px', minHeight: 32, bgcolor: 'divider', my: 0.5 }} />
              ) : null}
            </Stack>
            <Paper variant="outlined" sx={{ p: 1.5, flex: 1, mb: 0.5 }}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <Chip size="small" label={`#${node.seq}`} color="primary" variant="outlined" />
                <Typography variant="subtitle2" fontWeight={700}>
                  {node.stepType} · {node.nodeName}
                </Typography>
                <Chip
                  size="small"
                  label={isDone ? '已完成' : isRolledback ? '已回退' : '待办'}
                  color={isDone ? 'success' : isRolledback ? 'error' : 'default'}
                />
                {node.materials.length > 0 ? (
                  <Chip
                    size="small"
                    variant="outlined"
                    label={
                      returnedMaterials.length === 0
                        ? `领材 ${node.materials.length} 批`
                        : `退材 ${returnedMaterials.length}/${node.materials.length} 批`
                    }
                    color={returnedMaterials.length > 0 ? 'warning' : 'default'}
                  />
                ) : null}
                <Typography variant="caption" color="text.secondary">
                  耗时 {node.durationMin} min · 责任人 {node.operator}
                </Typography>
                <Box sx={{ flex: 1 }} />
                {!isDone && onFinish ? (
                  <Button
                    size="small"
                    variant="contained"
                    disabled={busyId === node.id}
                    onClick={() => runAction(node, onFinish)}
                  >
                    {busyId === node.id ? '确认中…' : '完成节点'}
                  </Button>
                ) : null}
                {isDone && onRollback ? (
                  <Button
                    size="small"
                    color="warning"
                    startIcon={<UndoIcon />}
                    disabled={busyId === node.id}
                    onClick={() => runAction(node, onRollback)}
                  >
                    回退节点
                  </Button>
                ) : null}
                <Tooltip title={open ? '收起环境参数' : '展开环境参数'}>
                  <IconButton size="small" onClick={() => setExpanded(open ? null : node.id)}>
                    <ExpandMoreIcon
                      fontSize="small"
                      sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: '0.2s' }}
                    />
                  </IconButton>
                </Tooltip>
              </Stack>

              {nodeConflict.length > 0 ? (
                <Box sx={{ mt: 1 }}>
                  <ConflictPanel
                    diffs={nodeConflict}
                    retryLabel={isRolledback ? '用最新版本重试完成' : '用最新版本重试'}
                    onRetryLatest={() => {
                      // items 已随跨页广播刷新，这里取该节点最新版本重放同一动作
                      const latest = items.find((it) => it.id === node.id);
                      if (!latest) return;
                      if (latest.state === 'done' && onRollback) void runAction(latest, onRollback);
                      else if (latest.state !== 'done' && onFinish) void runAction(latest, onFinish);
                    }}
                    onDismiss={() => setConflict(null)}
                  />
                </Box>
              ) : null}

              <Collapse in={open} unmountOnExit>
                <Divider sx={{ my: 1 }} />
                <Stack direction="row" spacing={2} flexWrap="wrap" rowGap={0.5}>
                  <Typography variant="body2">工具：{node.tools.length ? node.tools.join('、') : '—'}</Typography>
                  <Typography variant="body2">磨料：{node.abrasive || '—'}</Typography>
                  <Typography variant="body2">
                    胶种：{node.adhesive || '—'}
                    {node.adhesiveConc > 0 ? `（浓度 ${node.adhesiveConc} %）` : ''}
                  </Typography>
                  <Typography variant="body2">
                    环境：{node.tempC} ℃ / RH {node.rh} %
                  </Typography>
                  <Typography variant="body2">开始：{fmtTime(node.startedAt)}</Typography>
                  <Typography variant="body2">结束：{fmtTime(node.finishedAt)}</Typography>
                  <Typography variant="body2">
                    影像：前 {node.photoBeforeIds.length} 张 / 后 {node.photoAfterIds.length} 张
                  </Typography>
                  {onOpenPhoto ? (
                    <Button size="small" onClick={() => onOpenPhoto(node.id)}>
                      查看对照
                    </Button>
                  ) : null}
                </Stack>

                {node.materials.length > 0 ? (
                  <Box sx={{ mt: 1 }}>
                    <Typography variant="body2" fontWeight={700}>
                      领用材料（回退时按记录退回批次）
                    </Typography>
                    <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                      {activeMaterials.map((material) => (
                        <Typography key={material.issueId} variant="body2" color="text.secondary">
                          · {material.name}（批号 {material.lotNo}）领 {material.qty} {material.unit}
                          {isRolledback ? ' · 待核对退料' : ''}
                        </Typography>
                      ))}
                      {returnedMaterials.map((material) => (
                        <Typography key={material.issueId} variant="body2" color="warning.main">
                          · {material.name}（批号 {material.lotNo}）已退回 {material.qty} {material.unit}
                          {material.returnedAt ? `（${fmtTime(material.returnedAt)}）` : ''}
                        </Typography>
                      ))}
                    </Stack>
                  </Box>
                ) : null}
              </Collapse>
            </Paper>
          </Box>
        );
      })}
    </Stack>
  );
}

export default ProcedureTimeline;
