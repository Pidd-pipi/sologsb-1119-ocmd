import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useSupplyStore } from '../stores/supplyStore';
import { usePrepProgress } from '../hooks/usePrepProgress';
import { ProcedureTimeline } from '../components/common/ProcedureTimeline';
import { MeasureField } from '../components/common/MeasureField';
import { STEP_FIELD_MAP, STEP_TYPES, type StepType } from '../types/procedure';
import { SPECIMEN_STATUSES, type SpecimenStatus } from '../types/specimen';
import { isLowStock } from '../types/supply';
import { makeSketchDataUrl, type PrepPhoto } from '../types/photo';
import { newId } from '../utils/id';
import { ConcurrencyError, type EntityConflict } from '../utils/concurrency';

interface MaterialRow {
  key: string;
  lotId: string;
  qty: number;
}

let materialRowSeq = 0;
const newMaterialRow = (): MaterialRow => ({
  key: `mrow_${Date.now()}_${(materialRowSeq += 1)}`,
  lotId: '',
  qty: 1,
});

/** /procedures/new 新建工序节点：工序、领用批次、标本状态在同一事务里一次确认 */
export default function ProcedureForm() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const specimens = useSpecimenStore((s) => s.items);
  const lots = useSupplyStore((s) => s.items);
  const submitProcedure = useProcedureStore((s) => s.submitProcedure);
  const finish = useProcedureStore((s) => s.finish);
  const rollback = useProcedureStore((s) => s.rollback);

  const [specimenId, setSpecimenId] = useState(params.get('specimenId') ?? specimens[0]?.id ?? '');
  const [stepType, setStepType] = useState<StepType>('清修');
  const [nodeName, setNodeName] = useState('');
  const [seq, setSeq] = useState(1);
  const [tools, setTools] = useState<string[]>([]);
  const [abrasive, setAbrasive] = useState('');
  const [adhesive, setAdhesive] = useState('');
  const [adhesiveConc, setAdhesiveConc] = useState(5);
  const [durationMin, setDurationMin] = useState(60);
  const [tempC, setTempC] = useState(22);
  const [rh, setRh] = useState(50);
  const [operator, setOperator] = useState('');
  const [withPhotos, setWithPhotos] = useState(true);
  const [materialRows, setMaterialRows] = useState<MaterialRow[]>([]);
  const [targetStatus, setTargetStatus] = useState<SpecimenStatus | ''>('');

  const [error, setError] = useState('');
  /** 乐观锁/库存冲突：逐项列出差异，不写入；内容保留可刷新基线后重试 */
  const [conflicts, setConflicts] = useState<EntityConflict[]>([]);
  const [toast, setToast] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /**
   * 打开页面时的基线：标本版本 + 各领用批次版本。
   * 保存时原样带回；别处一改，当前数据与基线版本对不上即判旧。
   */
  const [baseline, setBaseline] = useState<{ specimenVersion: number; lotVersions: Record<string, number> }>({
    specimenVersion: 0,
    lotVersions: {},
  });
  /** 已锁定基线的标本 id（初始进入 / 手动切换时锁定，跨页重载不改基线） */
  const baselineSpecimenRef = useRef('');

  const progress = usePrepProgress(specimenId || undefined);
  const fieldMap = STEP_FIELD_MAP[stepType];
  const nextSeq = progress.list.length === 0 ? 1 : Math.max(...progress.list.map((it) => it.seq)) + 1;

  const specimen = useMemo(() => specimens.find((it) => it.id === specimenId), [specimens, specimenId]);

  // 首次进入或切换标本时，锁定"打开时"的标本版本；跨标签页重载只更新展示、不改基线
  useEffect(() => {
    if (!specimenId || baselineSpecimenRef.current === specimenId) return;
    const current = specimens.find((it) => it.id === specimenId);
    if (!current) return;
    baselineSpecimenRef.current = specimenId;
    setBaseline({ specimenVersion: current.version, lotVersions: {} });
    setTargetStatus(current.status);
  }, [specimenId, specimens]);

  /** 选择实际领用批次时，记录该批次此刻的版本作为基线 */
  const pickLot = (rowKey: string, lotId: string) => {
    setMaterialRows((rows) => rows.map((r) => (r.key === rowKey ? { ...r, lotId } : r)));
    setConflicts([]);
    setError('');
    if (!lotId) return;
    const lot = lots.find((it) => it.id === lotId);
    if (lot) {
      setBaseline((b) =>
        b.lotVersions[lotId] === undefined
          ? { ...b, lotVersions: { ...b.lotVersions, [lotId]: lot.version } }
          : b,
      );
    }
  };

  /** 以数据库当前结果刷新基线（重试前）：表单填写内容全部保留 */
  const refreshBaseline = () => {
    const currentSpecimen = useSpecimenStore.getState().items.find((it) => it.id === specimenId);
    const lotVersions: Record<string, number> = {};
    for (const row of materialRows) {
      if (!row.lotId) continue;
      const lot = useSupplyStore.getState().items.find((it) => it.id === row.lotId);
      if (lot) lotVersions[row.lotId] = lot.version;
    }
    setBaseline({
      specimenVersion: currentSpecimen?.version ?? baseline.specimenVersion,
      lotVersions,
    });
    setConflicts([]);
    setError('');
    setToast('已载入最新版本，可在原内容上直接重试');
  };

  /** 当前数据相对基线是否已被别处改动（旧版本立即失效提示） */
  const staleSpecimen = !!specimen && specimen.version !== baseline.specimenVersion;
  const staleLotIds = materialRows
    .filter((r) => r.lotId && baseline.lotVersions[r.lotId] !== undefined)
    .filter((r) => {
      const lot = lots.find((it) => it.id === r.lotId);
      return lot && lot.version !== baseline.lotVersions[r.lotId];
    })
    .map((r) => r.lotId);

  const selectedRows = materialRows.filter((r) => r.lotId);
  const duplicateLot = selectedRows.some(
    (r, idx) => selectedRows.findIndex((x) => x.lotId === r.lotId) !== idx,
  );

  const submit = async () => {
    if (!specimenId) {
      setError('请先选择标本');
      return;
    }
    if (!nodeName.trim()) {
      setError('节点名称必填');
      return;
    }
    if (!operator.trim()) {
      setError('责任人必填');
      return;
    }
    const used = progress.list.map((it) => it.seq);
    if (used.includes(seq)) {
      setError(`序号 ${seq} 已被占用，请改用 ${nextSeq}`);
      return;
    }
    if (seq > nextSeq) {
      setError(`序号跳号：当前最大序号为 ${Math.max(0, nextSeq - 1)}，新节点必须用 ${nextSeq}`);
      return;
    }
    if (!Number.isFinite(adhesiveConc) || adhesiveConc < 0 || adhesiveConc > 100) {
      setError('胶液浓度需在 0 ~ 100 % 之间');
      return;
    }
    if (duplicateLot) {
      setError('同一材料批次请勿重复选择，可合并为一条并累加数量');
      return;
    }
    for (const row of selectedRows) {
      const lot = lots.find((it) => it.id === row.lotId);
      if (!lot) continue;
      if (row.qty <= 0) {
        setError(`批次 ${lot.lotNo} 的领用数量需大于 0`);
        return;
      }
      if (row.qty > lot.qty) {
        setError(`批次 ${lot.lotNo} 现存仅 ${lot.qty} ${lot.unit}，不够领用 ${row.qty}`);
        return;
      }
    }

    setSubmitting(true);
    setConflicts([]);
    setError('');
    const startedAt = Date.now();
    const photos: PrepPhoto[] =
      withPhotos && specimen
        ? [
            {
              id: newId('pho'),
              specimenId,
              procedureId: '',
              stage: 'before',
              caption: `${nodeName.trim()} · 修复前（${specimen.specimenNo}）`,
              dataUrl: makeSketchDataUrl(`修复前 · ${specimen.specimenNo}`, '#6b5844'),
              capturedAt: startedAt,
            },
            {
              id: newId('pho'),
              specimenId,
              procedureId: '',
              stage: 'after',
              caption: `${nodeName.trim()} · 修复后（${specimen.specimenNo}）`,
              dataUrl: makeSketchDataUrl(`修复后 · ${specimen.specimenNo}`, '#3f5a4a'),
              capturedAt: startedAt + 1,
            },
          ]
        : [];

    try {
      const record = await submitProcedure({
        baseline,
        targetStatus: targetStatus || undefined,
        photos,
        draft: {
          specimenId,
          stepType,
          nodeName: nodeName.trim(),
          seq,
          tools,
          abrasive,
          adhesive: fieldMap.adhesives.length > 0 ? adhesive : '',
          adhesiveConc: fieldMap.needConc ? adhesiveConc : 0,
          durationMin,
          tempC,
          rh,
          photoBeforeIds: photos.filter((p) => p.stage === 'before').map((p) => p.id),
          photoAfterIds: photos.filter((p) => p.stage === 'after').map((p) => p.id),
          operator: operator.trim(),
          startedAt,
          state: 'pending',
          materials: selectedRows.map((r) => ({ lotId: r.lotId, qty: r.qty })),
        },
      });

      setToast(`已确认工序 #${seq} ${stepType} · ${record.nodeName}`);
      // 成功后清空可再录入下一条；基线刷新为最新版本
      setNodeName('');
      setTools([]);
      setMaterialRows([]);
      const createdSpecimen = useSpecimenStore.getState().items.find((it) => it.id === specimenId);
      setBaseline({
        specimenVersion: createdSpecimen?.version ?? baseline.specimenVersion,
        lotVersions: {},
      });
      setSeq(seq + 1);
    } catch (e) {
      if (e instanceof ConcurrencyError) {
        // 旧版本失效：列出差异、整笔未写入，填写内容原样保留
        setConflicts(e.conflicts);
        setError('保存失败：下列对象已被别处改动，本次内容未写入。可核对差异后「载入最新版本并重试」。');
      } else {
        setError(e instanceof Error ? e.message : '保存失败，请重试');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <Typography variant="h5" fontWeight={700}>
          新建工序节点
        </Typography>
        <Chip size="small" variant="outlined" label={`建议序号 ${nextSeq}`} />
        <Chip size="small" variant="outlined" label={`现有节点 ${progress.total} 个`} />
        {specimen ? (
          <Chip
            size="small"
            data-testid="specimen-baseline"
            color={staleSpecimen ? 'warning' : 'default'}
            variant={staleSpecimen ? 'filled' : 'outlined'}
            label={`标本基线 v${baseline.specimenVersion}${staleSpecimen ? `（已变 v${specimen.version}）` : ''}`}
          />
        ) : null}
        <Box sx={{ flex: 1 }} />
        <Button onClick={() => navigate(`/specimens/${specimenId}`)} disabled={!specimenId}>
          查看标本详情
        </Button>
      </Stack>

      {(staleSpecimen || staleLotIds.length > 0 || conflicts.length > 0) ? (
        <Alert
          severity={conflicts.length > 0 ? 'error' : 'warning'}
          data-testid="stale-banner"
          action={
            <Button color="inherit" size="small" startIcon={<RefreshIcon />} onClick={refreshBaseline}>
              载入最新版本并重试
            </Button>
          }
        >
          {conflicts.length > 0
            ? '刚才的确认未写入：你打开页面后，标本或材料批次已在别处被改动。'
            : '本页打开后，相关对象已在别处被改动，旧版本保存时将被拒绝。'}
          {staleSpecimen ? ` 标本状态现为「${specimen?.status}」。` : ''}
          {staleLotIds.length > 0
            ? ` 批次 ${staleLotIds
                .map((id) => lots.find((l) => l.id === id)?.lotNo)
                .filter(Boolean)
                .join('、')} 的库存有变化。`
            : ''}
        </Alert>
      ) : null}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 420px' }, gap: 2 }}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1.5}>
            {error ? <Alert severity="error" data-testid="procedure-error">{error}</Alert> : null}

            {conflicts.length > 0 ? (
              <Paper variant="outlined" sx={{ p: 1.5, borderColor: 'error.main' }} data-testid="conflict-panel">
                <Typography variant="subtitle2" color="error" gutterBottom>
                  差异明细（系统未写入任何内容）
                </Typography>
                <Stack spacing={1}>
                  {conflicts.map((c, ci) => (
                    <Box key={`${c.kind}-${c.id}-${ci}`}>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                        <Chip size="small" label={c.kind === 'specimen' ? '标本' : c.kind === 'supply' ? '材料批次' : '工序'} />
                        <Typography variant="body2" fontWeight={700}>
                          {c.title}
                        </Typography>
                        <Chip
                          size="small"
                          color="error"
                          variant="outlined"
                          label={`版本 v${c.expectedVersion} → v${c.actualVersion}`}
                        />
                      </Stack>
                      <Box sx={{ pl: 1, mt: 0.5 }}>
                        {c.fields.map((f, fi) => (
                          <Stack
                            key={fi}
                            direction="row"
                            spacing={1}
                            sx={{ typography: 'body2' }}
                            flexWrap="wrap"
                          >
                            <Typography variant="body2" sx={{ minWidth: 72 }} color="text.secondary">
                              {f.label}：
                            </Typography>
                            <Chip size="small" variant="outlined" label={`本页 ${f.expected}`} />
                            <Typography variant="body2">→</Typography>
                            <Chip size="small" color="success" label={`当前 ${f.actual}`} />
                          </Stack>
                        ))}
                      </Box>
                    </Box>
                  ))}
                </Stack>
              </Paper>
            ) : null}

            <TextField
              select
              size="small"
              label="标本"
              value={specimenId}
              onChange={(e) => {
                const next = e.target.value;
                setSpecimenId(next);
                setSeq(1);
                setConflicts([]);
                setError('');
                setMaterialRows([]);
                const nextSpecimen = useSpecimenStore.getState().items.find((it) => it.id === next);
                if (nextSpecimen) {
                  // 手动切换即重新锁定该标本的基线
                  baselineSpecimenRef.current = next;
                  setBaseline({ specimenVersion: nextSpecimen.version, lotVersions: {} });
                  setTargetStatus(nextSpecimen.status);
                }
              }}
            >
              {specimens.map((it) => (
                <MenuItem key={it.id} value={it.id}>
                  {it.specimenNo} · {it.taxon}
                </MenuItem>
              ))}
            </TextField>

            <Stack direction="row" spacing={1.5}>
              <TextField
                select
                size="small"
                fullWidth
                label="工序类型"
                value={stepType}
                onChange={(e) => {
                  const next = e.target.value as StepType;
                  setStepType(next);
                  setTools([]);
                  setAbrasive('');
                  setAdhesive('');
                }}
              >
                {STEP_TYPES.map((t) => (
                  <MenuItem key={t} value={t}>
                    {t}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                size="small"
                fullWidth
                label="节点名称"
                required
                value={nodeName}
                onChange={(e) => setNodeName(e.target.value)}
              />
              <Box sx={{ width: 120 }}>
                <MeasureField
                  label="序号"
                  unit="seq"
                  min={1}
                  max={999}
                  step={1}
                  value={seq}
                  onChange={setSeq}
                  hint={`不得跳号，建议 ${nextSeq}`}
                />
              </Box>
            </Stack>

            {fieldMap.tools.length > 0 ? (
              <TextField
                select
                size="small"
                label="使用工具"
                SelectProps={{ multiple: true }}
                value={tools}
                onChange={(e) => {
                  const v = e.target.value;
                  setTools(typeof v === 'string' ? v.split(',') : v);
                }}
                helperText="气动笔 / 剔针 / 超声波 等，可多选"
              >
                {fieldMap.tools.map((t) => (
                  <MenuItem key={t} value={t}>
                    {t}
                  </MenuItem>
                ))}
              </TextField>
            ) : (
              <Alert severity="info">该工序类型无需工具清单</Alert>
            )}

            {fieldMap.abrasives.length > 0 ? (
              <TextField
                select
                size="small"
                label="磨料目数"
                value={abrasive}
                onChange={(e) => setAbrasive(e.target.value)}
              >
                <MenuItem value="">不适用</MenuItem>
                {fieldMap.abrasives.map((a) => (
                  <MenuItem key={a} value={a}>
                    {a}
                  </MenuItem>
                ))}
              </TextField>
            ) : null}

            {fieldMap.adhesives.length > 0 ? (
              <Stack direction="row" spacing={1.5}>
                <TextField
                  select
                  size="small"
                  fullWidth
                  label="胶种"
                  value={adhesive}
                  onChange={(e) => setAdhesive(e.target.value)}
                >
                  <MenuItem value="">未选定</MenuItem>
                  {fieldMap.adhesives.map((a) => (
                    <MenuItem key={a} value={a}>
                      {a}
                    </MenuItem>
                  ))}
                </TextField>
                {fieldMap.needConc ? (
                  <Box sx={{ flex: 1 }}>
                    <MeasureField
                      label="胶液浓度"
                      unit="%"
                      min={0}
                      max={100}
                      step={0.5}
                      value={adhesiveConc}
                      onChange={setAdhesiveConc}
                    />
                  </Box>
                ) : null}
              </Stack>
            ) : null}

            {/* 实际领用：选批次 + 数量，随工序在同一事务扣库存 */}
            <Divider textAlign="left">
              <Chip size="small" label="实际领用批次 / 数量" />
            </Divider>
            <Stack spacing={1}>
              {materialRows.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  本节点暂不领用材料；如有领用，请添加并选择实际批次。
                </Typography>
              ) : null}
              {materialRows.map((row) => {
                const lot = lots.find((it) => it.id === row.lotId);
                const lotStale =
                  !!lot &&
                  baseline.lotVersions[row.lotId] !== undefined &&
                  lot.version !== baseline.lotVersions[row.lotId];
                return (
                  <Stack key={row.key} direction="row" spacing={1.5} alignItems="center">
                    <TextField
                      select
                      size="small"
                      label="领用批次"
                      value={row.lotId}
                      onChange={(e) => pickLot(row.key, e.target.value)}
                      sx={{ flex: 2 }}
                      error={lotStale}
                      helperText={
                        lot
                          ? `${lot.kind} · 批号 ${lot.lotNo} · 现存 ${lot.qty} ${lot.unit}${
                              isLowStock(lot) ? '（低量）' : ''
                            }${lotStale ? ' · 本页打开后已被改动' : ''}`
                          : ' '
                      }
                    >
                      {lots.map((l) => (
                        <MenuItem key={l.id} value={l.id} disabled={l.qty <= 0}>
                          {l.name} · {l.lotNo}（现存 {l.qty} {l.unit}）
                        </MenuItem>
                      ))}
                    </TextField>
                    <Box sx={{ flex: 1, minWidth: 140 }}>
                      <MeasureField
                        label="领用数量"
                        unit={lot?.unit ?? ''}
                        min={0}
                        max={lot ? Math.max(lot.qty, 1) : 9999}
                        step={1}
                        value={row.qty}
                        onChange={(v) => {
                          setMaterialRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, qty: v } : r)));
                          setConflicts([]);
                        }}
                      />
                    </Box>
                    <IconButton
                      aria-label="删除该领用"
                      onClick={() => {
                        setMaterialRows((rs) => rs.filter((r) => r.key !== row.key));
                        setConflicts([]);
                      }}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                );
              })}
              <Box>
                <Button
                  size="small"
                  startIcon={<AddIcon />}
                  onClick={() => setMaterialRows((rs) => [...rs, newMaterialRow()])}
                >
                  添加领用批次
                </Button>
              </Box>
            </Stack>

            <Divider textAlign="left">
              <Chip size="small" label="环境与责任人" />
            </Divider>
            <Stack direction="row" spacing={1.5}>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="耗时"
                  unit="min"
                  min={1}
                  max={1440}
                  step={1}
                  value={durationMin}
                  onChange={setDurationMin}
                />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField label="环境温度" unit="℃" min={-10} max={60} step={0.5} value={tempC} onChange={setTempC} />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField label="相对湿度" unit="%" min={0} max={100} step={1} value={rh} onChange={setRh} />
              </Box>
            </Stack>

            <TextField
              size="small"
              label="责任人"
              required
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
            />

            {/* 标本状态随本次一并确认：带标本版本，旧版本提交会被拒绝 */}
            <TextField
              select
              size="small"
              label="确认后标本状态"
              value={targetStatus}
              onChange={(e) => setTargetStatus(e.target.value as SpecimenStatus)}
              helperText={
                specimen
                  ? `当前「${specimen.status}」（v${specimen.version}）；状态与工序、领用料在同一事务内一次确认`
                  : ' '
              }
            >
              {SPECIMEN_STATUSES.map((s) => (
                <MenuItem key={s} value={s}>
                  {s}
                </MenuItem>
              ))}
            </TextField>

            <FormControlLabel
              control={<Checkbox checked={withPhotos} onChange={(e) => setWithPhotos(e.target.checked)} />}
              label="同时挂接修复前 / 修复后留痕影像（本地生成）"
            />

            <Stack direction="row" spacing={1}>
              <Button variant="contained" onClick={submit} disabled={submitting} data-testid="save-procedure">
                {submitting ? '确认中…' : '保存节点（一次确认工序/领用料/状态）'}
              </Button>
              {conflicts.length > 0 ? (
                <Button
                  variant="outlined"
                  color="warning"
                  startIcon={<RefreshIcon />}
                  onClick={refreshBaseline}
                  data-testid="retry-procedure"
                >
                  载入最新版本并重试
                </Button>
              ) : null}
              <Button
                onClick={() => {
                  navigate('/procedures/new');
                }}
              >
                清空重填
              </Button>
            </Stack>
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            该标本现有工序
          </Typography>
          {specimen ? (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {specimen.specimenNo} · 完成度 {progress.percent}% · 待办{' '}
              {progress.current ? `#${progress.current.seq} ${progress.current.nodeName}` : '无'}
            </Typography>
          ) : null}
          <ProcedureTimeline
            items={progress.list}
            onFinish={async (pid, expectedVersion) => {
              try {
                await finish(pid, expectedVersion);
                setToast('节点已完成');
              } catch (e) {
                setToast(e instanceof Error ? e.message : '完成失败');
              }
            }}
            onRollback={async (pid, expectedVersion) => {
              try {
                await rollback(pid, expectedVersion);
                setToast('节点已回退，领用材料已按记录退回');
              } catch (e) {
                setToast(e instanceof Error ? e.message : '回退失败');
              }
            }}
          />
        </Paper>
      </Box>

      <Snackbar open={!!toast} autoHideDuration={2600} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
