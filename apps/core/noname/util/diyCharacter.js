/**
 * PWA 自建武将（DIY 武将）
 *
 * 纯静态 PWA 下内置「制作扩展」走不通：扩展代码靠 init/import.ts 的原生 import() 去 fetch
 * 一个真实 HTTP 路径 /extension/<名>/extension.js，CDN 上不存在，重启即「扩展加载失败」。
 *
 * 所以这里换一条路：不生成任何源码，武将定义以纯 JSON 存 IndexedDB 的 data 仓，
 * 立绘存 image 仓（Blob），启动时读出来直接注入 lib.character 等运行期表。
 * 技能只允许挑现成的（lib.skill 里已有的），因此完全不需要 eval / sandbox。
 *
 * 立绘走 Character.img 字段（data: URL）：
 * - get.skinPath / setBackground 都优先读 nameinfo.img（get/index.js:7553、polyfill.ts:207）
 * - setBackgroundImage 对 URL.canParse 为真的绝对 URL 原样放行（polyfill.ts:256），
 *   且 lib.assetURL 为空串，所以就算走数组分支拼前缀也仍是合法 data URL
 */
import { lib, game, get } from "noname";

/** IndexedDB data 仓里存武将 JSON 的 key */
const INDEX_KEY = "pwa_diy_characters";
/** 注入时用的武将包名，需与 lib.characterPack / lib.translate 的约定一致 */
export const PACK_NAME = "pwa_diy";
/** 立绘在 image 仓里的 key 前缀 */
const IMAGE_PREFIX = "pwa_diy:";
/** 「包开关是否已初始化过」标记，用来区分「用户主动关了」和「首次还没默认开」 */
const PACK_NAME_INITED = "pwa_diy_pack_inited";

/**
 * 一条 DIY 武将记录
 * @typedef {Object} DiyCharacter
 * @property {string} name 武将 id（英文/拼音，作为 lib.character 的键）
 * @property {string} translate 显示名
 * @property {string} sex male/female/double/none
 * @property {string} group 势力
 * @property {string} hp 体力，沿用本体 "体/限/甲" 写法，交给 get.infoHp 解析
 * @property {string[]} skills 技能 id 列表，必须都是 lib.skill 里已存在的
 * @property {string} [des] 一句话介绍
 * @property {number} [createTime] 创建时间戳
 */

/**
 * 读全部 DIY 武将定义（只读 JSON，不含立绘）
 * @returns {Promise<DiyCharacter[]>}
 */
export async function loadDiyList() {
	if (!lib.db) {
		return [];
	}
	try {
		const list = await game.getDB("data", INDEX_KEY);
		return Array.isArray(list) ? list : [];
	} catch (error) {
		console.error("读取自建武将失败", error);
		return [];
	}
}

/**
 * 写回全部定义
 * @param {DiyCharacter[]} list
 */
async function saveDiyList(list) {
	await game.putDB("data", INDEX_KEY, list);
}

/**
 * 读某个武将的立绘并转成 data URL
 * @param {string} name
 * @returns {Promise<string|null>}
 */
