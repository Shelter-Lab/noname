import { menuContainer, menuxpages, menuUpdates, openMenu, clickToggle, clickSwitcher, clickContainer, clickMenuItem, createMenu, createConfig } from "../index.js";
import { ui, game, get, ai, lib, _status } from "noname";
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
				var timer = setTimeout(function () {
					controller.abort();
				}, 8000);
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
			 * @returns {Promise<{stamp:string|null,stale:number,entries:number}|null>}
			 *          stamp = 缓存里这批代码的构建戳;stale = 还差几个文件没补齐;null = 读不到缓存
			 */
			async function inspectCache() {
				if (!("caches" in window)) return null;
				try {
					// 【必须是代码桶】拆桶后构建戳和待补名单都写在 noname-code-v1 里(见 pwa-sw.js 的
					// CODE_CACHE / BUILD_KEY);这里原来还开着素材桶 noname-pwa-v2,读出来恒为 null。
					// 以前这只让显示行少一段字,现在上面"要刷新还是要重装"的判断靠它,读错就会把
					// "已经装好了、刷新就能生效"误判成"没装齐",反过来劝用户白下 30MB。
					var cache = await caches.open("noname-code-v1");
					var rec = await cache.match("/__pwa_build__");
					var stampInCache = rec ? await rec.text() : null;
					var staleRec = await cache.match("/__pwa_stale__");
					var staleList = staleRec ? await staleRec.json() : [];
					var keys = await cache.keys();
					return {
						stamp: /^\d{10}$/.test(String(stampInCache || "")) ? stampInCache : null,
						stale: Array.isArray(staleList) ? staleList.length : 0,
						entries: keys.length,
					};
				} catch (e) {
					return null;
				}
			}

			/**
			 * 缓存里那份 index.html 是哪一版 —— 也就是"现在刷新的话,刷完会显示哪个版本戳"。
			 * 【为什么必须直接读它,不能拿 BUILD_KEY 推】戳写死在 index.html 里,而刷新走的是
			 * 导航请求 = Cache-First(见 pwa-sw.js 导航分支),读的就是这份缓存副本。
			 * 而 BUILD_KEY 只是 install 的记账:install 拿不到清单时,catch 分支照样会把**新**戳
			 * 写进 BUILD_KEY(只是同时把整份清单记成待补),这时首页其实一个字节都没换 ——
			 * 拿 BUILD_KEY 判断就会误报"已下载完成,刷新即可生效",刷完还是老戳,正是要治的病。
			 * 读取顺序必须和导航分支的匹配顺序一致(req → "/" → "/index.html" → "./index.html"),
			 * 谁先命中用谁,否则预测的和刷出来的不是同一份。
			 * @returns {Promise<string|null>} 10 位构建戳;null = 读不到或解析不出
			 */
			async function cachedIndexStamp() {
				if (!("caches" in window)) return null;
				try {
					var cache = await caches.open("noname-code-v1");
					var rec = (await cache.match(location.href.split("#")[0])) || (await cache.match("/")) || (await cache.match("/index.html")) || (await cache.match("./index.html"));
					if (!rec) return null;
					var m = (await rec.text()).match(/__PWA_RUNNING_BUILD__\s*=\s*"(\d{10})"/);
					return m ? m[1] : null;
				} catch (e) {
					return null;
				}
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
						wantReload = confirm("发现新版本,正在下载…\n\n下载完成后自动刷新页面生效?(已下载的离线素材会保留)\n选「取消」则不刷新,下次打开时自然生效。");
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
						// 【不能无条件 location.reload() —— 这就是"点了好、重开版本戳还是老的"的原因】
						// 版本戳写死在 index.html 里,而导航请求走 Cache-First(见 pwa-sw.js 导航分支):
						// 刷新读的是**缓存里那份** index.html,不是服务器上的。缓存里换没换成新版,
						// 完全取决于 install 有没有整批跑完 —— 而 install 是 cache:"reload" 全量重下
						// 30MB,在手机上被系统掐断是常态,掐断后下次又从头开始。
						// 没装齐就刷,刷一百次也还是老戳(用户实测"好几次都这样"就是这个),
						// 而弹窗还写着"新版已下载完成",纯属撒谎。
						// 故先看缓存里那份首页(= 刷新会读到的那份)到底是哪一版,再决定刷还是重装。
						var htmlStamp = await cachedIndexStamp();
						if (htmlStamp === latest) {
							// 缓存里的首页确实已是新版,只是本页面内存里跑着旧代码 → 刷新真能生效
							if (confirm("发现新版本 v" + latest + "(当前 v" + runningStamp + ")。\n新版已下载完成,刷新页面即可生效。\n\n现在刷新?(进行中的对局会中断)")) {
								location.reload();
							}
							return;
						}
						// 缓存里还是旧首页 → 刷新纯属白刷。如实说明,并给出唯一真正管用的手段:
						// __pwaRepair 用一次性查询串绕开 SW、并发重灌整批代码文件(含首页的每个 key)、
						// 装完补戳,全程不依赖 install。
						// 【为什么不退而求其次"只重取首页"】首页换了、js 还是旧的就是跨版本混搭 ——
						// 正是 index.html 里那套自修复要治的病(模块图链接 SyntaxError)。要换就整批换。
						forceReinstallCore("发现新版本 v" + latest + "(当前 v" + runningStamp + "),但新版还没在本地装齐" + (htmlStamp ? "(本地首页仍是 v" + htmlStamp + ")" : "") + "。\n\n此时刷新页面没有用:刷新读的是缓存里那份旧首页,版本戳不会变 —— 后台自动安装被系统中断时就是这个症状。");
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
					// 一切正常。顺带把体检结果报出来 —— 以后再遇到"缓存好了怎么还慢",
					// 这一行就能直接说明是不是缓存问题,不用再靠猜。
					alert("已是最新版本(v" + latest + ")。" + (health ? "\n\n本地缓存:" + health.entries + " 个文件,代码版本 v" + health.stamp + "(一致,启动直接读缓存)" : ""));
				} catch (e) {
					console.error("检查更新失败:", e);
					alert("检查更新失败:" + (e && e.message ? e.message : e));
				} finally {
					btn.textContent = "检查更新";
					btn.disabled = false;
				}
			});
			updateCheckPx.appendChild(checkUpdateBtn);
			updateCheckPx.appendChild(versionSpan);
			ul.appendChild(updateCheckPx);
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
