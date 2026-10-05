import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Paper from '@mui/material/Paper';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { VersionDiff } from '../../utils/occ';

export interface ConflictPanelProps {
  /** ConflictError.diffs：打开页面后被别处改动的对象差异 */
  diffs: VersionDiff[];
  /** 用最新版本基线重试（已填写的表单内容保留） */
  onRetryLatest?: () => void;
  /** 仅关闭提示、留在本页继续修改 */
  onDismiss?: () => void;
  retryLabel?: string;
  /** testid */
  testid?: string;
}

/**
 * 乐观锁冲突面板：列出「打开页面时 → 现在」的逐项差异，
 * 明确本次未写入；提供「按最新数据重试」（保留表单内容）。
 */
export function ConflictPanel({
  diffs,
  onRetryLatest,
  onDismiss,
  retryLabel = '按最新数据重试（保留已填内容）',
  testid = 'conflict-panel',
}: ConflictPanelProps) {
  if (diffs.length === 0) return null;
  return (
    <Alert
      severity="warning"
      data-testid={testid}
      sx={{ alignItems: 'flex-start' }}
      action={
        <Stack direction="row" spacing={0.5}>
          {onRetryLatest ? (
            <Button color="inherit" size="small" startIcon={<RefreshIcon />} onClick={onRetryLatest}>
              {retryLabel}
            </Button>
          ) : null}
          {onDismiss ? (
            <Button color="inherit" size="small" onClick={onDismiss}>
              知道了
            </Button>
          ) : null}
        </Stack>
      }
    >
      <AlertTitle>保存未生效：以下对象在你打开页面后已被其它标签页改动（旧版本已失效，本次没有写入）</AlertTitle>
      <Stack spacing={1} sx={{ width: '100%' }}>
        {diffs.map((diff, idx) => (
          <Paper key={`${diff.objectLabel}-${diff.objectKey}-${idx}`} variant="outlined" sx={{ p: 1, bgcolor: 'transparent' }}>
            <strong>
              {diff.objectLabel} {diff.objectKey}
            </strong>
            ：{diff.reason}
            {diff.changes.length > 0 ? (
              <Table size="small" sx={{ mt: 0.5 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>字段</TableCell>
                    <TableCell>打开页面时</TableCell>
                    <TableCell>当前最新</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {diff.changes.map(([field, oldVal, newVal], ci) => (
                    <TableRow key={`${field}-${ci}`}>
                      <TableCell>{field}</TableCell>
                      <TableCell>{oldVal}</TableCell>
                      <TableCell>{newVal}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
          </Paper>
        ))}
      </Stack>
    </Alert>
  );
}

export default ConflictPanel;
