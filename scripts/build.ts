import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

/** 执行子命令,非 0 退出码立即终止并报清楚是哪条命令失败 */
function run(cmd: string) {
	const r = spawnSync(cmd, { shell: true, stdio: "inherit" });
	if (r.status !== 0) {
		throw new Error(`构建命令失败(退出码 ${r.status}): ${cmd}`);
	}
}

// 先显式构建本体(core,包名 noname)及其工作区依赖(fs/jit)。
// 注意:`-F noname...` 的 `...` 依赖语法在不同 pnpm 版本行为不一致
// (pnpm 10 曾在 CI 中漏掉 core 本体),故构建后显式校验产物存在。
run("pnpm -F noname... build");
if (!existsSync("apps/core/dist")) {
	throw new Error("apps/core/dist 未生成——core 本体未被构建(检查 pnpm 版本 / -F 过滤器是否匹配到 noname 包)");
}

run("pnpm -F ./packages/extension/** build");

console.log("合并打包结果");
await fs.rm("dist", { recursive: true, force: true });
await fs.mkdir("dist", { recursive: true });
await Promise.all([
	fs.cp("apps/core/dist", "dist", { recursive: true }),
	fs.cp("apps/core/audio", "dist/audio", { recursive: true }),
	fs.cp("apps/core/image", "dist/image", { recursive: true }),
	fs.cp("apps/core/extension", "dist/extension", { recursive: true }),
	fs.cp("docs", "dist/docs", { recursive: true }),
	fs.cp(".nomedia", "dist/.nomedia"),
	fs.cp("LICENSE", "dist/LICENSE"),
	fs.cp("README.md", "dist/README.md"),
	// PWA:清单与离线缓存 SW(纯静态部署可安装、离线可玩)
	fs.cp("apps/core/manifest.webmanifest", "dist/manifest.webmanifest"),
	fs.cp("apps/core/pwa-sw.js", "dist/pwa-sw.js")
]);
