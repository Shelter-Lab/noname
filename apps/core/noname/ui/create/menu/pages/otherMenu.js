import { menuContainer, menuxpages, menuUpdates, openMenu, clickToggle, clickSwitcher, clickContainer, clickMenuItem, createMenu, createConfig } from "../index.js";
import { ui, game, get, ai, lib, _status, rootURL } from "noname";
import { createApp } from "vue";
import { security } from "@/util/sandbox.js"
import dedent from "dedent";

export const otherMenu = function (/** @type { boolean | undefined } */ connectMenu) {
	if (connectMenu) {
		return;
	}
	/**
	 * 由于联机模式会创建第二个菜单，所以需要缓存一下可变的变量
	 */
	const cacheMenuContainer = menuContainer;
	// const cachePopupContainer = popupContainer;
	// const cacheMenux = menux;
	const cacheMenuxpages = menuxpages;
	/** @type { HTMLDivElement } */
	// @ts-expect-error ignore
	var start = cacheMenuxpages.shift();
	var rightPane = start.lastChild;
	var cheatButton = ui.create.div(".menubutton.round.highlight", "作", start);
	cheatButton.style.display = "none";
	var runButton = ui.create.div(".menubutton.round.highlight", "执", start);
	runButton.style.display = "none";
	var clearButton = ui.create.div(".menubutton.round.highlight", "清", start);
	clearButton.style.display = "none";
	clearButton.style.left = "275px";
	var playButton = ui.create.div(".menubutton.round.highlight.hidden", "播", start);
	playButton.style.display = "none";
	playButton.style.left = "215px";
	playButton.style.transition = "opacity 0.3s";
	var deleteButton = ui.create.div(".menubutton.round.highlight.hidden", "删", start);
	deleteButton.style.display = "none";
	deleteButton.style.left = "275px";
	deleteButton.style.transition = "opacity 0.3s";
	var saveButton = ui.create.div(".menubutton.round.highlight.hidden", "存", start);
	saveButton.style.display = "none";
	saveButton.style.transition = "opacity 0.3s";

	/**
	 * @this { HTMLDivElement }
	 */
	var clickMode = function () {
		if (this.classList.contains("off")) {
			return;
		}
		var active = this.parentNode.querySelector(".active");
		if (active === this) {
			return;
		}
		if (active) {
			active.classList.remove("active");
			active.link.remove();
		}
		active = this;
		this.classList.add("active");
		if (this.link) {
			rightPane.appendChild(this.link);
		} else {
			this._initLink();
			rightPane.appendChild(this.link);
		}
		if (this.type == "cheat") {
			cheatButton.style.display = "";
		} else {
			cheatButton.style.display = "none";
		}
		if (this.type == "cmd") {
			runButton.style.display = "";
			clearButton.style.display = "";
		} else {
			runButton.style.display = "none";
			clearButton.style.display = "none";
		}
		if (this.type == "video") {
			playButton.style.display = "";
			saveButton.style.display = "";
			deleteButton.style.display = "";
		} else {
			playButton.style.display = "none";
			saveButton.style.display = "none";
			deleteButton.style.display = "none";
		}
	};

	ui.click.consoleMenu = function () {
		ui.click.menuTab("其它");
		clickMode.call(ui.commandnode);
	};
	//更新菜单有本体函数赋值，就不要懒加载了
	(function () {
		var page = ui.create.div("");
		var node = ui.create.div(".menubutton.large", "更新", start.firstChild, clickMode);
		node.link = page;
		page.classList.add("menu-help");
		var ul = document.createElement("ul");
		var li1 = document.createElement("li");
		var li3 = document.createElement("li");
		li1.innerHTML = "游戏版本：" + lib.version + '';
		li3.innerHTML = '由于无名杀正在重构项目结构，在线更新暂时无法使用，请访问github主页获取最新版本。';

		/** @type { HTMLParagraphElement } */
		var updatepx = ui.create.node("p");
		updatepx.style.whiteSpace = "nowrap";
		updatepx.style.marginTop = "8px";
		var buttonx = ui.create.node("button", "官方项目主页", function () {
			window.open("https://github.com/libnoname/noname");
		});
		updatepx.appendChild(buttonx);
		// 本 PWA 版(Shelter-Lab fork:纯静态可安装、离线、房间号联机)
		var buttonFork = ui.create.node("button", "本 PWA 版主页", function () {
			window.open("https://github.com/Shelter-Lab/noname");
		});
		buttonFork.style.marginLeft = "8px";
		updatepx.appendChild(buttonFork);

		ul.appendChild(li1);
		ul.appendChild(li3);
		ul.appendChild(updatepx);

		// PWA 手动检查更新:让 Service Worker 拉取最新版,有则更新并提示刷新。
		// 纯手动(不自动),仅在支持 SW 的环境(如 PWA)显示。
		if ("serviceWorker" in navigator) {
			var updateCheckPx = ui.create.node("p");
			updateCheckPx.style.whiteSpace = "nowrap";
			updateCheckPx.style.marginTop = "8px";

			// 版本戳:显示当前页面正在跑的构建时间(YYMMDDHHmm),便于确认是否已更新到最新
			var versionSpan = document.createElement("span");
			versionSpan.style.cssText = "font-size:12px;color:#888;margin-left:8px;font-variant-numeric:tabular-nums;";
			/**
			 * 当前页面正在跑的构建戳。由 scripts/build.ts 打包时写死进 index.html。
			 * 【为什么不去 fetch pwa-version.json 拿】那读到的是**缓存里**哪一版,不是**我在跑**哪一版:
			 * 新 SW 一装好缓存就换成新戳了,而页面内存里跑的还是旧代码 —— 拿它比对必然误报"已是最新",
			 * 用户不知道该刷新,这个按钮等于没用(这就是原来的老 bug)。
			 * dev server 下占位符原样保留,此时判定为未知,只做"有没有新版"以外的降级处理。
			 */
			var runningStamp = /^\d{10}$/.test(String(window.__PWA_RUNNING_BUILD__ || "")) ? window.__PWA_RUNNING_BUILD__ : null;
			versionSpan.textContent = runningStamp ? "v" + runningStamp : "";
			/**
			 * 问线上最新构建戳是多少(绕开一切缓存)。
			 * 【必须自带超时】平时这个请求被 SW 拦下(SW 里 fetchSafe 有 2s 超时),但 SW 正在换版、
			 * 或页面还没被接管的那一刻,它直接走网络 —— 弱网下"连上了但不返回"会永久挂住,
			 * 按钮的 finally 就永远不执行,一直停在「检查中…」(用户实际遇到的症状)。
			 * @returns {Promise<string|null>} null = 没问到(离线/超时/响应异常)
			 */
			function fetchLatestStamp() {
				var controller = new AbortController();
				// 【必须比 SW 侧那 8 秒长】pwa-sw.js 里这个请求走 Network-First 分支,自己也有 8 秒
				// 超时 + 超时后的兜底逻辑。两边都写 8000 时,页面的计时器**先开始**(SW 要等 fetch
				// 事件派发过去才起表),于是页面必然先 abort —— SW 那 8 秒的耐心和兜底整段成了死代码,
				// 「慢网但连得上」这种情况必然报「联网检查失败」。给页面留 7 秒余量。
				var timer = setTimeout(function () {
					controller.abort();
				}, 15000);
				return fetch("./pwa-version.json", { cache: "reload", signal: controller.signal })
					.then(function (r) {
						return r.ok ? r.json() : null;
					})
					.then(function (data) {
						return data && data.build ? data.build : null;
					})
					.catch(function () {
						return null;
					})
					.finally(function () {
						clearTimeout(timer);
					});
			}

			/**
			 * 体检本地代码缓存:装的是哪一版、有没有"装着却不被信任"。
			 * 【为什么按钮必须报这个】SW 判断能不能直接用缓存,看的是 /__pwa_build__ 这个戳
			 * (见 pwa-sw.js 的 getCodeState)。戳一旦跟 SW 里的 BUILD 不符,缓存里 600 多个代码
			 * 文件一个不少也全部绕开、每次冷启动重新联网取一遍 —— 首屏从 1.4s 变 4.2s(桌面千兆
			 * 实测),手机 4G 上是 7~8 秒变 15 秒。而界面上以前完全看不出这个状态:版本号照样
			 * 显示得好好的,"已是最新",人只觉得"明明缓存好了怎么还是慢"。故如实报出来。
			 * @returns {Promise<{stamp:string|null,stale:number,code:number,assets:number}|null>}
			 *          stamp = 缓存里这批代码的构建戳;stale = 还差几个文件没补齐;null = 读不到缓存
			 */
			async function inspectCache() {
				if (!("caches" in window)) return null;
				try {
					// 【必须读代码桶,不是素材桶】拆桶之后两个戳都由 install 写进代码桶
					// noname-code-v1(见 pwa-sw.js 的 BUILD_KEY/STALE_KEY),这里却一直开着旧的
					// 素材桶 noname-pwa-v2 —— 那儿压根没有戳,于是 stamp 恒为 null、恒不等于
					// runningStamp,「检查更新」对**所有人**都误报「代码缓存不可信(缺少版本标记)」
					// 并劝人重装 30MB。这就是"点检查更新就说缓存不可信、怎么点都更新不了"的成因。
					var codeCache = await caches.open("noname-code-v1");
					var rec = await codeCache.match("/__pwa_build__");
					var stampInCache = rec ? await rec.text() : null;
					var staleRec = await codeCache.match("/__pwa_stale__");
					var staleList = staleRec ? await staleRec.json() : [];
					// 【素材数改问 IndexedDB,绝不能再 caches.open("noname-pwa-v2")】
					// 素材已迁进 IDB,旧素材桶由 SW 的 activate 整桶删掉;而 caches.open() 对
					// 不存在的桶是**创建**语义 —— 光是在这儿开一下就会把它重新建出来,
					// 那 15.8 秒的隐患也跟着回来(见 pwa-sw.js 文件头)。
					var codeKeys = await codeCache.keys();
					// 【assets 用 null 表示"读不到",不要用 0】0 的含义是"库是空的",和"打不开"
					// 是两种完全不同的故障,混成同一个数字就永远排查不出来(实测栽过)。
					// 【顺带报版本表条数】它和素材数一比就能看出有多少素材"版本未知"
					// (升级前装进来的那些)—— 未知的没法参与比对,得先本地补算一遍。
					// 版本表和素材表由 putAsset/putAssets 同事务写入,所以正常情况下两个数相等。
					var assets = null;
					var versionCount = null;
					try {
						// 【必须用 rootURL,绝不能用 lib.assetURL】lib.assetURL 是**空字符串**
						// (util/index.js:4),拼出来就是 import("pwa-asset-db-esm.js") —— 那是个
						// **裸模块说明符**。不以 / 、./ 、../ 开头的说明符按 import map 解析,
						// 而 import map 里没这个名字 → 直接抛 TypeError:
						// Failed to resolve module specifier。
						// 于是素材体检/比对这几处**从来没成功过一次**:异常被 catch 吃掉,
						// 于是报「素材 0 个」/「素材库打不开」、比对恒说「与线上一致」。
						// 而下载器(library/init/index.js:98)用的是 rootURL,所以它一直好 ——
						// 库里那 1.4 万个素材确实是满的(离线立绘正常就是铁证),只是这边读不到。
						// rootURL = new URL("./", import.meta.url),是带尾斜杠的真实绝对 URL。
						var db = await import(/* @vite-ignore */ `${rootURL}pwa-asset-db-esm.js`);
						assets = await db.countAssets();
						var v = await db.getVersions();
						versionCount = v ? Object.keys(v).length : null;
					} catch (e) {
						/* 素材库模块都加载不了 → 保持 null,如实报"读不到" */
					}
					return {
						stamp: /^\d{10}$/.test(String(stampInCache || "")) ? stampInCache : null,
						stale: Array.isArray(staleList) ? staleList.length : 0,
						code: codeKeys.length,
						assets: assets,
						versions: versionCount,
					};
				} catch (e) {
					return null;
				}
			}

			/**
			 * 素材是否有更新:拿构建产出的内容哈希清单和本地版本表逐条比,精确算出变更集。
			 *
			 * 【为什么要本地版本表】素材存在 IndexedDB、键是 pathname。改了图但路径不变时,
			 * 光看键无从判断新旧;而记录里只有 { buf, mime, len },没有 ETag,发不出
			 * If-None-Match,想"校验"就只能把字节整个重下。代码没这问题:换版时 install 用
			 * cache:"reload" 整版重下核心清单,那条路绕开一切缓存;而素材不在核心清单里
			 * (image/card/ 的 581 张全在可下载清单),压根不走那条路。
			 * 【为什么比清单不逐个问】1.4 万个素材逐个条件请求就是 1.4 万次往返;哈希清单
			 * 一次下完(792KB,CF 会 gzip),diff 出来就是精确的变更集,零多余流量。
			 * 【版本号为什么必须来自本地字节】直接抄服务端清单等于替本地撒谎:库里明明是旧字节,
			 * 版本表却声称与线上一致,之后永远 diff 不出差异。写入路径(putAsset/putAssets)
			 * 算的正是刚从网络拿到、即将入库的那份字节,天然对得上构建时的哈希。
			 *
			 * 三种结果分开报,因为解法完全不同:
			 *   changed  = 版本号和线上不一样 → 要**联网重下**这几个
			 *   unknown  = 素材在库里但版本号未知(升级前装进来的)→ **本地算一遍**即可,不联网
			 *   added    = 库里压根没有 → 走「下载离线资源」补齐
			 *
			 * @returns {Promise<null | { changed: string[], added: string[], unknown: string[], dbUnreadable?: boolean, db: any, hashes: Record<string,string> }>}
			 */
			async function inspectAssets() {
				let db;
				try {
					db = await import(/* @vite-ignore */ `${rootURL}pwa-asset-db-esm.js`);
				} catch (e) {
					return null; // 素材库不可用 → 这一项直接跳过,不影响版本检查
				}
				let hashes;
				try {
					var resp = await fetch("./pwa-asset-hashes.json", { cache: "no-cache" });
					if (!resp.ok) return null;
					hashes = await resp.json();
				} catch (e) {
					return null; // 老版本构建没有这个清单,或离线 → 跳过
				}
				// 只看素材,代码文件由 install 的整版重下负责(判据与下载器/SW 的 isCodeAsset 一致)
				var CODE_EXT = /\.(js|mjs|ts|css|html|json|webmanifest)$/i;
				var CODE_DIRS = ["noname", "_virtual", "node_modules", "layout", "theme", "game", "mode", "card", "character"];
				var isCode = function (rel) {
					if (!CODE_EXT.test(rel)) return false;
					var slash = rel.indexOf("/");
					if (slash === -1) return true;
					return CODE_DIRS.includes(rel.slice(0, slash));
				};
				var versions = await db.getVersions();
				var haveKeys = await db.getAssetKeys();
				// 【读不到(≠空)就别往下比】否则 14403 个素材会被全部误判成"本地压根没有",
				// 报成"另有 14403 个未下载",把真正的故障(素材库打不开)完全掩盖掉 —— 实测栽过。
				if (!haveKeys || !versions) {
					return { changed: [], added: [], unknown: [], dbUnreadable: true, db: db, hashes: hashes };
				}
				var changed = [];
				var added = [];
				var unknown = [];
				for (var rel in hashes) {
					var clean = rel.replace(/^\.\//, "");
					if (isCode(clean)) continue;
					var pathname = new URL(rel, location.href).pathname;
					if (!haveKeys.has(pathname)) {
						added.push(rel);
						continue;
					}
					if (!versions[pathname]) {
						unknown.push(rel);
						continue;
					}
					if (versions[pathname] !== hashes[rel]) {
						changed.push(rel);
					}
				}
				return { changed: changed, added: added, unknown: unknown, db: db, hashes: hashes };
			}

			/**
			 * 强制重装核心代码文件。复用 index.html 里那套 __pwaRepair —— 它是唯一能绕开
			 * "正在喂你旧字节的那个 SW" 的办法(给 URL 挂一次性查询串让 Cache Storage 必然未命中,
			 * 逼 SW 走网络),重装完会把构建戳补上、清掉待补名单,然后自己刷新页面。
			 * 【为什么不复用「下载离线资源」】那个是纯续传语义:缓存里有就跳过(见 library/init),
			 * 所以它永远不会更新已存在的代码文件,也不会补戳 —— 治不了这个病。
			 * @returns {boolean} 有没有真的开始重装
			 */
			function forceReinstallCore(reason) {
				if (typeof window.__pwaRepair !== "function") {
					alert("当前版本不支持强制重装(缺少修复入口),请重新打开应用后再试。");
					return false;
				}
				if (!confirm(reason + "\n\n现在强制重装核心代码文件?\n\n· 需要联网下载约 30MB,4G 下大概几分钟\n· 已下载的立绘/语音一个都不会动\n· 完成后会自动刷新(进行中的对局会中断)\n· 中途请保持联网、不要关闭")) {
					return false;
				}
				window.__pwaRepair();
				return true;
			}

			// 【这个按钮不负责"下载"新版】新版由 index.html 每次 load 时无条件 register("./pwa-sw.js")
			// 自动装(SW 字节变了就 install → skipWaiting → clients.claim)。但那一次装完**不会**动
			// 已经加载进内存跑起来的旧 js,所以本次打开仍是旧版,要下次打开才生效。
			// 本按钮管三件事:①告诉你在跑哪一版、线上是哪一版;②有新版时一键刷新立刻生效;
			// ③体检本地缓存,发现"装着却不被信任"(启动会白跑几十 MB)时给一键强制重装。
			var checkUpdateBtn = ui.create.node("button", "检查更新", async function () {
				var btn = this;
				btn.textContent = "检查中…";
				btn.disabled = true;
				try {
					var reg = await navigator.serviceWorker.getRegistration();
					if (!reg) {
						alert("当前不是 PWA 安装环境,无法检查更新。");
						return;
					}
					// 先直接问线上的构建戳(绕开缓存),它是"有没有新版"最可靠的判据。
					// 【为什么不能只靠 reg.update()】update() 只在"发现新 SW 字节"时才产生
					// installing/waiting;而 pwa-sw.js 的 install 末尾就 skipWaiting、activate 里
					// clients.claim —— 用户点进菜单时新版早已 activate 完,两者都是空,
					// 光看它就会误报"已是最新版本",而页面里跑的还是旧代码。
					var latest = await fetchLatestStamp();

					// 【也要封顶】实测 update() 不等 install 跑完(Chromium 219ms / WebKit 15ms,
					// 连 sw.js 请求被永久挂住时也只 3ms 就返回),所以它不是卡住的元凶;但它是这个
					// 处理函数里最后一个无上限的 await —— 封个顶,「检查中…」就在任何情况下都不会永久停住。
					// 超时也无妨:下面只是读一眼 installing/waiting,读不到就走构建戳比对那条路(更准)。
					await Promise.race([reg.update().catch(function () {}), new Promise(function (res) { setTimeout(res, 8000); })]);

					var incoming = reg.installing || reg.waiting;
					if (incoming) {
						// 【罕见但要接住】点按钮的瞬间新版恰好还在装(慢网下 install 要重下几百个核心文件)。
						// 【监听必须挂在弹窗之前】弹窗阻塞主线程,而 SW 在另一线程继续装完并自行 activate;
						// 等用户点掉弹窗时 state 早已是 activated,statechange 永不触发
						// → 承诺的"自动刷新"静默失效(原来的写法就是这个顺序问题)。
						var wantReload = false;
						var activated = incoming.state === "activated";
						incoming.addEventListener("statechange", function () {
							// 【只在 activated 才刷】installed 时新 SW 还没接管,这时刷新仍由旧 SW
							// 响应 → 拿到的还是旧代码,白刷一次还让用户以为更新失败。
							if (incoming.state !== "activated") {
								return;
							}
							activated = true;
							// 用户还没回答完(wantReload 尚未赋值)时不刷,交给弹窗之后那次补检
							if (wantReload) {
								location.reload();
							}
						});
						// 若已 waiting(装好没接管),催它跳过等待
						if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
						// 同样用 confirm:装完就闷头刷新会打断正在进行的对局
						// 【要提醒再点一次】代码和素材是两趟:这里 return 之后素材比对压根不跑,
						// 而改立绘/卡面必然同时换构建戳 —— 用户只点一次就会以为"图没更新"。
						wantReload = confirm("发现新版本,正在下载…\n\n下载完成后自动刷新页面生效?(已下载的离线素材会保留)\n选「取消」则不刷新,下次打开时自然生效。\n\n提示:刷新后请再点一次「检查更新」——立绘/卡面这类素材是第二趟才检查的。");
						// 弹窗期间可能已经装完 activate 了(见上),补检一次,免得干等一个不会再来的事件
						if (wantReload && (activated || incoming.state === "activated")) {
							location.reload();
						}
						return;
					}

					// 线上戳 ≠ 页面正在跑的戳 → 新版已经装好在本地了,只是这个页面还跑着旧代码。
					// 【用 confirm 不用 alert】刷新会中断正在进行的对局,得让用户自己选时机;
					// 且 reload 是从 SW 缓存读本地文件,不像冷启动那样慢。
					if (latest && runningStamp && latest !== runningStamp) {
						if (confirm("发现新版本 v" + latest + "(当前 v" + runningStamp + ")。\n新版已下载完成,刷新页面即可生效。\n\n现在刷新?(进行中的对局会中断)\n\n提示:刷新后请再点一次「检查更新」——立绘/卡面这类素材是第二趟才检查的。")) {
							location.reload();
						}
						return;
					}

				// 【没问到线上戳时不能报"已是最新"】离线/超时都会让 latest 为 null,那时压根不知道
					// 线上是哪一版,报"最新"是撒谎。
					// 【也不在这里做缓存体检】体检的结论只有"强制重装"这一个出手方式,而重装要联网下
					// 30MB —— 连版本号都问不到的时候提议它没有意义。等联网正常了再说。
					if (!latest) {
						alert("联网检查失败,无法确认是否有新版本。\n当前版本:" + (runningStamp ? "v" + runningStamp : "未知") + "\n请确认网络后重试。");
						return;
					}
					// runningStamp 缺失(开发服务器下占位符没被替换)→ 无从比对,同样不能报"已是最新"
					if (!runningStamp) {
						alert("线上最新版本:v" + latest + "\n当前页面版本未知(非正式构建),无法比对。");
						return;
					}

					// —— 到这里:联网正常、页面跑的就是线上最新版。再体检缓存,别放过"装着却不被信任"这种哑巴故障 ——
					var health = await inspectCache();
					if (health) {
						// 缓存里的戳跟页面在跑的版本不符(常见成因:上一次 install 在手机弱网/后台被掐断)。
						// 这时 SW 对每个代码文件都走 Network-First,冷启动白烧几十 MB、慢一倍以上。
						// (注意:此处已排除"有新版待生效"那种正常的戳不一致 —— 那种在上面就 return 了。)
						if (health.stamp !== runningStamp) {
							forceReinstallCore("检测到本地代码缓存不可信" + (health.stamp ? "(缓存记录 v" + health.stamp + ",实际在跑 v" + runningStamp + ")" : "(缺少版本标记)") + "。\n\n后果:每次冷启动都要把几百个代码文件重新联网下载,启动会明显变慢(实测慢一倍以上),而且不会自己恢复。");
							return;
						}
						// 戳对得上但还有文件没补齐:启动时会自动补、一次比一次快,能自愈,所以只是如实告知。
						if (health.stale > 0) {
							if (confirm("已是最新版本(v" + latest + ")。\n\n但本地还差 " + health.stale + " 个代码文件没缓存完,启动时会联网补齐(每次启动自动少几个,能自行恢复)。\n\n要现在一次性补齐吗?")) {
								forceReinstallCore("将一次性补齐缺失的核心文件。");
							}
							return;
						}
					}
					// —— 代码是最新的,再看素材有没有变更(改了图但路径不变的那种,代码检查看不见) ——
					btn.textContent = "检查素材…";
					var assetInfo = await inspectAssets();
					if (assetInfo && !assetInfo.dbUnreadable) {
						// 【先补版本号,再比对】unknown = 素材在库里、但版本表里没它。
						// 只有一种来源:升级到版本表机制之前就装进来的老素材。之后所有写入
						// 都由 putAsset/putAssets **同事务**记好版本号,不会再产生未知 ——
						// 这正是把记账塞进写入函数里的目的(以前靠调用方自觉,三个入口忘了两个)。
						// 这一步纯本地:读库 + SHA-256,不联网、不耗流量,而且只需做这一次。
						if (assetInfo.unknown.length) {
							if (confirm("已是最新版本(v" + latest + ")。\n\n有 " + assetInfo.unknown.length + " 个素材的版本号未知(升级前装进来的),要先本地算一遍,才能知道哪些立绘/卡面有更新(改了图但文件名不变的那种)。\n\n现在算?\n\n· 纯本地计算,不联网、不耗流量\n· 素材多时要等一会儿\n· 只需做这一次,之后每次检查都是几百 KB 的清单比对")) {
								btn.textContent = "计算版本 0…";
								await assetInfo.db.backfillVersions(function (n, all) {
									btn.textContent = "计算版本 " + n + "/" + all + "…";
								});
								// 补完立刻用新版本表再比一次,把本来就旧的那些当场报出来
								assetInfo = (await inspectAssets()) || assetInfo;
							}
						}
						if (assetInfo.changed.length) {
							var n2 = assetInfo.changed.length;
							if (confirm("已是最新版本(v" + latest + ")。\n\n发现 " + n2 + " 个素材有更新(立绘/卡面的内容变了,文件名没变)。\n\n现在下载这 " + n2 + " 个?不动其余素材。")) {
								var r2 = await lib.init.downloadOfflineAssets(btn, { onlyList: assetInfo.changed, silent: true });
								// 【不需要在这里记版本号】下载器走 db.putAssets,字节和版本号同事务写入。
								// 以前这里要手动 updateBaseline,而漏记正是“卡面永远查不出更新”的成因。
								alert("已更新 " + (r2 ? r2.done : 0) + "/" + n2 + " 个素材。" + (r2 && r2.failed.length ? "\n有 " + r2.failed.length + " 个没写进本地库,再点一次可补。" : "\n重新打开应用后生效。"));
								return;
							}
						}
					}

					// 一切正常。顺带把体检结果报出来 —— 以后再遇到“缓存好了怎么还慢”,
					// 这一行就能直接说明是不是缓存问题,不用再靠猜。
					// 【报“有多少素材还没记版本号”】素材数 − 已记版本数 = 升级前装进来的那些。
					// 它们没法参与比对,得先本地补算一遍 —— 不报出来,用户只会看到“图永远不更新”。
					var unknownVer = health && health.assets !== null && health.versions !== null ? Math.max(0, health.assets - health.versions) : 0;
					alert(
						"已是最新版本(v" + latest + ")。" +
							(health
								? "\n\n本地缓存:代码 " + health.code + " 个(Cache Storage)+ 素材 " + (health.assets === null ? "读不到(素材库打不开)" : health.assets + " 个") + (health.versions === null ? "" : "，已记版本 " + health.versions + " 个") + "\n代码版本 v" + health.stamp + "(一致,启动直接读缓存)"
								: "") +
							(unknownVer > 20 ? "\n\n⚠ 有 " + unknownVer + " 个素材的版本号未知(升级前装进来的)。再点一次「检查更新」可本地补算,算完才能知道它们是不是旧的。" : "") +
							(assetInfo ? (assetInfo.dbUnreadable ? "\n素材:无法比对(素材库打不开)" : "\n素材:与线上一致" + (assetInfo.added.length ? "(另有 " + assetInfo.added.length + " 个未下载,可用「下载离线资源」补齐)" : "")) : "")
					);
				} catch (e) {
					console.error("检查更新失败:", e);
					alert("检查更新失败:" + (e && e.message ? e.message : e));
				} finally {
					btn.textContent = "检查更新";
					btn.disabled = false;
				}
			});
			// 【为什么要专门一个诊断按钮】"图不更新"查了好几轮,每轮都卡在同一个地方:
			// 手上只有"素材库打不开"这么一句,而它背后至少十几种原因(被占住/
			// 版本升级失败/store 不存在/隐私模式禁用 IDB/配额被回收…),只能靠猜。
			// 这个按钮把**真实错误**和**现场重算的本地哈希**一并报出来 ——
			// 重算哈希是关键:它绕开"版本表是否可信"这个前提,直接回答
			// "我手上这张图到底是不是线上那张"。不联网也能跑(清单拿不到就只报本地部分)。
			var diagBtn = ui.create.node("button", "素材库诊断", async function () {
				var b = this;
				b.disabled = true;
				b.textContent = "诊断中…";
				var out = [];
				try {
					var db = null;
					try {
						db = await import(/* @vite-ignore */ `${rootURL}pwa-asset-db-esm.js`);
					} catch (e) {
						alert("素材库模块都加载不了:" + (e && e.message ? e.message : e));
						return;
					}
					var cnt = await db.countAssets();
					var keys = await db.getAssetKeys();
					var vers = await db.getVersions();
					var err = db.getLastDbError ? db.getLastDbError() : null;
					out.push("素材数: " + (cnt === null ? "读不到" : cnt));
					out.push("键数  : " + (keys === null ? "读不到" : keys.size));
					out.push("版本数: " + (vers === null ? "读不到" : Object.keys(vers).length));
					out.push("错误  : " + (err || "无"));
					// 线上清单(拿不到不影响本地部分)
					var hashes = null;
					try {
						var hr = await fetch("./pwa-asset-hashes.json", { cache: "no-cache" });
						if (hr.ok) hashes = await hr.json();
					} catch (e2) {
						/* 离线就算了 */
					}
					out.push("线上清单: " + (hashes ? Object.keys(hashes).length + " 条" : "拿不到"));
					out.push("");
					// 取几张曹操传卡面逐张对账
					var samples = ["ccz_chixiaojian", "ccz_yuxi", "ccz_baihubaoyu", "ccz_jingkai", "ccz_fangtianhuaji"];
					for (var i = 0; i < samples.length; i++) {
						var rel = "./image/card/" + samples[i] + ".png";
						var pn = new URL(rel, location.href).pathname;
						var online = hashes ? hashes[rel] || "-" : "?";
						var recorded = vers ? vers[pn] || "无记录" : "?";
						var raw = db.getAssetRaw ? await db.getAssetRaw(pn) : null;
						var actual = "库里没有";
						if (raw) {
							try {
								actual = await db.sha16(raw.buf);
							} catch (e3) {
								actual = "算不了";
							}
						}
						var verdict = actual === online ? "✓新" : raw ? "✗旧" : "—";
						out.push(samples[i].replace("ccz_", "") + " " + verdict);
						out.push("  线上 " + online);
						out.push("  字节 " + actual + (raw ? " (" + raw.len + "B)" : ""));
						out.push("  记的 " + recorded + (raw && recorded !== actual && recorded !== "无记录" ? "  ⚠账实不符" : ""));
					}
					console.log("[素材库诊断]" + "\n" + out.join("\n"));
					alert(out.join("\n"));
				} catch (e) {
					alert("诊断本身报错:" + (e && e.message ? e.message : e) + "\n" + "\n" + out.join("\n"));
				} finally {
					b.textContent = "素材库诊断";
					b.disabled = false;
				}
			});
			// 【单独一行】上一版把它和「检查更新」+版本戟挤在同一个 nowrap 的 <p> 里,
			// 手机窄屏上第二个按钮会被推出可视区 —— 按钮在那儿、但人看不到。
			var diagPx = ui.create.node("p");
			diagPx.style.marginTop = "8px";
			updateCheckPx.appendChild(checkUpdateBtn);
			updateCheckPx.appendChild(versionSpan);
			ul.appendChild(updateCheckPx);
			diagPx.appendChild(diagBtn);
			ul.appendChild(diagPx);
		}

		page.appendChild(ul);
	})();
	(function () {
		var norow2 = function () {
			var node = currentrow1;
			if (!node) {
				return false;
			}
			return node.innerHTML == "横置" || node.innerHTML == "翻面" || node.innerHTML == "换人" || node.innerHTML == "复活";
		};
		var checkCheat = function () {
			if (norow2()) {
				for (var i = 0; i < row2.childElementCount; i++) {
					row2.childNodes[i].classList.remove("selectedx");
					row2.childNodes[i].classList.add("unselectable");
				}
			} else {
				for (var i = 0; i < row2.childElementCount; i++) {
					row2.childNodes[i].classList.remove("unselectable");
				}
			}
			if (currentrow1 && currentrow1.innerHTML == "复活") {
				for (var i = 0; i < row3.childNodes.length; i++) {
					if (row3.childNodes[i].dead) {
						row3.childNodes[i].style.display = "";
					} else {
						row3.childNodes[i].style.display = "none";
						row3.childNodes[i].classList.remove("glow");
					}
					row3.childNodes[i].classList.remove("unselectable");
				}
			} else {
				for (var i = 0; i < row3.childElementCount; i++) {
					if (currentrow1 && currentrow1.innerHTML == "换人" && row3.childNodes[i].link == game.me) {
						row3.childNodes[i].classList.add("unselectable");
					} else {
						row3.childNodes[i].classList.remove("unselectable");
					}
					if (!row3.childNodes[i].dead) {
						row3.childNodes[i].style.display = "";
					} else {
						row3.childNodes[i].style.display = "none";
						row3.childNodes[i].classList.remove("glow");
					}
				}
			}
			if (currentrow1 && (currentrow2 || norow2()) && row3.querySelector(".glow")) {
				cheatButton.classList.add("glowing");
				return true;
			} else {
				cheatButton.classList.remove("glowing");
				return false;
			}
		};
		cheatButton.listen(function () {
			if (checkCheat()) {
				var num;
				if (currentrow2) {
					switch (currentrow2.innerHTML) {
						case "一":
							num = 1;
							break;
						case "二":
							num = 2;
							break;
						case "三":
							num = 3;
							break;
						case "四":
							num = 4;
							break;
						case "五":
							num = 5;
							break;
					}
				}
				var targets = [];
				var buttons = row3.querySelectorAll(".glow");
				for (var i = 0; i < buttons.length; i++) {
					targets.push(buttons[i].link);
				}
				while (targets.length) {
					var target = targets.shift();
					switch (currentrow1.innerHTML) {
						case "伤害":
							target.damage(num, "nosource");
							break;
						case "回复":
							target.recover(num, "nosource");
							break;
						case "摸牌":
							target.draw(num);
							break;
						case "弃牌":
							target.discard(target.getCards("he").randomGets(num));
							break;
						case "横置":
							target.link();
							break;
						case "翻面":
							target.turnOver();
							break;
						case "复活":
							target.revive(target.maxHp);
							break;
						case "换人": {
							if (_status.event.isMine()) {
								if (!ui.auto.classList.contains("hidden")) {
									setTimeout(function () {
										ui.click.auto();
										setTimeout(function () {
											ui.click.auto();
											game.swapPlayer(target);
										}, 500);
									});
								}
							} else {
								game.swapPlayer(target);
							}
							break;
						}
					}
				}
				if (ui.coin) {
					game.changeCoin(-20);
				}
				clickContainer.call(cacheMenuContainer, connectMenu);
			}
		});

		var page = ui.create.div("");
		var node = ui.create.div(".menubutton.large", "控制", start.firstChild, clickMode);
		node.link = page;
		node.type = "cheat";
		page.classList.add("menu-sym");

		var currentrow1 = null;
		var row1 = ui.create.div(".menu-cheat", page);
		var clickrow1 = function () {
			if (this.classList.contains("unselectable")) {
				return;
			}
			if (currentrow1 == this) {
				this.classList.remove("selectedx");
				currentrow1 = null;
			} else {
				this.classList.add("selectedx");
				if (currentrow1) {
					currentrow1.classList.remove("selectedx");
				}
				currentrow1 = this;
				if (this.innerHTML == "换人") {
					for (var i = 0; i < row3.childNodes.length; i++) {
						row3.childNodes[i].classList.remove("glow");
					}
				}
			}
			checkCheat();
		};
		var nodedamage = ui.create.div(".menubutton", "伤害", row1, clickrow1);
		var noderecover = ui.create.div(".menubutton", "回复", row1, clickrow1);
		var nodedraw = ui.create.div(".menubutton", "摸牌", row1, clickrow1);
		var nodediscard = ui.create.div(".menubutton", "弃牌", row1, clickrow1);
		var nodelink = ui.create.div(".menubutton", "横置", row1, clickrow1);
		var nodeturnover = ui.create.div(".menubutton", "翻面", row1, clickrow1);
		var noderevive = ui.create.div(".menubutton", "复活", row1, clickrow1);
		var nodereplace = ui.create.div(".menubutton", "换人", row1, clickrow1);
		if (!game.canReplaceViewpoint || !game.canReplaceViewpoint()) {
			nodereplace.classList.add("unselectable");
		}

		var currentrow2 = null;
		var row2 = ui.create.div(".menu-cheat", page);
		var clickrow2 = function () {
			if (this.classList.contains("unselectable")) {
				return;
			}
			if (currentrow2 == this) {
				this.classList.remove("selectedx");
				currentrow2 = null;
			} else {
				this.classList.add("selectedx");
				if (currentrow2) {
					currentrow2.classList.remove("selectedx");
				}
				currentrow2 = this;
			}
			checkCheat();
		};
		var nodex1 = ui.create.div(".menubutton", "一", row2, clickrow2);
		var nodex2 = ui.create.div(".menubutton", "二", row2, clickrow2);
		var nodex3 = ui.create.div(".menubutton", "三", row2, clickrow2);
		var nodex4 = ui.create.div(".menubutton", "四", row2, clickrow2);
		var nodex5 = ui.create.div(".menubutton", "五", row2, clickrow2);

		var row3 = ui.create.div(".menu-buttons.leftbutton.commandbutton", page);
		row3.style.marginTop = "3px";
		var clickrow3 = function () {
			if (this.classList.contains("unselectable")) {
				return;
			}
			this.classList.toggle("glow");
			if (currentrow1 && currentrow1.innerHTML == "换人" && this.classList.contains("glow")) {
				if (this.link == game.me) {
					this.classList.remove("glow");
				}
				for (var i = 0; i < row3.childElementCount; i++) {
					if (row3.childNodes[i] != this) {
						row3.childNodes[i].classList.remove("glow");
					}
				}
			}
			checkCheat();
		};
		menuUpdates.push(function () {
			if (_status.video || _status.connectMode) {
				node.classList.add("off");
				if (node.classList.contains("active")) {
					node.classList.remove("active");
					node.link.remove();
					active = start.firstChild.firstChild;
					active.classList.add("active");
					rightPane.appendChild(active.link);
				}

				page.remove();
				cheatButton.remove();
				if (_status.video) {
					node.remove();
				}
				return;
			}
			var list = [];
			for (var i = 0; i < game.players.length; i++) {
				if (lib.character[game.players[i].name] || game.players[i].name1) {
					list.push(game.players[i]);
				}
			}
			for (var i = 0; i < game.dead.length; i++) {
				if (lib.character[game.dead[i].name] || game.dead[i].name1) {
					list.push(game.dead[i]);
				}
			}
			if (list.length) {
				row1.show();
				row2.show();
				row3.innerHTML = "";
				var buttons = ui.create.buttons(list, "player", row3, true);
				for (var i = 0; i < buttons.length; i++) {
					buttons[i].listen(clickrow3);
					if (game.dead.includes(buttons[i].link)) {
						buttons[i].dead = true;
					}
				}
				checkCheat();
			} else {
				row1.hide();
				row2.hide();
			}
			if (lib.config.mode == "identity" || lib.config.mode == "guozhan" || lib.config.mode == "doudizhu") {
				if (
					game.notMe ||
					(game.me &&
						(game.me._trueMe ||
							game.hasPlayer(function (current) {
								return current._trueMe == game.me;
							}))) ||
					!game.phaseNumber ||
					_status.qianlidanji
				) {
					nodereplace.classList.add("unselectable");
				} else if (_status.event.isMine() && ui.auto.classList.contains("hidden")) {
					nodereplace.classList.add("unselectable");
				} else {
					nodereplace.classList.remove("unselectable");
				}
			}
			if (game.dead.length == 0) {
				noderevive.classList.add("unselectable");
			} else {
				noderevive.classList.remove("unselectable");
			}
			checkCheat();
		});
	})();
	(function () {
		var page = ui.create.div("");
		var node = ui.create.div(".menubutton.large", "命令", start.firstChild, clickMode);
		ui.commandnode = node;
		node.type = "cmd";
		menuUpdates.push(function () {
			if (_status.connectMode) {
				node.classList.add("off");
				if (node.classList.contains("active")) {
					node.classList.remove("active");
					if (node.link) {
						node.link.remove();
					}
					active = start.firstChild.firstChild;
					active.classList.add("active");
					rightPane.appendChild(active.link);
				}
			}
		});
		node._initLink = function () {
			node.link = page;
			page.classList.add("menu-sym");

			const text = document.createElement("div");
			text.css({
				width: "194px",
				height: "124px",
				padding: "3px",
				borderRadius: "2px",
				boxShadow: "rgba(0, 0, 0, 0.2) 0 0 0 1px",
				textAlign: "left",
				webkitUserSelect: "initial",
				overflow: "scroll",
				position: "absolute",
				left: "30px",
				top: "50px",
				wordBreak: "break-all",
			});

			const pre = ui.create.node("pre.fullsize", text);
			text.css.call(pre, {
				margin: "0",
				padding: "0",
				position: "relative",
				webkitUserSelect: "text",
				userSelect: "text",
			});
			lib.setScroll(pre);
			page.appendChild(text);

			const text2 = document.createElement("input");
			text.css.call(text2, {
				width: "200px",
				height: "20px",
				padding: "0",
				position: "absolute",
				top: "15px",
				left: "30px",
				resize: "none",
				border: "none",
				borderRadius: "2px",
				boxShadow: "rgba(0, 0, 0, 0.2) 0 0 0 1px",
			});

			const g = {};
			const logs = [];
			let logindex = -1;
			let proxyWindow = Object.assign({}, window, {
				_status: _status,
				lib: lib,
				game: game,
				ui: ui,
				get: get,
				ai: ai,
				cheat: lib.cheat,
			});
			if (security.isSandboxRequired()) {
				const { Monitor, AccessAction } = security.importSandbox();
				new Monitor()
					.action(AccessAction.DEFINE)
					.action(AccessAction.WRITE)
					.action(AccessAction.DELETE)
					.require("target", proxyWindow)
					.require("property", "_status", "lib", "game", "ui", "get", "ai", "cheat")
					.then((access, nameds, control) => {
						if (access.action == AccessAction.DEFINE) {
							control.preventDefault();
							control.stopPropagation();
							control.setReturnValue(false);
							return;
						}

						//
						control.overrideParameter("target", window);
					})
					.start();
			} else {
				const keys = ["_status", "lib", "game", "ui", "get", "ai", "cheat"];

				for (const key of keys) {
					const descriptor = Reflect.getOwnPropertyDescriptor(proxyWindow, key);
					if (!descriptor) {
						continue;
					}
					descriptor.writable = false;
					descriptor.enumerable = true;
					descriptor.configurable = false;
					Reflect.defineProperty(proxyWindow, key, descriptor);
				}

				proxyWindow = new Proxy(proxyWindow, {
					set(target, propertyKey, value, receiver) {
						if (typeof propertyKey == "string" && keys.includes(propertyKey)) {
							return Reflect.set(target, propertyKey, value, receiver);
						}

						return Reflect.set(window, propertyKey, value);
					},
				});
			}
			//使用new Function隔绝作用域，避免在控制台可以直接访问到runCommand等变量
			/**
			 * @type { (value:string)=>any }
			 */
			let fun;
			if (security.isSandboxRequired()) {
				const reg = /^\{([^{}]+:\s*([^\s,]*|'[^']*'|"[^"]*"|\{[^}]*\}|\[[^\]]*\]|null|undefined|([a-zA-Z$_][a-zA-Z0-9$_]*\s*:\s*)?[a-zA-Z$_][a-zA-Z0-9$_]*\(\)))(?:,\s*([^{}]+:\s*(?:[^\s,]*|'[^']*'|"[^"]*"|\{[^}]*\}|\[[^\]]*\]|null|undefined|([a-zA-Z$_][a-zA-Z0-9$_]*\s*:\s*)?[a-zA-Z$_][a-zA-Z0-9$_]*\(\))))*\}$/;
				fun = function (value) {
					const exp = reg.test(value) ? `(${value})` : value;
					const expName = "_" + Math.random().toString().slice(2);
					return security.exec(`return eval(${expName})`, { window: proxyWindow, [expName]: exp });
				};
				// security.exec(`
				// 	const _status=window._status;
				// 	const lib=window.lib;
				// 	const game=window.game;
				// 	const ui=window.ui;
				// 	const get=window.get;
				// 	const ai=window.nonameAI;
				// 	// const cheat=window.lib.cheat; // 不再允许使用 cheat，因为它是不允许访问的变量
				// 	//使用正则匹配绝大多数的普通obj对象，避免解析成代码块。
				// 	const reg=${/^\{([^{}]+:\s*([^\s,]*|'[^']*'|"[^"]*"|\{[^}]*\}|\[[^\]]*\]|null|undefined|([a-zA-Z$_][a-zA-Z0-9$_]*\s*:\s*)?[a-zA-Z$_][a-zA-Z0-9$_]*\(\)))(?:,\s*([^{}]+:\s*(?:[^\s,]*|'[^']*'|"[^"]*"|\{[^}]*\}|\[[^\]]*\]|null|undefined|([a-zA-Z$_][a-zA-Z0-9$_]*\s*:\s*)?[a-zA-Z$_][a-zA-Z0-9$_]*\(\))))*\}$/};
				// 	return function(value){
				// 		"use strict";
				// 		return eval(reg.test(value)?('('+value+')'):value);
				// 	};
				// `, { window: proxyWindow });
			} else {
				fun = new Function(
					"window",
					dedent`
					const _status=window._status;
					const lib=window.lib;
					const game=window.game;
					const ui=window.ui;
					const get=window.get;
					const ai=window.nonameAI;
					const cheat=window.lib.cheat;
					//使用正则匹配绝大多数的普通obj对象，避免解析成代码块。
					const reg=${/^\{([^{}]+:\s*([^\s,]*|'[^']*'|"[^"]*"|\{[^}]*\}|\[[^\]]*\]|null|undefined|([a-zA-Z$_][a-zA-Z0-9$_]*\s*:\s*)?[a-zA-Z$_][a-zA-Z0-9$_]*\(\)))(?:,\s*([^{}]+:\s*(?:[^\s,]*|'[^']*'|"[^"]*"|\{[^}]*\}|\[[^\]]*\]|null|undefined|([a-zA-Z$_][a-zA-Z0-9$_]*\s*:\s*)?[a-zA-Z$_][a-zA-Z0-9$_]*\(\))))*\}$/};
					return function(value){ 
						"use strict";
						return eval(reg.test(value)?('('+value+')'):value);
					}
				`
				)(proxyWindow);
			}
			const runCommand = () => {
				if (text2.value && !["up", "down"].includes(text2.value)) {
					logindex = -1;
					logs.unshift(text2.value);
				}
				if (text2.value == "cls") {
					pre.innerHTML = "";
					text2.value = "";
				} else if (text2.value == "up") {
					if (logindex + 1 < logs.length) {
						text2.value = logs[++logindex];
					} else {
						text2.value = "";
					}
				} else if (text2.value == "down") {
					if (logindex >= 0) {
						logindex--;
						if (logindex < 0) {
							text2.value = "";
						} else {
							text2.value = logs[logindex];
						}
					} else {
						text2.value = "";
					}
				} else if (text2.value.includes("无天使") && (text2.value.includes("无神佛") || (text2.value.includes("无神") && text2.value.includes("无佛")))) {
					game.print("密码正确！欢迎来到死后世界战线！");
					_status.keyVerified = true;
					text2.value = "";
				} else {
					if (!game.observe && !game.online) {
						try {
							let value = text2.value.trim();
							if (value.endsWith(";")) {
								value = value.slice(0, -1).trim();
							}
							game.print(fun(value));
						} catch (e) {
							game.print(e);
						}
					}
					text2.value = "";
				}
			};
			text2.addEventListener("keydown", e => {
				if (e.key == "Enter") {
					runCommand();
				} else if (e.key == "ArrowUp") {
					if (logindex + 1 < logs.length) {
						text2.value = logs[++logindex];
					}
				} else if (e.key == "ArrowDown") {
					if (logindex >= 0) {
						logindex--;
						if (logindex < 0) {
							text2.value = "";
						} else {
							text2.value = logs[logindex];
						}
					}
				}
			});
			page.appendChild(text2);
			game.print = function () {
				const args = [...arguments];
				const printResult = args
					.map(arg => {
						if (typeof arg != "string") {
							const parse = obj => {
								if (Array.isArray(obj)) {
									return `[${obj.map(v => parse(v))}]`;
								} else if (typeof obj == "function") {
									if (typeof obj.name == "string") {
										return `[Function ${obj.name}]`;
									} else {
										return `[Function]`;
									}
								} else if (typeof obj != "string") {
									if (obj instanceof Error) {
										return `<span style="color:red;">${String(obj)}</span>`;
									}
									return String(obj);
								} else {
									return `'${String(obj)}'`;
								}
							};
							if (typeof arg == "function") {
								let argi;
								try {
									argi = get.stringify(arg);
									if (argi === "") {
										argi = arg.toString();
									}
								} catch (_) {
									argi = arg.toString();
								}
								return argi.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
							} else if (typeof arg == "object") {
								let msg = "";
								for (const name of Object.getOwnPropertyNames(arg)) {
									msg += `${name}: ${parse(arg[name])}<br>`;
								}
								return `<details><summary>${parse(arg)}</summary>${msg}</details>`;
							} else {
								return parse(arg);
							}
						} else {
							const str = String(arg);
							if (!/<[a-zA-Z]+[^>]*?\/?>.*?(?=<\/[a-zA-Z]+[^>]*?>|$)/.exec(str)) {
								return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
							} else {
								return str;
							}
						}
					})
					.join(" ");
				pre.innerHTML += printResult + "<br>";
				text.scrollTop = text.scrollHeight;
			};
			if (_status.toprint) {
				game.print(..._status.toprint);
				delete _status.toprint;
			}
			runButton.listen(runCommand);
			clearButton.listen(() => {
				pre.innerHTML = "";
			});
			if (typeof window.noname_shijianInterfaces?.showDevTools == "function") {
				game.print("点击以下按钮\n将开启诗笺版内置的控制台");
				game.print("<button onclick='window.noname_shijianInterfaces.showDevTools();'>开启DevTools</button>");
			}
		};
		if (!get.config("menu_loadondemand")) {
			node._initLink();
		}
	})();
	(function () {
		var page = ui.create.div("");
		var node = ui.create.div(".menubutton.large", "内核", start.firstChild, clickMode);
		node._initLink = function () {
			node.link = page;
			page.classList.add("menu-sym");

			const coreInfo = get.coreInfo();

			const agent = document.createElement("div");
			agent.css({
				margin: "10px 0",
				textAlign: "left",
			});
			let agentText = dedent`浏览器内核: ${coreInfo[0]}<br/>
			浏览器版本: ${coreInfo[1]}.${coreInfo[2]}.${coreInfo[3]}<br/>`;

			if (lib.device === "android") {
				agentText += dedent`应用平台: 安卓<br/>`;

				if (typeof window.NonameAndroidBridge?.getPackageName === "function") {
					agentText += dedent`安卓应用包名: ${window.NonameAndroidBridge.getPackageName()}<br/>`;
				}

				if (typeof window.NonameAndroidBridge?.getPackageVersionCode === "function") {
					agentText += dedent`安卓应用版本: ${window.NonameAndroidBridge.getPackageVersionCode()}<br/>`;
				}

				if (typeof window.device === "object") {
					agentText += dedent`安卓版本: ${device.version}<br/>
					安卓SDK版本: ${device.sdkVersion}<br/>
					设备制造商: ${device.manufacturer}<br/>`;
				}
			} else if (lib.device === "ios") {
				agentText += dedent`应用平台: 苹果<br/>`;
			} else if (typeof window.require == "function" && typeof window.process == "object" && typeof window.__dirname == "string") {
				agentText += dedent`应用平台: Electron<br/>
				Electron版本: ${process.versions.electron}<br/>`;
			}

			agent.innerHTML = agentText;

			page.appendChild(agent);

			const button = document.createElement("button");
			button.classList.add("changeWebviewProvider");
			button.innerText = "点击切换WebView实现";
			button.addEventListener("click", function () {
				if (typeof window.NonameAndroidBridge?.changeWebviewProvider === "function") {
					window.NonameAndroidBridge.changeWebviewProvider();
				} else {
					alert("此客户端不支持此功能");
				}
			});
			page.appendChild(button);
		};
		if (!get.config("menu_loadondemand")) {
			node._initLink();
		}
	})();
	(function () {
		var page = ui.create.div("");
		var node = ui.create.div(".menubutton.large", "战绩", start.firstChild, clickMode);
		node.type = "rec";
		node._initLink = function () {
			node.link = page;
			page.style.paddingBottom = "10px";
			var reset = function () {
				if (this.innerHTML == "重置") {
					this.innerHTML = "确定";
					var that = this;
					setTimeout(function () {
						that.innerHTML = "重置";
					}, 1000);
				} else {
					this.parentNode.previousSibling.remove();
					this.parentNode.remove();
					lib.config.gameRecord[this.parentNode.link] = { data: {} };
					game.saveConfig("gameRecord", lib.config.gameRecord);
				}
			};
			for (var i = 0; i < lib.config.all.mode.length; i++) {
				if (!lib.config.gameRecord[lib.config.all.mode[i]]) {
					continue;
				}
				if (lib.config.gameRecord[lib.config.all.mode[i]].str) {
					ui.create.div(".config.indent", lib.translate[lib.config.all.mode[i]], page).style.marginBottom = "-5px";
					var item = ui.create.div(".config.indent", lib.config.gameRecord[lib.config.all.mode[i]].str + "<span>重置</span>", page);
					item.style.height = "auto";
					item.lastChild.addEventListener("click", reset);
					item.lastChild.classList.add("pointerdiv");
					item.link = lib.config.all.mode[i];
				}
			}
		};
		if (!get.config("menu_loadondemand")) {
			node._initLink();
		}
	})();
	(function () {
		if (!window.indexedDB || window.nodb) {
			return;
		}
		var page = ui.create.div("");
		var node = ui.create.div(".menubutton.large", "录像", start.firstChild, clickMode);
		node.type = "video";
		lib.videos = [];
		ui.create.videoNode = (video, before) => {
			lib.videos.remove(video);
			if (_status.over) {
				return;
			}
			lib.videos[before === true ? "unshift" : "push"](video);
		};
		node._initLink = function () {
			node.link = page;
			var store = lib.db.transaction(["video"], "readwrite").objectStore("video");
			store.openCursor().onsuccess = function (e) {
				var cursor = e.target.result;
				if (cursor) {
					lib.videos.push(cursor.value);
					cursor.continue();
				} else {
					lib.videos.sort(function (a, b) {
						return parseInt(b.time) - parseInt(a.time);
					});
					var clickcapt = function () {
						var current = this.parentNode.querySelector(".videonode.active");
						if (current && current != this) {
							current.classList.remove("active");
						}
						if (this.classList.toggle("active")) {
							playButton.show();
							deleteButton.show();
							saveButton.show();
						} else {
							playButton.hide();
							deleteButton.hide();
							saveButton.hide();
						}
					};
					var staritem = function () {
						this.parentNode.classList.toggle("starred");
						var store = lib.db.transaction(["video"], "readwrite").objectStore("video");
						if (this.parentNode.classList.contains("starred")) {
							this.parentNode.link.starred = true;
						} else {
							this.parentNode.link.starred = false;
						}
						store.put(this.parentNode.link);
					};
					var createNode = function (video, before) {
						var node = ui.create.div(".videonode.menubutton.large", clickcapt);
						node.link = video;
						var nodename1 = ui.create.div(".menubutton.videoavatar", node);
						nodename1.setBackground(video.name1, "character");
						if (video.name2) {
							var nodename2 = ui.create.div(".menubutton.videoavatar2", node);
							nodename2.setBackground(video.name2, "character");
						}
						var date = new Date(video.time);
						var str = date.getFullYear() + "." + (date.getMonth() + 1) + "." + date.getDate() + " " + date.getHours() + ":";
						var minutes = date.getMinutes();
						if (minutes < 10) {
							str += "0";
						}
						str += minutes;
						ui.create.div(".caption", video.name[0], node);
						ui.create.div(".text", str + "<br>" + video.name[1], node);
						if (video.win) {
							ui.create.div(".victory", "胜", node);
						}

						if (before) {
							page.insertBefore(node, page.firstChild);
						} else {
							page.appendChild(node);
						}
						ui.create.div(".video_star", "★", node, staritem);
						if (video.starred) {
							node.classList.add("starred");
						}
					};
					for (var i = 0; i < lib.videos.length; i++) {
						createNode(lib.videos[i]);
					}
					ui.create.videoNode = createNode;
					var importVideoNode = ui.create.div(
						".config.switcher.pointerspan",
						'<span class="underlinenode slim ">导入录像...</span>',
						function () {
							this.nextSibling.classList.toggle("hidden");
						},
						page
					);
					importVideoNode.style.marginLeft = "12px";
					importVideoNode.style.marginTop = "3px";
					var importVideo = ui.create.div(".config.hidden", page);
					importVideo.style.whiteSpace = "nowrap";
					importVideo.style.marginBottom = "80px";
					importVideo.style.marginLeft = "13px";
					importVideo.style.width = "calc(100% - 30px)";
					importVideo.innerHTML = '<input type="file" accept="*/*" style="width:calc(100% - 40px)">' + '<button style="width:40px">确定</button>';
					importVideo.lastChild.onclick = function () {
						var fileToLoad = importVideo.firstChild.files[0];
						var fileReader = new FileReader();
						fileReader.onload = function (fileLoadedEvent) {
							var data = fileLoadedEvent.target.result;
							if (!data) {
								return;
							}
							try {
								data = JSON.parse(lib.init.decode(data));
							} catch (e) {
								console.log(e);
								alert("导入失败");
								return;
							}
							var store = lib.db.transaction(["video"], "readwrite").objectStore("video");
							var videos = lib.videos.slice(0);
							for (var i = 0; i < videos.length; i++) {
								if (videos[i].starred) {
									videos.splice(i--, 1);
								}
							}
							for (var deletei = 0; deletei < 5; deletei++) {
								if (videos.length >= parseInt(lib.config.video) && videos.length) {
									var toremove = videos.pop();
									lib.videos.remove(toremove);
									store.delete(toremove.time);
									for (var i = 0; i < page.childNodes.length; i++) {
										if (page.childNodes[i].link == toremove) {
											page.childNodes[i].remove();
											break;
										}
									}
								} else {
									break;
								}
							}
							for (var i = 0; i < lib.videos.length; i++) {
								if (lib.videos[i].time == data.time) {
									alert("录像已存在");
									return;
								}
							}
							lib.videos.unshift(data);
							store.put(data);
							createNode(data, true);
						};
						fileReader.readAsText(fileToLoad, "UTF-8");
					};

					playButton.listen(function () {
						var current = this.parentNode.querySelector(".videonode.active");
						if (current) {
							game.playVideo(current.link.time, current.link.mode);
						}
					});
					deleteButton.listen(function () {
						var current = this.parentNode.querySelector(".videonode.active");
						if (current) {
							lib.videos.remove(current.link);
							var store = lib.db.transaction(["video"], "readwrite").objectStore("video");
							store.delete(current.link.time);
							current.remove();
						}
					});
					saveButton.listen(function () {
						var current = this.parentNode.querySelector(".videonode.active");
						if (current) {
							game.export(lib.init.encode(JSON.stringify(current.link)), "无名杀 - 录像 - " + current.link.name[0] + " - " + current.link.name[1]);
						}
					});

					ui.updateVideoMenu = function () {
						var active = start.firstChild.querySelector(".active");
						if (active) {
							active.classList.remove("active");
							active.link.remove();
						}
						node.classList.add("active");
						rightPane.appendChild(page);
						playButton.style.display = "";
						deleteButton.style.display = "";
						saveButton.style.display = "";
					};
				}
			};
		};
		if (!get.config("menu_loadondemand")) {
			node._initLink();
		}
	})();

	for (const [name, content] of Object.entries(lib.help)) {
		// 创建帮助页面的内容元素
		const page = ui.create.div("");
		// 创建帮助按钮
		// TODO: 对是否应该对按钮进行其他框架的挂载处理
		var node = ui.create.div(".menubutton.large", name, start.firstChild, clickMode);
		// 设置帮助按钮的类型
		Reflect.set(node, "type", "help");
		// 初始化帮助按钮的链接
		Reflect.set(node, "link", page);
		// 在非帮助页面下默认隐藏
		node.style.display = "none";
		// 设置帮助页面的类名
		page.classList.add("menu-help");

		// 若传递的内容为对象，则特殊处理
		if (typeof content == "object") {
			/** @type {object} */
			const contentObject = content;

			// 如果对象拥有"mount"方式，则调用该方法进行挂载
			if (typeof contentObject.mount == "function") {
				contentObject.mount(page);
			}
			// 如果对象拥有"data"方式或"setup"方式，则视为vue组件
			else if (typeof contentObject.data == "function" || typeof contentObject.setup == "function") {
				// 创建vue组件
				const component = createApp(contentObject);
				// 挂载到页面
				component.mount(page);
			}
			// 否则相信`Object#toString`的结果
			else {
				page.innerHTML = content;
			}
		}
		// 否则将视为字符串，直接创建文本元素
		else {
			page.innerHTML = content;
		}
	}

	if (!connectMenu) {
		var node = ui.create.div(".menubutton.large", "帮助", start.firstChild, function () {
			var activex = start.firstChild.querySelector(".active");
			if (this.innerHTML == "帮助") {
				cheatButton.style.display = "none";
				runButton.style.display = "none";
				clearButton.style.display = "none";
				playButton.style.display = "none";
				saveButton.style.display = "none";
				deleteButton.style.display = "none";

				this.innerHTML = "返回";
				for (var i = 0; i < start.firstChild.childElementCount; i++) {
					var nodex = start.firstChild.childNodes[i];
					if (nodex == node) {
						continue;
					}
					if (nodex.type == "help") {
						nodex.style.display = "";
						if (activex && activex.type != "help") {
							activex.classList.remove("active");
							activex.link.remove();
							activex = null;
							nodex.classList.add("active");
							rightPane.appendChild(nodex.link);
						}
					} else {
						nodex.style.display = "none";
					}
				}
			} else {
				this.innerHTML = "帮助";
				for (var i = 0; i < start.firstChild.childElementCount; i++) {
					var nodex = start.firstChild.childNodes[i];
					if (nodex == node) {
						continue;
					}
					if (nodex.type != "help") {
						nodex.style.display = "";
						if (activex && activex.type == "help") {
							activex.classList.remove("active");
							activex.link.remove();
							activex = null;
							clickMode.call(nodex);
						}
					} else {
						nodex.style.display = "none";
					}
				}
			}
		});
	}

	var active = start.firstChild.querySelector(".active");
	if (!active) {
		active = start.firstChild.firstChild;
		active.classList.add("active");
	}
	if (!active.link) {
		active._initLink();
	}
	rightPane.appendChild(active.link);
};
