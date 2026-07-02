# Waypoint — 城市酒店点评平台 (TripAdvisor 风格)

按城市浏览酒店点评。首页选城市 → 城市页看该城市 Top 12 酒店（TripAdvisor 风格排名列表）→ 详情页看真实住客点评 + Claude 生成的 AI 总结。每个酒店都能点 👍 / 👎，后台可以看到每个酒店被点赞 / 点踩的数量。

数据来自 8 个城市的 Travelers' Choice 导出 CSV（伦敦、巴黎、罗马、纽约、洛杉矶、东京、北京、上海），每城取评分与评论量最高的 12 家，住客引文（quote）和用户名是 CSV 里的真实摘录。

## 本地运行

```bash
npm install
npm run build
ANTHROPIC_API_KEY=sk-ant-xxx npm start
# 打开 http://localhost:3000
# 后台点赞统计: http://localhost:3000/admin
```

不设置 `ANTHROPIC_API_KEY` 也能运行，AI 总结会显示本地降级版本，点赞功能不受影响。

开发模式（热更新）：
```bash
npm run dev          # 前端 http://localhost:5173
node server.js       # 另开终端跑后端，/api 会自动代理
```

## 点赞 / 点踩（like / dislike）

- 首页热门卡片、城市列表每一行、酒店详情页都有 👍 / 👎 按钮，实时显示数量。
- 每个浏览器一票；再点同一个按钮取消，点另一个则改票，不会重复计数。
- 数据存在服务端 `votes.json`（自动生成，已在 `.gitignore` 忽略）。
- 后台 `/admin` 页面按赞数排序列出每个酒店的 👍 / 👎 / 净值，15 秒自动刷新。原始数据在 `/api/votes`。

> 生产环境建议把 `votes.json` 换成数据库（Railway 可一键加 Postgres），并给 `/admin` 加上登录保护。

## 部署到 Railway

1. 推到 GitHub：
   ```bash
   git init && git add . && git commit -m "waypoint cities"
   git remote add origin <你的仓库地址> && git push -u origin main
   ```
2. railway.app → New Project → Deploy from GitHub repo。
3. Railway 自动 npm install → npm run build → npm start。
4. Variables 里加 ANTHROPIC_API_KEY（可选 ANTHROPIC_MODEL）。
5. Settings → Networking → Generate Domain 拿到公开网址。

> 注意：Railway 每次部署容器文件系统会重置，votes.json 会丢。要长期保存点赞数据请挂一个 Volume 或改用数据库。

## 项目结构

```
├── server.js          # Express：托管前端 + /api/summarize + /api/vote + /api/votes + /admin
├── votes.json         # 点赞数据（运行后自动生成，已 gitignore）
├── index.html
├── vite.config.js
├── build_data.py      # 从 CSV 生成 src/cities.js 的脚本
└── src/
    ├── main.jsx
    ├── App.jsx        # 全部 UI：首页选城市、城市酒店列表、详情页、点评、AI 总结、点赞
    └── cities.js      # CITIES + CITY_LISTINGS + CITY_REVIEWS（由 build_data.py 生成）
```

## 添加 / 更新城市数据

src/cities.js 由 build_data.py 从 CSV 生成：

1. 把新城市的 <city>_travelers_choice_hotels.csv 放到 CSV 目录。
2. 在 build_data.py 顶部的 CITIES 字典里加一行（城市名、国家、emoji、渐变色、图标）。
3. 运行 python3 build_data.py（需要 pandas），会重新生成 src/cities.js。
4. npm run build 重新打包即可。

每个城市默认取评分 ≥4.0、评论数 ≥30 的酒店，优先「有真实引文 + Travelers' Choice 获奖」，每城 12 家。

## 说明

- 酒店评分、排名、价格、设施、住客引文来自 CSV 原始数据；子评分（Location / Cleanliness 等）为按总分派生的示意值。
- AI key 只存在服务端环境变量，前端通过 /api/summarize 调用，不会泄露。
