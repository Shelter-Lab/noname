# 交接摘要(HANDOFF)—— 2026-08-07(第二轮,已定位真凶)

给下一个 session 用。读这份 + [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) + [README-PWA.md](./README-PWA.md) 就能无缝接上。

---

## 项目一句话

无名杀(`libnoname/noname`)fork 到 `Shelter-Lab/noname`(本地 `D:\noname`),改造成**纯静态 PWA + 房间号 P2P 联机 + 离线可玩**,部署 Cloudflare Workers Static Assets,线上 <https://noname.xuehaote.workers.dev/>。
`git push origin main` 即触发 CF 自动构建部署(约 5-6 分钟)。

---

## 当前状态

**已完成且验证通过**:
- 纯静态可部署(browser.js 文件接口退回 URL + IndexedDB)、CF 部署配置
- PWA 外壳(manifest/SW/图标)、可安装
- 离线缓存(核心 709 预缓存 + "下载离线资源"增量补课按钮,合并清单 14993 项 / 1.2GB)
- 房间号 P2P 联机(PeerJS,PWA 能当房主;同机 Edge+Chrome 验证连接/进房/开始全通)
- 检查更新按钮、双主页链接、README-PWA、TROUBLESHOOTING

### 本轮(第二轮)修的:standalone 断网启动慢到分钟级 → 弹两个框 → 白屏

**根因(实锤,已定位)**:不是"缺文件",是 **boot 内部一个 `await` 空转 60 秒**。

```
init/index.ts:43  await loadConfig()
  → init/index.ts:830  await game.promises.checkFile("noname.config.txt")
    → game/promises.js:191
      → browser.js  纯静态分支 → 裸 HEAD fetch(无超时)
         ↑ pwa-sw.js `if (req.method !== "GET") return;` 让它【完全绕过 SW】
         ↑ noname.config.txt 线上 404(curl 验证),两个清单都没有 → 每次离线启动必中
         ↑ 绕过 SW ⇒ SW 超时兜底不在链路上 ⇒ 只能等 iOS NSURLSession 默认超时 ≈ 60s
```

一条链解释全部症状:
- **慢到比 Safari 三倍还多**:60s 空转,不是"缓存差异"
- **iOS 平台级「蜂窝移动数据已关闭」框**:绕过 SW 的裸请求真打到了网络栈,是系统弹的框(不是 JS alert)
- **30s 时先弹「是否重置游戏」**:看门狗(init/index.ts:30)比 60s 早到
- **多等一会儿其实能进**:60s 后 HEAD 终于失败 → `catch` 返回 -1 → boot 继续

**这轮的三处改动**:
1. `browser.js` 加 `fetchWithTimeout()`(2s AbortController),`game.checkFile` 的 HEAD 走它 —— **根因修复**
2. `pwa-sw.js` 加**纯内存离线启发式**(`failStreak`/`OFFLINE_STREAK=3`):连续 3 个请求全失败 → 判"疑似离线" → 之后 miss 直接快失败、hit 分支也不发后台 revalidate;任何一次成功立即复位。下载器(`no-cache`)永不短路。
   解决的是**第二重开销**:SW 单线程,几百个注定失败的 miss 各等满 4~8s 排起来就是几十秒
3. `index.html` **回退 `controllerchange → location.reload()`**(`57e310a` 加的,纯亏本):对离线白屏无用(离线那次 SW 早已 active),代价是每次新版 SW 接管就整页重载 → 部署后首次打开耗时翻倍(用户实测明显变慢)。已留"别再加"注释

**已跑**:`pnpm build` 通过(709/14284,版本戳 2608071615),产物里三处改动都核实落地。

**✅ 已真机验证通过(2026-08-07)**:iPhone 主屏 PWA 断网**几秒进游戏**,两个框都不再出现,
核心 709 也很快下完。**standalone 离线白屏这条长期 bug 至此收口**。
(控制台 `504 (Offline)` 报错是良性的,见 TROUBLESHOOTING)

---

## 这轮排掉的假设(别再重猜,详见 TROUBLESHOOTING「已证伪的假设」)

ESM 模块图 link 失败 / `window.onerror` alert 风暴 / sourcemap 放大器 / IndexedDB 缺 `onblocked` /
standalone 配额驱逐 / SW 冷启接管竞态 / "WebKit 已知 bug 就是本次病因" —— **全部已实证否掉**。

