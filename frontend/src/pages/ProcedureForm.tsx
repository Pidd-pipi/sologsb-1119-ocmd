import { useEffect, useMemo, useState } from 'react';
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
import IconButton from '@mui/material/IconButton';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AddIcon from '@mui/icons-material/Add';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useSupplyStore } from '../stores/supplyStore';
import { usePrepProgress } from '../hooks/usePrepProgress';
import { ProcedureTimeline } from '../components/common/ProcedureTimeline';
import { MeasureField } from '../components/common/MeasureField';
import { ConflictPanel } from '../components/common/ConflictPanel';
import { STEP_FIELD_MAP, STEP_TYPES, type StepType } from '../types/procedure';
import { commitProcedure, type MaterialLineInput } from '../services/prepService';
import { ConflictError, diffProcedureTimeline, diffSpecimen, diffLot, type VersionDiff } from '../utils/occ';
import { emitChange } from '../utils/syncBus';
import { SPECIMEN_STATUSES, type Specimen, type SpecimenStatus } from '../types/specimen';
import type { PrepProcedure } from '../types/procedure';
import type { SupplyLot } from '../types/supply';

/** 打开页面/选中标本时记录的版本基线，保存时整体带回 */
interface FormBase {
  specimen: Specimen;
  procedures: PrepProcedure[];
  lots: SupplyLot[];
  at: number;
}

interface MaterialRow {
  lotId: string;
  qty: number;
  /** 选中该批次时看到的版本：基线内的行用打开页面时版本，后加的行用选中时版本 */
  expectedVersion?: number;
}

/** 表单内一条领用行（校验后才提交） */
function draftLines(lines: MaterialRow[]): MaterialLineInput[] {
  return lines
    .filter((line) => line.lotId && line.qty > 0)
    .map((line) => ({ lotId: line.lotId, qty: line.qty, expectedVersion: line.expectedVersion }));
}