export async function loadDiyImage(name) {
	if (!lib.db) {
		return null;
	}
	try {
		const stored = await game.getDB("image", IMAGE_PREFIX + name);
		if (!stored) {
			return null;
		}
		// 历史上可能直接存了 data URL 字符串，兼容一下
		if (typeof stored === "string") {
			return stored;
		}
		return await blobToDataURL(stored);
	} catch (error) {
		console.error(`读取自建武将立绘失败：${name}`, error);
		return null;
	}
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataURL(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(/** @type {string} */ (reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

/**
 * 新增或覆盖一个 DIY 武将
 * @param {DiyCharacter} character
 * @param {Blob|null} [image] 立绘，null 表示不改动已有立绘
 */
export async function saveDiyCharacter(character, image) {
	const list = await loadDiyList();
	const index = list.findIndex(item => item.name === character.name);
	const record = Object.assign({}, character, { createTime: character.createTime || Date.now() });
	if (index === -1) {
		list.push(record);
	} else {
		list[index] = record;
	}
	if (image) {
		await game.putDB("image", IMAGE_PREFIX + character.name, image);
	}
	await saveDiyList(list);
	return record;
}

/**
 * 删除一个 DIY 武将（同时清立绘）
 * @param {string} name
 */
export async function deleteDiyCharacter(name) {
	const list = await loadDiyList();
	const next = list.filter(item => item.name !== name);
	await saveDiyList(next);
	if (lib.db) {
		await game.deleteDB("image", IMAGE_PREFIX + name).catch(error => console.error("删除立绘失败", error));
	}
	// 已注入的运行期定义一并摘掉，避免当前这局还能选到
	delete lib.character[name];
	delete lib.translate[name];
	if (lib.characterPack[PACK_NAME]) {
		delete lib.characterPack[PACK_NAME][name];
	}
	return next;
}

/**
 * 体力归一化：get.infoHp 只认 number 或含 "/" 的字符串，
 * 纯数字字符串（"4"）会直接掉到 return 0 变成 0 血武将。
 * 本体在 exetensionMenu.js:1191-1196 也是先转 number 再调 infoHp 的，照抄。
 * @param {string|number} hp
 * @returns {string|number}
 */
export function normalizeHp(hp) {
	if (typeof hp === "number") {
		return hp;
	}
	const text = String(hp ?? "").trim();
	if (["Infinity", "∞", "无限"].includes(text)) {
		return Infinity;
	}
	if (!text.includes("/")) {
		return parseInt(text) || 1;
	}
	return text;
}

/**
 * 把一条记录转成本体的 Character 对象
 * @param {DiyCharacter} record
 * @param {string|null} image data URL
 */
function toCharacter(record, image) {
	const hp = normalizeHp(record.hp);
	const character = get.convertedCharacter({
		sex: record.sex,
		group: record.group,
		hp: get.infoHp(hp),
		maxHp: get.infoMaxHp(hp),
		hujia: get.infoHujia(hp),
		skills: (record.skills || []).slice(),
	});
	// img 是 Character 的一等字段，get.skinPath:7553 与 polyfill.ts:207 都优先读它
	if (image) {
		character.img = image;
	}
	if (record.des) {
		character.trashBin.push(`des:${record.des}`);
	}
	return character;
}

/**
 * 把全部 DIY 武将注入运行期表。
 *
 * 注入需要凑齐四样东西才能在选将界面出现（见 init/loading.ts:118-227 的 loadCharacter）：
 * 1. lib.character[武将名]
 * 2. lib.characterPack[包名][武将名]
 * 3. lib.translate[武将名] 与 lib.translate[包名_character_config]
 * 4. 包名进 lib.config.characters（否则 characterPackMenu 里勾不上、也不计入候选）
 */
export async function injectDiyCharacters() {
	const list = await loadDiyList();
	if (!list.length) {
		return 0;
	}
	// 尊重「武将」tab 里的包开关：本体包关掉后重启就不装进 lib.character 了
	// （loading.ts:143 那个 `!lib.config.characters.includes(name)` 分支），
	// 自建包也得照办，否则关了永远不生效。registerPack 得先跑，
	// 不然菜单里连这个开关都不显示，用户就没法再开回来。
	registerPack();
	if (!isPackEnabled()) {
		return 0;
	}
	let injected = 0;
	for (const record of list) {
		if (await injectDiyCharacter(record)) {
			injected++;
		}
	}
	return injected;
}

/**
 * 注入单条记录（存完立刻生效，不用重启就能在选将界面看到）
 * @param {DiyCharacter} record
 * @returns {Promise<boolean>}
 */
export async function injectDiyCharacter(record) {
	if (!record?.name) {
		return false;
	}
	// 先登记（首次会默认开），再看开关：顺序反了的话第一次保存会被自己判成「包是关的」
	registerPack();
	if (!isPackEnabled()) {
		return false;
	}

	// 技能只留现成且真实存在的，避免挑完技能后对应包被禁用导致崩
	const skills = (record.skills || []).filter(skill => lib.skill[skill]);
	if (skills.length !== (record.skills || []).length) {
		console.warn(`自建武将 ${record.name} 有技能不存在，已跳过：`, (record.skills || []).filter(skill => !lib.skill[skill]));
	}
	const image = await loadDiyImage(record.name);
	const character = toCharacter(Object.assign({}, record, { skills }), image);

	lib.character[record.name] = character;
	lib.characterPack[PACK_NAME][record.name] = character;
	lib.translate[record.name] = record.translate || record.name;
	for (const skill of skills) {
		lib.skilllist.add(skill);
	}
	return true;
}

/**
 * 包是否开启（「武将」tab 里的「自建武将 → 开启」开关）
 * @returns {boolean}
 */
export function isPackEnabled() {
	return Array.isArray(lib.config.characters) && lib.config.characters.includes(PACK_NAME);
}

/**
 * 登记自建武将包，让「武将」tab 能列出它、选将界面能算到它。
 * 只登记，不改开关状态——除了「从来没登记过」这一次给个默认开。
 */
function registerPack() {
	lib.characterPack[PACK_NAME] ??= {};
	lib.translate[`${PACK_NAME}_character_config`] = "自建武将";
	// all.characters 是本次会话的「有哪些包」列表（不持久化），菜单靠它列按钮，必须每次都补
	if (Array.isArray(lib.config.all?.characters) && !lib.config.all.characters.includes(PACK_NAME)) {
		lib.config.all.characters.push(PACK_NAME);
	}
	// characters 是「哪些包开着」（持久化）。这里只做首次默认开：
	// 之前无条件 push 回去，等于每次启动都把用户手动关掉的开关又打开，关不掉。
	// 用一个独立的 flag 区分「用户主动关了」和「还没初始化过」。
	if (Array.isArray(lib.config.characters) && !lib.config.characters.includes(PACK_NAME) && !lib.config[PACK_NAME_INITED]) {
		lib.config.characters.push(PACK_NAME);
		game.saveConfig("characters", lib.config.characters);
	}
	if (!lib.config[PACK_NAME_INITED]) {
		game.saveConfig(PACK_NAME_INITED, true);
	}
}

/**
 * 导出成可分享的 JSON 文本（含 base64 立绘）
 * @returns {Promise<string>}
 */
export async function exportDiyCharacters() {
	const list = await loadDiyList();
	const payload = { version: 1, characters: [] };
	for (const record of list) {
		payload.characters.push(Object.assign({}, record, { image: await loadDiyImage(record.name) }));
	}
	return JSON.stringify(payload);
}

/**
 * 导入分享出来的 JSON 文本
 * @param {string} text
 * @returns {Promise<number>} 实际导入条数
 */
export async function importDiyCharacters(text) {
	const payload = JSON.parse(text);
	if (!payload || !Array.isArray(payload.characters)) {
		throw new Error("文件格式不对");
	}
	let count = 0;
	for (const item of payload.characters) {
		if (!item.name) {
			continue;
		}
		const { image, ...record } = item;
		await saveDiyCharacter(record, image ? await dataURLToBlob(image) : null);
		count++;
	}
	return count;
}

/**
 * @param {string} dataURL
 * @returns {Promise<Blob>}
 */
async function dataURLToBlob(dataURL) {
	const response = await fetch(dataURL);
	return await response.blob();
}
