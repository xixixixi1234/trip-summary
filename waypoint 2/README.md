# Waypoint — 城市酒店点评平台 (TripAdvisor 风格)

按城市浏览酒店点评。首页选城市 → 城市页看该城市 Top 酒店（TripAdvisor 风格排名列表）→ 详情页看点评 + Claude 生成的 AI 总结。每个酒店可点 👍 / 👎，后台可以看所有用户的投票参与数据，也能上传 CSV 批量导入酒店。

## 这个版本的新东西

- **SEO 优先**：城市列表每一行，有平台 SEO 摘要就显示 SEO（AI 标签），没有才显示真实住客引文（GUEST 标签）。文字**完整显示**，不再截断。
- **去掉了城市/酒店卡片上的 emoji 图标**（椰子树、铁塔等），只保留天际线渐变。
- **数据库（Postgres）**：酒店、点评、投票都存数据库，刷新和重新部署都不丢。没配数据库时自动降级到内存模式（本地演示可零配置运行）。
- **后台 `/admin`**（需密码）：
  - 「参与数据」：总投票数、独立用户数、被投票酒店数、赞/踩总数、各酒店明细、每位用户最近投票记录。
  - 「批量导入酒店」：上传 Travelers' Choice 格式 CSV，自动清洗入库（按酒店名去重，已存在则更新）。

## 本地运行

```bash
npm install
npm run build

# 方式 A：零配置，内存模式（重启后数据清空，适合本地试）
npm start

# 方式 B：接 Postgres（数据持久）
export DATABASE_URL=postgres://user:pass@host:5432/dbname
export ADMIN_PASSWORD=你的后台密码          # 不设默认是 waypoint-admin
export ANTHROPIC_API_KEY=sk-ant-xxx        # 可选，开启真 AI 总结
npm start

# 前台 http://localhost:3000
# 后台 http://localhost:3000/admin  （用户名留空，密码 = ADMIN_PASSWORD）
```

首次连上一个空数据库时，会自动用 `src/cities.js` 里的 8 城种子数据建表并灌入。

## 部署到 Railway（带 Postgres）

1. 代码推到 GitHub。
2. railway.app → New Project → Deploy from GitHub repo。
3. 在同一个 project 里 **+ New → Database → PostgreSQL**。Railway 会自动注入 `DATABASE_URL`。
4. Variables 里加：`ADMIN_PASSWORD`（后台密码，务必改），可选 `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`。
5. Railway 自动 `npm install → npm run build → npm start`。
6. Settings → Networking → Generate Domain 拿公开网址。

因为数据在 Postgres 里，重新部署不会丢。**记得改 `ADMIN_PASSWORD`**，否则任何人都能进后台。

## 批量导入的 CSV 格式

就是你现在这种 **Travelers' Choice** 导出格式（中文表头）：必须包含
`酒店ID 酒店名称 评分 评论数 平台SEO摘要 用户评论摘录 用户评论用户名 地址 显示价格 价格区间最低 价格区间最高 酒店风格 亮点设施 旅行者之选 排名描述 纬度 经度 城市` 等列。

导入规则（和 `build_data.py` 一致）：每城默认取评分 ≥4.0、评论数 ≥30 的酒店，优先「有真实引文 + Travelers' Choice 获奖」，默认每城保留 12 家（后台可改，填 0 不限）。有 SEO 摘要的酒店会带上 SEO；引文和用户名是 CSV 里的真实摘录。

后台上传时可填城市显示名 / 国家 / city key（URL 用），留空则从 CSV 的「城市」列自动生成。

## 项目结构

```
├── server.js       # Express：数据 API + 投票 + AI 总结 + 后台(/admin) + CSV 导入
├── db.js           # 数据层：Postgres（有 DATABASE_URL）或内存降级；建表、seed、增删查
├── import_csv.js   # Travelers' Choice CSV 解析（build_data.py 的 JS 版）
├── build_data.py   # 从 CSV 生成 src/cities.js 种子数据（可选，改种子时用）
└── src/
    ├── main.jsx
    ├── App.jsx     # 全部前端 UI（数据从 /api 拉，cities.js 仅作离线兜底）
    └── cities.js   # 种子数据 CITIES + CITY_LISTINGS + CITY_REVIEWS
```

## API 一览

- `GET /api/cities`、`GET /api/hotels?city=`、`GET /api/hotels/:id/reviews` — 前台数据
- `GET /api/votes`、`POST /api/vote {hotelId,voterId,choice}` — 投票
- `POST /api/summarize {name,place,reviews[]}` — AI 总结
- `GET /api/admin/stats`（需 Basic auth）— 后台参与数据
- `POST /api/admin/import`（需 Basic auth，multipart，字段 `file`）— CSV 导入

## 说明

- 评分、排名、价格、设施、SEO 摘要、住客引文来自 CSV 原始数据；子评分（Location / Cleanliness 等）为按总分派生的示意值。
- 后台用的是 HTTP Basic 密码保护，够挡住普通访问；要更强可以自己加真正的登录/SSO。