/** /procedures/new 新建工序节点：批次/数量领用 + 标本状态一次确认，带版本乐观锁 */
export default function ProcedureForm() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const specimens = useSpecimenStore((s) => s.items);
  const procedures = useProcedureStore((s) => s.items);
  const lots = useSupplyStore((s) => s.items);
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
  const [nextStatus, setNextStatus] = useState<SpecimenStatus | ''>('');
  const [showAllLots, setShowAllLots] = useState(false);
  const [error, setError] = useState('');
  const [conflicts, setConflicts] = useState<VersionDiff[]>([]);
  const [stale, setStale] = useState<VersionDiff[]>([]);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  /** 打开页面时的版本基线（选中标本变化时重建） */
  const [base, setBase] = useState<FormBase | null>(null);

  const specimen = useMemo(() => specimens.find((it) => it.id === specimenId), [specimens, specimenId]);
  const progress = usePrepProgress(specimenId || undefined);
  const fieldMap = STEP_FIELD_MAP[stepType];
  const nextSeq = progress.list.length === 0 ? 1 : Math.max(...progress.list.map((it) => it.seq)) + 1;

  /** 用当前最新数据重建基线（页面打开、切换标本、冲突后「按最新数据重试」时调用） */
  const rebuildBase = (id: string) => {
    // 直接从 store 取最新值，避免闭包拿到 setState 之前的旧列表（自己刚提交后会误判为过期）
    const current = useSpecimenStore.getState().items.find((it) => it.id === id);
    if (!current) {
      setBase(null);
      return;
    }
    setBase({
      specimen: current,
      procedures: useProcedureStore.getState().items.filter((it) => it.specimenId === id),
      lots: useSupplyStore.getState().items,
      at: Date.now(),
    });
    setStale([]);
  };

  // 首次数据就绪或切换标本时，记录打开页面时的版本，并把状态下拉默认到当前状态
  useEffect(() => {
    if (!specimenId || specimens.length === 0) return;
    rebuildBase(specimenId);
    const current = specimens.find((it) => it.id === specimenId);
    setNextStatus(current?.status ?? '');
    // 仅在标本/数据首就绪时执行；表单提交成功后由回调手动重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specimenId, specimens.length]);

  /**
   * 别处一提交（跨标签页广播后本页缓存已重载），立即比对基线：
   * 旧版本判失效、列出差异提示技师，不自动覆盖其正在填写的内容。
   */
  useEffect(() => {
    if (!base || !specimen) return;
    const diffs: VersionDiff[] = [];
    const latestProcedures = procedures.filter((it) => it.specimenId === specimen.id);
    const specimenDiff = diffSpecimen(base.specimen, specimen, specimen.specimenNo);
    if (specimenDiff) diffs.push(specimenDiff);
    diffs.push(...diffProcedureTimeline(base.procedures, latestProcedures));
    for (const line of draftLines(materialRows)) {
      const currentLot = lots.find((lot) => lot.id === line.lotId);
      const expectedVersion = line.expectedVersion ?? base.lots.find((lot) => lot.id === line.lotId)?.version;
      const lotDiff = diffLot(base.lots.find((lot) => lot.id === line.lotId), currentLot, expectedVersion);
      if (lotDiff) diffs.push(lotDiff);
    }
    setStale(diffs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specimens, procedures, lots, base, materialRows]);

  /** 领用批次候选项：默认按磨料/胶种名称匹配当前工序，可切换显示全部在库批次 */
  const lotOptions = useMemo(() => {
    const wantedNames = [abrasive, adhesive].filter(Boolean);
    const inStock = lots.filter((lot) => lot.qty > 0);
    const matched = inStock.filter(
      (lot) =>
        wantedNames.some((name) => lot.name.includes(name) || name.includes(lot.name)) ||
        (stepType === '清修' && lot.kind === '磨料'),
    );
    const pool = matched.length > 0 && !showAllLots ? matched : inStock;
    return pool.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }, [lots, abrasive, adhesive, stepType, showAllLots]);

  const lotById = useMemo(() => new Map(lots.map((lot) => [lot.id, lot])), [lots]);

  /** 切换工序类型时，若当前磨料/胶种能匹配到在库批次，自动带出一行领用 */
  useEffect(() => {
    setMaterialRows((rows) => {
      const remaining = rows.filter((row) => {
        const lot = lotById.get(row.lotId);
        if (!lot) return false;
        const wanted = [abrasive, adhesive].filter(Boolean);
        return (
          showAllLots ||
          wanted.some((name) => lot.name.includes(name) || name.includes(lot.name)) ||
          (stepType === '清修' && lot.kind === '磨料')
        );
      });
      if (remaining.length > 0) return remaining;
      const candidate = lots.find(
        (lot) =>
          lot.qty > 0 &&
          ((abrasive && (lot.name.includes(abrasive) || abrasive.includes(lot.name))) ||
            (adhesive && (lot.name.includes(adhesive) || adhesive.includes(lot.name)))),
      );
      return candidate ? [{ lotId: candidate.id, qty: 1, expectedVersion: candidate.version }] : [];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepType, abrasive, adhesive]);

  const addMaterialRow = () => {
    const first = lotOptions.find((lot) => !materialRows.some((row) => row.lotId === lot.id));
    setMaterialRows((rows) => [...rows, { lotId: first?.id ?? '', qty: 1, expectedVersion: first?.version }]);
  };

  const updateMaterialRow = (index: number, patch: Partial<MaterialRow>) => {
    setMaterialRows((rows) =>
      rows.map((row, i) => {
        if (i !== index) return row;
        // 改选批次时记录「选中时看到的版本」，作为该领用行的乐观锁基线
        if (patch.lotId !== undefined && patch.lotId !== row.lotId) {
          const selected = lotById.get(patch.lotId);
          return { ...row, ...patch, expectedVersion: selected?.version };
        }
        return { ...row, ...patch };
      }),
    );
  };

  const removeMaterialRow = (index: number) => {
    setMaterialRows((rows) => rows.filter((_, i) => i !== index));
  };

  /** 组装事务需要的表单内容 */
  const buildDraft = () => ({
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
    photoBeforeIds: [],
    photoAfterIds: [],
    operator: operator.trim(),
    startedAt: Date.now(),
    state: 'pending' as const,
  });

  const validate = (): string => {
    if (!specimenId) return '请先选择标本';
    if (!nodeName.trim()) return '节点名称必填';
    if (!operator.trim()) return '责任人必填';
    if (!Number.isFinite(adhesiveConc) || adhesiveConc < 0 || adhesiveConc > 100) return '胶液浓度需在 0 ~ 100 % 之间';
    if (!Number.isFinite(durationMin) || durationMin < 1) return '耗时需为正数';
    // 序号即时校验（以最新缓存为准；跨标签页并发由事务内版本/序号校验兜底）
    const freshList = procedures.filter((it) => it.specimenId === specimenId);
    if (freshList.some((it) => it.seq === seq)) return `序号 ${seq} 已被占用，请改用 ${nextSeq}`;
    if (seq > nextSeq) return `序号跳号：当前最大序号为 ${nextSeq - 1}，新节点必须用 ${nextSeq}`;
    for (const line of draftLines(materialRows)) {
      const lot = lotById.get(line.lotId);
      if (!lot) return '存在未选择批次的领用行，请补选或删除';
      if (line.qty <= 0) return '领用数量必须大于 0';
      if (line.qty > lot.qty) return `批次 ${lot.lotNo} 最新在库仅 ${lot.qty} ${lot.unit}，无法领用 ${line.qty}`;
    }
    const sameLot = materialRows.filter((line) => line.lotId);
    if (new Set(sameLot.map((line) => line.lotId)).size !== sameLot.length) return '同一批次不能拆成多行，请合并数量';
    return '';
  };

  /** 提交（useLatestBase 为冲突后按最新基线重试；表单内容原样保留） */
  const submit = async (useLatestBase = false) => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!specimen) {
      setError('未找到所选标本');
      return;
    }
    const activeBase: FormBase | null = useLatestBase
      ? (() => {
          // 冲突后重试：取广播刷新后的最新版本，表单内容原样保留
          const latestSpecimen = useSpecimenStore.getState().items.find((it) => it.id === specimenId);
          if (!latestSpecimen) return null;
          return {
            specimen: latestSpecimen,
            procedures: useProcedureStore.getState().items.filter((it) => it.specimenId === specimenId),
            lots: useSupplyStore.getState().items,
            at: Date.now(),
          };
        })()
      : base;
    if (!activeBase) {
      setError('页面版本基线缺失，请稍后重试');
      return;
    }

    setSaving(true);
    setError('');
    setConflicts([]);
    try {
      const result = await commitProcedure({
        specimenId,
        baseSpecimen: activeBase.specimen,
        baseProcedures: activeBase.procedures,
        baseLots: activeBase.lots,
        draft: buildDraft(),
        materials: draftLines(materialRows),
        nextStatus: nextStatus === '' ? null : nextStatus,
        withPhotos,
      });

      // 本页内存缓存立即落到最后确认结果
      useProcedureStore.setState((state) => ({
        items: [...state.items, result.procedure].sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt),
      }));
      useSupplyStore.setState((state) => ({
        items: state.items.map((lot) => result.lots.find((next) => next.id === lot.id) ?? lot),
      }));
      useSpecimenStore.setState((state) => ({
        items: state.items.map((it) => (it.id === result.specimen.id ? result.specimen : it)),
      }));

      const suggestedSeq = Math.max(...[...activeBase.procedures, result.procedure].map((it) => it.seq)) + 1;
      setSeq(suggestedSeq);
      setNodeName('');
      setTools([]);
      setMaterialRows([]);
      // 以最新数据重建基线（含刚保存的节点），继续录入下一节点
      rebuildBase(specimenId);
      setNextStatus(result.specimen.status);
      setToast(`已确认节点 #${result.procedure.seq}，${result.lots.length} 个材料批次已扣减`);
      // 通知其它标签页：工序/批次/标本/影像已一次确认，旧版本立即失效
      void emitChange(['procedures', 'supplies', 'specimens', ...(withPhotos ? (['photos'] as const) : [])]);
    } catch (err) {
      if (err instanceof ConflictError) {
        // 关键：不写入、不清空表单，列出差异；技师可修正后或按最新基线重试
        setConflicts(err.diffs);
      } else {
        setError(err instanceof Error ? err.message : '保存失败，请重试');
      }
    } finally {
      setSaving(false);
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
        {base ? (
          <Chip
            size="small"
            color={stale.length > 0 ? 'warning' : 'success'}
            variant="outlined"
            data-testid="base-version-chip"
            label={
              stale.length > 0
                ? `基线已过期（${new Date(base.at).toLocaleTimeString('zh-CN')}）`
                : `基线版本 v${base.specimen.version}（${new Date(base.at).toLocaleTimeString('zh-CN')}）`
            }
          />
        ) : null}
        <Box sx={{ flex: 1 }} />
        <Button onClick={() => navigate(`/specimens/${specimenId}`)} disabled={!specimenId}>
          查看标本详情
        </Button>
      </Stack>

      {/* 打开页面后别处已改动：旧版本立即失效提示（保存前预警） */}
      {stale.length > 0 ? (
        <ConflictPanel
          diffs={stale}
          testid="stale-panel"
          retryLabel="以最新数据为基线继续填写"
          onRetryLatest={() => rebuildBase(specimenId)}
          onDismiss={() => setStale([])}
        />
      ) : null}

      {/* 保存冲突：本次未写入，保留全部已填内容，可按最新版本重试 */}
      {conflicts.length > 0 ? (
        <ConflictPanel
          diffs={conflicts}
          testid="procedure-conflict"
          onRetryLatest={() => submit(true)}
          onDismiss={() => setConflicts([])}
        />
      ) : null}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 420px' }, gap: 2 }}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1.5}>
            {error ? <Alert severity="error" data-testid="procedure-error">{error}</Alert> : null}
            <TextField
              select
              size="small"
              label="标本"
              value={specimenId}
              onChange={(e) => {
                setSpecimenId(e.target.value);
                setSeq(1);
                setConflicts([]);
                setMaterialRows([]);
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

            {/* 实际领用批次与数量：随本节点一次确认扣减 */}
            <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'grey.50' }}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                <Typography variant="subtitle2">实际领用材料（按批次扣减在库）</Typography>
                <Chip size="small" label={`${draftLines(materialRows).length} 行`} />
                <Box sx={{ flex: 1 }} />
                <FormControlLabel
                  sx={{ mr: 0 }}
                  control={<Checkbox size="small" checked={showAllLots} onChange={(e) => setShowAllLots(e.target.checked)} />}
                  label={<Typography variant="caption">显示全部在库批次</Typography>}
                />
                <Button size="small" startIcon={<AddIcon />} onClick={addMaterialRow}>
                  添加批次
                </Button>
              </Stack>
              {materialRows.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  本节点不领用材料；如领用请点「添加批次」选择实际批号并填写数量。
                </Typography>
              ) : (
                <Stack spacing={1}>
                  {materialRows.map((row, index) => {
                    const lot = lotById.get(row.lotId);
                    const overStock = lot ? row.qty > lot.qty : false;
                    return (
                      <Stack key={index} direction="row" spacing={1.5} alignItems="flex-start">
                        <TextField
                          select
                          size="small"
                          fullWidth
                          label="领用批次"
                          value={row.lotId}
                          onChange={(e) => updateMaterialRow(index, { lotId: e.target.value, qty: row.qty || 1 })}
                        >
                          <MenuItem value="" disabled>
                            请选择批号
                          </MenuItem>
                          {lotOptions
                            .filter((option) => option.id === row.lotId || !materialRows.some((r) => r.lotId === option.id))
                            .map((option) => (
                              <MenuItem key={option.id} value={option.id}>
                                {option.kind} · {option.name} · {option.lotNo}（在库 {option.qty} {option.unit}）
                              </MenuItem>
                            ))}
                        </TextField>
                        <Box sx={{ width: 160 }}>
                          <MeasureField
                            label="领用数量"
                            unit={lot?.unit ?? ''}
                            min={0}
                            max={lot?.qty ?? 0}
                            step={1}
                            value={row.qty}
                            onChange={(v) => updateMaterialRow(index, { qty: v })}
                            hint={lot ? `在库 ${lot.qty} ${lot.unit}${overStock ? ' · 超库存' : ''}` : '请先选批次'}
                          />
                        </Box>
                        <IconButton color="error" onClick={() => removeMaterialRow(index)} sx={{ mt: 0.5 }}>
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </Stack>
                    );
                  })}
                </Stack>
              )}
            </Paper>

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

            {/* 标本状态随本节点一次确认 */}
            <TextField
              select
              size="small"
              label="保存后标本状态（一次确认）"
              value={nextStatus}
              onChange={(e) => setNextStatus(e.target.value as SpecimenStatus | '')}
              helperText={
                base
                  ? `打开页面时状态为「${base.specimen.status}」${
                      nextStatus && nextStatus !== base.specimen.status ? `，本次将改为「${nextStatus}」` : '，本次不改状态'
                    }`
                  : undefined
              }
            >
              <MenuItem value="">不改状态</MenuItem>
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
              <Button variant="contained" onClick={() => submit(false)} disabled={saving} data-testid="procedure-submit">
                {saving ? '确认中…' : '一次确认保存'}
              </Button>
              <Button onClick={() => navigate('/procedures/new')}>清空重填</Button>
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
              {progress.lastConfirmedAt ? ` · 最后确认 ${new Date(progress.lastConfirmedAt).toLocaleString('zh-CN')}` : ''}
            </Typography>
          ) : null}
          <ProcedureTimeline
            items={progress.list}
            onFinish={async (node) => {
              await finish(node);
              setToast('节点已完成');
            }}
            onRollback={async (node) => {
              await rollback(node);
              setToast('节点已回退，材料已按领用记录退回');
            }}
          />
        </Paper>
      </Box>

      <Snackbar open={!!toast} autoHideDuration={2600} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