顺带纠了两条文档错误:原 TROUBLESHOOTING :64「standalone 配额压力大会驱逐某模块」两个子命题全错
(配额 = 总磁盘 15% 且与浏览器同额;驱逐是 per-origin LRU、整 origin 一起删),还和 :82 自相矛盾,已删。

---

## 环境事实(重要,决定能测什么)

- 开发在 **Windows**,**没有 WebKit 环境** → 复现不了 iOS Safari 的 bug。Edge/CDP 测不出 WebKit 特性
- 用户有 **iPhone**(主屏 PWA + Safari 测),**有 Mac**(能 Safari 连 iPhone 看 standalone Console —— 实锤 bug 最快的路,应多用)
- **测离线必须用 Safari/主屏 PWA,不能用 Edge/Chrome/无痕**(无痕不支持 SW)
- 构建:Git Bash 里 **pnpm 不在 PATH**,用 `npx --yes pnpm@11.20.0 build`。
  跑过 `python -m http.server dist` 要记得停掉,否则 `fs.rm("dist")` 报 EBUSY(本轮撞过一次)

## 关键机制(别再踩)

- iOS 主屏 PWA 是**独立 origin**,缓存/SW 和 Safari 浏览器不共享
- **WebKit 断网 fetch 不 reject 而是长时间 pending**;绕过 SW 的还会一路等到 iOS 网络栈 ~60s 默认超时
- **新增任何绕过 SW 的请求(非 GET / 跨域 / iframe 子请求)必须自带 AbortController 超时** ——
  这类坑本项目踩了两次(沙盒 iframe、HEAD 探测),是同一类
- **判白屏先看看门狗响没响**:响了 ⇒ 模块图 link 成功 ⇒ 问题在 boot 内部某个 await,不是缺文件
- 沙盒已修(`init/index.ts:53 && lib.device!=="ios"` 跳过),别再动

## CF 部署配置(控制台)

环境变量 `SKIP_DEPENDENCY_INSTALL=1`、`PNPM_VERSION=11.20.0`、`NODE_VERSION=24`;
Build `pnpm install --no-frozen-lockfile && pnpm build`;Deploy `npx wrangler deploy`。

---

## 协作教训(照做)

1. **开工先甩环境事实**(什么设备、能测什么)
2. **"我复现不了"的 bug,先系统挖 + 用 Mac Console 实锤一次再动手**,别"猜→push→真机测→再猜"循环
3. **不验证不回退**
4. **别替用户猜"是不是没等够"** —— 本轮我猜过一次,用户已明确等够(三倍时间),纯浪费一轮
5. **push 有成本**(用户要删重装+重下缓存+真机测)——攒够、想清再推
6. **上下文别超 50%**;复杂任务拆多 session
7. **假设要能解释"不对称"**:哪个假设解释不了"Safari 行/standalone 不行"或"多等能进",就该被淘汰,
   而不是加补丁硬圆。本轮就是靠"多等能进"这一条实锤把一堆假设一次性砍掉的

## 下一步建议

1. **首要:真机验证本轮修复**(iPhone 主屏 PWA 断网测)。好了则白屏根治
2. 若还慢:Mac Safari 连 iPhone 看 Network,找**还在 pending 的那个请求** —— 按上面的判据,答案一定在 boot 内部的 await 里
3. 可选硬化(不急,已知不是真凶):`browser.js` 的 `fsDB()` 和 `init/index.ts:802` 的
   `indexedDB.open()` 都缺 `onblocked` 分支(挂了不会自解)
4. `downloadOfflineAssets`(`library/init/index.js`)进度条**有虚报的代码缺陷,但当前未发作**:
   `if (r.status === 200)` 才 `cache.put`,而非 200 也正常 resolve → `allSettled` 判 `fulfilled` → `done++`。
   **实测清单里没有 404**(890 个非 ASCII 路径经 `fetch` 自动 URL 编码后都是 200),所以现在的
   "14993/14993 下载完成"是**可信的**。属潜在隐患:哪天清单与产物脱节才会骗人。
   修法:非 200 抛错或单独计失败数。不急

### 别再自己骗自己:用 curl 探线上资源必须先 URL 编码

清单里 890 个非 ASCII 路径(`dc_zhangyì.mp3`、`db_atk1_克敌先机.png`、`extension/杀海拾遗/*`)。
`curl .../dc_zhangyì.mp3` → 404,`curl .../dc_zhangy%C3%AC.mp3` → 200。浏览器 `fetch()` 自动编码,
**游戏里一切正常**。本 session 踩过:据此误判"890 个文件线上缺失、十几个武将没立绘",全是自造的假象。
