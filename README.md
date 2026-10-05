# sologsb-1119 化石修复工序档案（gbfossilprep）

面向博物馆化石修复技师的工序留痕工作台：标本从入库、清修、加固到交付逐节点留痕，登记工具与胶种用量，并做修复前后对照。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21819**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | MUI（Material UI）v5 |
| 构建 | Vite 5 |
| 状态管理 | Zustand |
| 路由 | React Router v6（BrowserRouter） |
| 本地存储 | IndexedDB（Dexie 4），影像单独建表，含结构版本号与升级迁移 |
| 并发控制 | 记录级乐观锁（version）+ 单事务多表确认 + Web Locks 跨标签页互斥 + BroadcastChannel 失效广播 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1119/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.tsx
        ├── router/index.tsx
        ├── types/{specimen,procedure,supply,photo}.ts
        ├── stores/{specimen,procedure,supply}Store.ts
        ├── components/common/{ProcedureTimeline,BeforeAfterSlider,SpecimenCard,MeasureField}.tsx
        ├── hooks/{useSpecimenSearch,usePrepProgress}.ts
        ├── pages/{SpecimenList,SpecimenDetail,ProcedureForm,SupplyList,CompareView}.tsx
        └── utils/{db,unitConvert,id}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/specimens` | 标本台账：按号/分类/产地/状态筛选，状态分栏 | Specimen |
| `/specimens/:id` | 标本详情 + 工序时间线 + 影像留痕 | Specimen、PrepProcedure、PrepPhoto |
| `/procedures/new` | 新建工序节点：按类型动态出工具/磨料/胶种字段，序号跳号报错 | PrepProcedure、Specimen |
| `/supplies` | 工具材料台账：按种类分组、批号追溯、低量高亮、领用登记 | SupplyLot |
| `/compare/:specimenId` | 前后对照滑块联看 + 导出对照说明文本 | PrepPhoto、PrepProcedure |

`/` 重定向到 `/specimens`，未匹配路由同样兜底到 `/specimens`。

## 数据存储说明

- 数据库名 `gbfossilprep`，当前结构版本 **v3**（`localStorage['gbfossilprep:db-version']` 记录）。
- 四张表：`specimens`（标本）、`procedures`（修复工序）、`supplies`（工具材料批次 + 领用记录）、`photos`（修复影像 dataUrl 独立表）。
- v1 → v2 迁移：为老数据补齐 `state`、`tools`、`photoBeforeIds/AfterIds`、`issues`、`lowThreshold` 字段并新增索引。
- v2 → v3 迁移：标本/工序/批次补乐观锁 `version`；工序新增 `materials`（实际领用批次/数量）；领用记录新增 `procedureId`、`returnedAt` 以支持回退退料。
- 容器无状态、不挂载命名卷；换浏览器或清空站点数据即回到初始示范数据。
- 首次打开会灌入 2 件示范标本、2 个工序节点、4 个材料批次与 2 张留痕影像，便于直接查看。

## 并发确认（防止两个标签页互相覆盖）

- **打开页面即记录版本**：录入页对标本状态、该标本全部工序时间线、所选材料批次分别记下 `version` 基线。
- **一次确认**：保存节点在单个 IndexedDB 事务内重读并校验「工序 + 材料批次 + 标本状态」，扣料、写领用记录、写工序、改状态、写影像全成全败；用 Web Locks 让跨标签页提交串行。
- **旧版本立即失效**：任一对象在别处被改动（版本不一致 / 删除 / 序号被占 / 最新库存不足）即抛 `ConflictError`，事务回滚不写入；页面列出「打开页面时 → 当前最新」的逐项差异。
- **跨标签页即时刷新**：提交成功后经 BroadcastChannel（不支持时退化到 storage 事件）通知其它标签页重载缓存，旧基线即时标记过期。
- **失败保留内容重试**：冲突不清空表单，技师可按最新版本「重试」或先调整批次/数量再保存。
- **回退退料**：回退已完成节点时按工序上的领用记录把数量加回对应批次、标记领用记录与工序材料「已退回」；批次或记录缺失则中止回退。
- 自检：`npm run test:occ`（并发/回退/状态乐观锁）。

## 功能要点

- **工序序号不跳号**：新建节点时若序号大于「当前最大序号 + 1」直接报错并给出建议序号。
- **领料随工序一次确认**：录入时选择实际领用批次（批号、在库量可见）与数量，保存时同事务扣减在库并生成可追溯领用记录。
- **工序回退**：已完成节点可回退，回退后计入待办与回退计数，并按领用记录把材料退回批次（已退记录不重复退）。
- **最后确认结果**：时间线展示各节点领用/退回材料与最后确认时间，完成度统计随跨标签页确认实时刷新。
- **低量高亮**：在库 ≤ 低量阈值的批次整行高亮并标注「低量」，剩余保质期为负时红色标注。
- **批号追溯**：按批号片段检索，行内直接展示该批次的领用明细。
- **前后对照**：滑块拖动联看修复前后影像，支持缩放与标注泡点，可导出/复制对照说明文本。
