import { lib, game, get, _status, ui, ai } from "noname";
import { boot } from "@/init/index.js";
import { userAgentLowerCase, device } from "@/util/index.js";
import "core-js-bundle";
// 保证打包时存在(importmap)
import "vue/dist/vue.esm-browser.js";

(async () => {
	try {
		lib.device = device;

		// 预加载脚本
		const path = "/preload.js";
		const { default: preload } = await import(/* @vite-ignore */ path).catch(() => {
			// Electron平台
			if (typeof window.require === "function") {
				return import("./init/node.js");
			} else {
				// 仅在“确实是移动端客户端/cordova环境”时才走 cordova 分支；
				// 否则（如 macOS 桌面 Safari/Chrome、普通手机浏览器）应走 browser 分支，避免请求 /cordova.js 并卡死在 deviceready。
				const isCordovaLike = typeof window.cordova !== "undefined" || typeof window.NonameAndroidBridge !== "undefined" || typeof window.noname_shijianInterfaces !== "undefined";

				if (import.meta.env.DEV || typeof lib.device == "undefined" || !isCordovaLike) {
					return import("./init/browser.js");
				} else {
					return import("./init/cordova.js");
				}
			}
		});
		await preload({ lib, game, get, _status, ui, ai });

		// GPL确认
		if (!localStorage.getItem("gplv3_noname_alerted")) {
			if (
				confirm(`①无名杀是一款基于GPLv3协议的开源软件
你可以在遵守GPLv3协议的基础上任意使用，修改并转发《无名杀》，以及所有基于《无名杀》开发的扩展
点击“确定”即代表您认可并接受GPLv3协议↓️
https://www.gnu.org/licenses/gpl-3.0.html
②无名杀官方发布地址仅有GitHub仓库
其他所有的所谓“无名杀”社群（包括但不限于绝大多数“官方”QQ群、QQ频道等）均为玩家自发组织，与无名杀官方无关`)
			) {
				localStorage.setItem("gplv3_noname_alerted", String(true));
			} else {
				game.exit();
				return;
			}
		}

		await boot();
		// 启动成功,清除重试标记
		sessionStorage.removeItem("noname_boot_retried");
	} catch (e) {
		console.error(e);
		// 纯静态/PWA 冷启动时,首次要并发拉取大量资源且 Service Worker 尚未接管,
		// iOS Safari 下偶发请求失败导致启动中断(错误常为 undefined)。
		// 自动重试一次:重载后 SW 已缓存资源,大概率成功。仅重试一次,避免死循环。
		if (!sessionStorage.getItem("noname_boot_retried")) {
			sessionStorage.setItem("noname_boot_retried", "1");
			location.reload();
			return;
		}
		sessionStorage.removeItem("noname_boot_retried");
		const detail = e instanceof Error ? e.stack || e.message : e === undefined || e === null ? "(无错误详情,通常是网络加载资源失败,请检查网络后重新打开)" : String(e);
		alert(`《无名杀》加载内容失败
浏览器UA信息:
${userAgentLowerCase}
错误信息:
${detail}
若您不理解该信息，请依次检查：
1. 网络是否正常（首次加载需联网下载资源）
2. 游戏文件是否完整（重新下载完整包）
3. 浏览器是否需要更新
4. 若以上步骤均无法解决问题，请及时向开发组反馈`);
	}
})();
