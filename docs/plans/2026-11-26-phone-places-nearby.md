# PHONE_FIND_PLACES_NEARBY 服务端代理地点 API

## 目标

让 `PHONE_FIND_PLACES_NEARBY` 在 Android 上真正可用：手机仍然只连接已配对电脑，不引入 GMS，也不让手机直接访问第三方地点服务；电脑作为服务端代理完成地点搜索。

## 已拍板边界

- 路线：**服务端代理地点 API**。
- 第一实现：**Google Places API (New) Text Search**。服务器读取 `LUNABOT_GOOGLE_PLACES_API_KEY`；未配置时明确答 `503`，手机把「这台电脑未配置地点搜索」作为工具失败返回，不伪装成无结果。
- 手机只负责取得本机定位、把经纬度/查询/半径发给已配对电脑；电脑再把请求转发给 Google。坐标是完成搜索所必需的数据，不写入日志或磁盘。
- 该工具仍是只读 `location` 能力；服务端要求此 phone 已注册且声明了 `location`。
- 搜索结果只保留规范化小字段：名称、地址、坐标、距离、类型、评分/开放状态（若 provider 返回）。返回给模型前，名称与地址按不可信文本包裹。

## 实现切片

1. `server/places.ts`：Google Places New `places:searchText` provider，8 秒超时、最多 10 条、服务端计算 haversine 距离并过滤超出半径的有坐标结果；provider key 只在请求头使用。
2. `POST /api/phones/self/places`：只允许已注册且声明 `location` 的 paired phone；zod 校验 query/radius/经纬度；未配置 503，上游失败 502。
3. companion 白名单只放这一行 POST。
4. Android core 增加 client/session 调用；`PhoneLocation` 复用当前定位读取，`PHONE_FIND_PLACES_NEARBY` 进入 `PhoneTool` 并 dispatch 到地点搜索。
5. 测试锁定：provider 请求 shape/错误折叠、路由权限与状态码、companion allowlist、Android client 请求 shape、PhoneLocation 参数校验与结果组装、不可信字段包裹。

## 非目标

- 不引入 Google Play Services / Places Android SDK。
- 不在 Android 上直接访问互联网地点 API。
- 不做缓存、收藏、地图 UI 或导航。
- 不把 provider key 下发给手机、bot shell 或 MCP。
