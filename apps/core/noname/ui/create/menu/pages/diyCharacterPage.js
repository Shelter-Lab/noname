/**
 * 「扩展」tab 下的「网页扩展」面板：在纯静态 PWA 里捏武将
 *
 * 和「制作扩展」的区别：不生成 extension.js 源码（那条路在 CDN 上重启即失效），
 * 武将定义直接以 JSON 存 IndexedDB，启动时由 util/diyCharacter.js 注入运行期。
 * 技能只能挑现成的，所以不需要 eval/sandbox，也不用担心代码注入。
 */
import { ui, lib, get } from "noname";
import { loadDiyList, loadDiyImage, saveDiyCharacter, deleteDiyCharacter, injectDiyCharacter, exportDiyCharacters, importDiyCharacters, isPackEnabled } from "@/util/diyCharacter.js";

/**
 * 展开式详细说明。
 * 每条效果都对着实现核对过（别照字面猜），行末括号里是依据的位置，方便以后本体改了来复查。
 */
const HELP_HTML = `
<b>这是什么</b><br>
拿游戏里现成的技能拼一个自己的武将。只存数据、不存代码，所以重启不丢、不用联网，
也不会像「制作扩展」那样在网页版重开就失效（那条路要去服务器上取一个并不存在的
extension.js）。代价是<b>只能用已有技能，写不了新技能</b>。<br><br>

<b>各字段</b><br>
· <b>姓名</b>：内部 id，建议英文/拼音。同名会顶掉已有武将，所以撞名时不给存。<br>
· <b>显示</b>：选将界面上的名字，留空就拿姓名顶上。想改名字改这里，不用动姓名。<br>
· <b>介绍</b>：长按/点武将牌看到的那段说明，选填。<br>
· <b>体力</b>：留空按 4。可以写「体力/上限/护甲」，例如 <b>3/4</b> 是 3 血 4 上限、
<b>4/4/1</b> 再带 1 点护甲。填 <b>无限</b> 或 <b>∞</b> 就是无限血。<br>
· <b>技能</b>：先在左边挑一个现成武将，右边就列出它的技能（含衍生技），点「添加」加进来。
加错了点技能标签本身即可移除。技能可以跨武将随便混。<br>
· <b>头像</b>：不选也能存，只是会显示成剪影。选了会等比裁进武将牌。<br><br>

<b>四个标记</b>（都不勾就是一个普通武将，正常显示、AI 也会用）<br>
· <b>主公</b>：身份局里可以被抽成主公。不勾则永远只当忠/反/内。<br>
· <b>BOSS</b>：归到 BOSS 类，同时进 AI 禁用名单——<b>AI 不会再用它</b>，你自己点将仍可用；
挑战模式的 BOSS 列表里会出现它。注意这个标记<b>不改血量</b>，想要厚血自己在体力里填。<br>
· <b>仅点将</b>：AI 不选它，只能手动点将。和 BOSS 的区别是不影响分类，只管 AI 那一条。<br>
· <b>隐匿技</b>：整张牌暗置——<b>不只藏技能，武将名和立绘一起变成「暗置」</b>，
发动技能才翻开，且选将时不能再选势力。<b>想让技能正常显示就别勾这个。</b><br><br>

<b>存到哪、会不会丢</b><br>
存在浏览器本机（IndexedDB），跟着这个域名走。清浏览器数据/换设备/换浏览器都会丢，
所以捏好了建议点「导出」存一份 json，到新设备「导入」即可，头像也一起带过去。<br><br>

<b>什么时候不生效</b><br>
· <b>联机模式不生效</b>：别人机器上没有你这个武将，同步不了。<br>
· 「武将」tab 里的<b>自建武将</b>开关关掉后，武将还在、但选将界面看不到，开回来即恢复。<br>
· 挑的技能所属的<b>武将包被禁用</b>时，那条技能会被跳过（控制台里有提示），武将本身照常能用。
`;

/**
 * @param {HTMLDivElement} page 面板容器，由 exetensionMenu 建好传进来
 */
export function createDiyCharacterPage(page) {
	page.classList.add("menu-buttons");

	// menu.css:98 有一条 `.menu-buttons div { position: absolute }`，会把面板里所有 div
	// 叠在一起。本体的 .new_character / .indent 是靠自己那几条规则显式覆盖掉的，
	// 我们新建的普通 div 得自己覆盖，否则整个面板糊成一坨。
	var block = function (node, cssText) {
		node.style.cssText = `position:relative;display:block;${cssText || ""}`;
		return node;
	};

	// 已创建列表和说明脚注的 DOM 建在文件末尾（见「已捏好的武将列表」一节）：
	// 菜单可视区只有 262 高、247 宽，表单 + 按钮已经占满一屏，
	// 这两块必须排在表单之后，否则「保存武将」按钮会被顶出首屏。
	var listTitle, characterList;

	// —— 编辑表单 ——
	// 只有 .new_character 里的 .indent 才有现成的定位覆盖（menu.css:1384），所以头像 +
	// 基础字段留在 form 里；min-height 保证 form 至少和绝对定位的头像一样高（8+130），
	// 否则头像会溢出压到下面的全宽段上。
	var form = ui.create.div(".new_character", page);
	form.style.marginTop = "10px";
	form.style.minHeight = "146px";

	var avatar = ui.create.div(".avatar", form);
	/** @type {Blob|null} 本次选中的立绘，null 表示沿用已存的 */
	var pickedImage = null;
	var imageInput = document.createElement("input");
	imageInput.type = "file";
	imageInput.accept = "image/*";
	imageInput.className = "fileinput";
	imageInput.onchange = function () {
		var file = imageInput.files[0];
		if (!file) {
			return;
		}
		pickedImage = file;
		var reader = new FileReader();
		reader.onload = function (event) {
			avatar.style.backgroundImage = `url("${event.target.result}")`;
			avatar.classList.add("inited");
			updateSaveButton();
		};
		reader.readAsDataURL(file);
	};
	avatar.appendChild(imageInput);
	ui.create.div(".select_avatar", "选择头像", avatar);

	// 姓名/显示拆两个框:本体「制作扩展」是塞进一个框用竖线分隔(exetensionMenu.js:689 的
	// `id + "|" + translate`),不知道这个隐规则的人只敲中文,id 就成了中文。拆开显式化。
	// 中文 id 本身能跑(索引不挑字符),只是配音/立绘按 id 拼 URL 时要 encode、跨机器交换存档易撞车。
	ui.create.div(".indent", '姓名：<input class="diy_name" type="text" placeholder="英文id">', form);
	ui.create.div(".indent", '显示：<input class="diy_translate" type="text" placeholder="中文名">', form);
	ui.create.div(".indent", '介绍：<input class="diy_des" type="text" placeholder="选填">', form);
	ui.create.div(".indent", '体力：<input class="diy_hp" type="text" placeholder="体/限/甲">', form);
	var sexes = ui.create.selectlist(
		[
			["male", "男"],
			["female", "女"],
			["double", "双性"],
			["none", "无"],
		],
		null,
		ui.create.div(".indent", "性别：", form)
	);
	var grouplist = lib.group.map(group => [group, get.translation(group)]);
	var groups = ui.create.selectlist(grouplist, null, ui.create.div(".indent", "势力：", form));

	var nameInput = form.querySelector("input.diy_name");
	var translateInput = form.querySelector("input.diy_translate");
	var desInput = form.querySelector("input.diy_des");
	var hpInput = form.querySelector("input.diy_hp");

	// —— 技能挑选：先选一个现有武将，再从它的技能里挑 ——
	// 放到 form 外面的全宽段：.new_character > .indent 有 123px 左缩进（给头像让位），
	// 塞两个 select + 按钮在手机上宽度不够。
	var wide = ui.create.div(page);
	// 左右各留 8 而不是 12：390 宽手机上这段只有 230px 可用，标记那一行要 235px，
	// 差这 8px 就得折行，折行又把「保存武将」顶出 262 高的首屏。
	block(wide, "padding:2px 8px 0 8px;text-align:left;");

	var skillRow = ui.create.div("", "技能：", wide);
	block(skillRow, "padding-top:2px;white-space:nowrap;");
	var characterCandidates = Object.keys(lib.character)
		.filter(name => {
			var info = lib.character[name];
			// 排除自建武将自身，以及没有可用技能/没有译名的
			if (!info || name.startsWith("pwa_diy_")) {
				return false;
			}
			if (!lib.translate[name]) {
				return false;
			}
			return (info.skills || []).some(skill => lib.skill[skill] && !lib.skill[skill].sub && lib.translate[skill]);
		})
		.sort((a, b) => (get.translation(a) > get.translation(b) ? 1 : -1))
		.map(name => [name, get.translation(name)]);

	var sourceSelect = ui.create.selectlist(characterCandidates, characterCandidates[0]?.[0], skillRow);
	sourceSelect.style.maxWidth = "85px";
	var skillSelect = ui.create.selectlist([], null, skillRow);
	skillSelect.style.maxWidth = "70px";

	var fillSkillOptions = function () {
		skillSelect.innerHTML = "";
		var info = lib.character[sourceSelect.value];
		if (!info) {
			return;
		}
		var skills = (info.skills || []).slice();
		// 衍生技也算现成技能，跟着一起列出来
		for (const skill of skills.slice()) {
			var derivation = lib.skill[skill]?.derivation;
			if (derivation) {
				skills[Array.isArray(derivation) ? "addArray" : "add"](derivation);
			}
		}
		for (const skill of skills) {
			if (!lib.skill[skill] || lib.skill[skill].sub || !lib.translate[skill]) {
				continue;
			}
			var option = document.createElement("option");
			option.value = skill;
			option.innerHTML = get.translation(skill);
			skillSelect.appendChild(option);
		}
	};
	sourceSelect.onchange = fillSkillOptions;
	fillSkillOptions();

	var addSkillButton = document.createElement("button");
	addSkillButton.innerHTML = "添加";
	skillRow.appendChild(addSkillButton);

	var pickedSkills = ui.create.div(wide);
	block(pickedSkills, "padding-top:4px;");
	addSkillButton.onclick = function () {
		var skill = skillSelect.value;
		if (!skill) {
			return;
		}
		for (const node of Array.from(pickedSkills.childNodes)) {
			if (node.skill === skill) {
				return;
			}
		}
		var tag = document.createElement("button");
		tag.skill = skill;
		tag.innerHTML = get.translation(skill);
		tag.title = "点击移除";
		tag.onclick = function () {
			tag.remove();
			updateSaveButton();
		};
		pickedSkills.appendChild(tag);
		updateSaveButton();
	};

	var getPickedSkills = function () {
		return Array.from(pickedSkills.childNodes)
			.map(node => node.skill)
			.filter(Boolean);
	};

	// —— 四个标记 ——
	// 字段名照本体 exetensionMenu.js:745 那张 optionMap,存的是 Character 的一等属性,
	// 不用改存储结构。各自的真实效果(都已核对实现,别照字面猜):
	//   主公 isZhugong      —— 身份局可被选为主公
	//   BOSS isBoss         —— 归入 boss 分类,且进 AI 禁用名单(loading.ts:312),与血量无关
	//   仅点将 isAiForbidden —— AI 不选它,只能手动点将
	//   隐匿技 hasHiddenSkill —— 藏的不只技能:武将名与立绘一起变 "unknown" 整张暗置
	//                           (player.js:3525 会清空 skills 并置 name="unknown"),发动才翻开;
	//                           且选将时不给选势力(get/index.js:6440)。不勾就是正常显示。
	// 注意参数顺序：ui.create.div 把**第一个**字符串当 className、第二个才当 innerHTML
	// （ui/create/index.js:581），少给一个空串会让这段 HTML 变成类名、checkbox 一个都建不出来
	//
	// 这一行**不能**整行 nowrap：390 宽手机上这里只有 230px，nowrap 放不下就直接切字
	// （原来四项占 244px，只靠外层 12px padding 兜着，只剩 6px 余量）。
	// 改成整行允许折行、每项自己 inline-block + nowrap：项内不断字，放不下就整项换行。
	// 间距压到 5px 且最后一项不留右边距，实测 227px < 230 —— 390 宽下仍是一行
	// （不换行才不会把「保存武将」顶出 262 高的首屏），更窄的屏才折行。
	var optionSpan = 'style="display:inline-block;white-space:nowrap;margin-right:5px"';
	var lastSpan = 'style="display:inline-block;white-space:nowrap"';
	var optionRow = ui.create.div("", `<span ${optionSpan}>主公<input type="checkbox" name="isZhugong"></span><span ${optionSpan}>BOSS<input type="checkbox" name="isBoss"></span><span ${optionSpan}>仅点将<input type="checkbox" name="isAiForbidden"></span><span ${lastSpan}>隐匿技<input type="checkbox" name="hasHiddenSkill"></span>`, wide);
	block(optionRow, "padding-top:6px;font-size:14px;");

	var OPTION_KEYS = ["isZhugong", "isBoss", "isAiForbidden", "hasHiddenSkill"];
	var optionBox = function (key) {
		return optionRow.querySelector('input[name="' + key + '"]');
	};
	var getOptions = function () {
		var picked = {};
		for (const key of OPTION_KEYS) {
			if (optionBox(key)?.checked) {
				picked[key] = true;
			}
		}
		return picked;
	};

	// —— 保存 / 取消 ——
	var buttonRow = ui.create.div(wide);
	block(buttonRow, "padding-top:8px;");
	var saveButton = document.createElement("button");
	saveButton.innerHTML = "保存武将";
	buttonRow.appendChild(saveButton);
	var resetButton = document.createElement("button");
	resetButton.innerHTML = "清空";
	resetButton.style.marginLeft = "6px";
	buttonRow.appendChild(resetButton);

	var hintLine = ui.create.div(wide);
	block(hintLine, "padding:5px 0 2px 0;font-size:13px;opacity:0.6;min-height:16px;");

	/** 当前正在编辑的武将 id，null 表示新建 */
	var editingName = null;

	var updateSaveButton = function () {
		var name = nameInput.value.trim();
		var valid = Boolean(name) && getPickedSkills().length > 0;
		// 新建时不能撞已有武将名；编辑时允许沿用自己的名字
		if (valid && name !== editingName && lib.character[name]) {
			valid = false;
			hintLine.innerHTML = `「${name}」已被占用`;
		} else if (valid && !pickedImage && !avatar.classList.contains("inited")) {
			hintLine.innerHTML = "没选头像也能存，会显示剪影";
		} else if (valid) {
			hintLine.innerHTML = "";
		}
		saveButton.disabled = !valid;
	};
	nameInput.onblur = updateSaveButton;
	nameInput.oninput = updateSaveButton;

	var resetForm = function () {
		editingName = null;
		pickedImage = null;
		nameInput.value = "";
		translateInput.value = "";
		desInput.value = "";
		hpInput.value = "";
		sexes.value = "male";
		groups.value = grouplist[0]?.[0] || "wei";
		pickedSkills.innerHTML = "";
		for (const key of OPTION_KEYS) {
			var box = optionBox(key);
			if (box) {
				box.checked = false;
			}
		}
		avatar.style.backgroundImage = "";
		avatar.classList.remove("inited");
		saveButton.innerHTML = "保存武将";
		hintLine.innerHTML = "";
		updateSaveButton();
	};

	resetButton.onclick = resetForm;

	saveButton.onclick = async function () {
		var name = nameInput.value.trim();
		var skills = getPickedSkills();
		if (!name || !skills.length) {
			return;
		}
		saveButton.disabled = true;
		hintLine.innerHTML = "保存中…";
		try {
			// 改名等于换 id，先把旧的清掉，避免留个孤儿
			if (editingName && editingName !== name) {
				await deleteDiyCharacter(editingName);
			}
			await saveDiyCharacter(
				Object.assign(
					{
						name: name,
						translate: translateInput.value.trim() || name,
						des: desInput.value.trim(),
						sex: sexes.value,
						group: groups.value,
						hp: hpInput.value.trim() || "4",
						skills: skills,
					},
					getOptions()
				),
				pickedImage
			);
			await injectOne(name);
			await refreshList();
			resetForm();
			if (lib.config.mode === "connect") {
				hintLine.innerHTML = "已保存，联机模式下不会出现，换单机模式重开生效";
			} else if (!isPackEnabled()) {
				// 包被用户在「武将」tab 里关掉了，存得下但选将界面看不到，得说清楚
				hintLine.innerHTML = "已保存，但「武将→自建武将」是关的，开了才能选到";
			} else {
				hintLine.innerHTML = "已保存，本局即可选到";
			}
		} catch (error) {
			console.error(error);
			hintLine.innerHTML = `保存失败：${error instanceof Error ? error.message : String(error)}`;
			saveButton.disabled = false;
		}
	};

	/**
	 * 存完立刻注入运行期，不用重启就能在选将界面看到
	 * @param {string} name
	 */
	var injectOne = async function (name) {
		// 联机模式不注入，理由同 init/index.ts 里的注入点
		// 包开关的判断在 injectDiyCharacter 里（它会先 registerPack 再看开关，
		// 顺序反了会让第一次保存的用户误判成「包是关的」）
		if (lib.config.mode === "connect") {
			return;
		}
		var record = (await loadDiyList()).find(item => item.name === name);
		if (record) {
			await injectDiyCharacter(record);
		}
	};

	/**
	 * 把一条记录读回表单
	 * @param {import("@/util/diyCharacter.js").DiyCharacter} record
	 */
	var loadIntoForm = async function (record) {
		editingName = record.name;
		pickedImage = null;
		nameInput.value = record.name;
		translateInput.value = record.translate || "";
		desInput.value = record.des || "";
		hpInput.value = record.hp || "";
		sexes.value = record.sex || "male";
		groups.value = record.group || grouplist[0]?.[0];
		for (const key of OPTION_KEYS) {
			var box = optionBox(key);
			if (box) {
				box.checked = Boolean(record[key]);
			}
		}
		pickedSkills.innerHTML = "";
		for (const skill of record.skills || []) {
			var tag = document.createElement("button");
			tag.skill = skill;
			tag.innerHTML = get.translation(skill) || skill;
			tag.onclick = function () {
				tag.remove();
				updateSaveButton();
			};
			pickedSkills.appendChild(tag);
		}
		var image = await loadDiyImage(record.name);
		if (image) {
			avatar.style.backgroundImage = `url("${image}")`;
			avatar.classList.add("inited");
		} else {
			avatar.style.backgroundImage = "";
			avatar.classList.remove("inited");
		}
		saveButton.innerHTML = "保存修改";
		updateSaveButton();
	};

	var refreshList = async function () {
		characterList.innerHTML = "";
		var list = await loadDiyList();
		// 空列表连标题一起收起，把表单让到首屏；display 要写在 block() 之后才不被覆盖
		listTitle.style.display = list.length ? "block" : "none";
		characterList.style.display = list.length ? "block" : "none";
		if (!list.length) {
			return;
		}
		for (const record of list) {
			var row = ui.create.div(characterList);
			row.style.cssText = "position:relative;display:inline-block;margin:4px 6px 4px 0;";
			var editButton = document.createElement("button");
			editButton.innerHTML = record.translate || record.name;
			editButton.onclick = (function (item) {
				return function () {
					loadIntoForm(item);
				};
			})(record);
			row.appendChild(editButton);
			var deleteButton = document.createElement("button");
			deleteButton.innerHTML = "×";
			deleteButton.style.marginLeft = "2px";
			deleteButton.onclick = (function (item) {
				return async function () {
					if (!(await confirmDelete(item))) {
						return;
					}
					await deleteDiyCharacter(item.name);
					if (editingName === item.name) {
						resetForm();
					}
					await refreshList();
				};
			})(record);
			row.appendChild(deleteButton);
		}
	};

	/**
	 * @param {import("@/util/diyCharacter.js").DiyCharacter} record
	 * @returns {Promise<boolean>}
	 */
	var confirmDelete = function (record) {
		return Promise.resolve(confirm(`删除「${record.translate || record.name}」？`));
	};

	// —— 导入 / 导出 ——
	// 并到保存那一行：菜单可视区只有 260px，多一块就把内容挤出屏幕
	var exportButton = document.createElement("button");
	exportButton.innerHTML = "导出";
	exportButton.style.marginLeft = "14px";
	buttonRow.appendChild(exportButton);
	exportButton.onclick = async function () {
		try {
			var text = await exportDiyCharacters();
			var blob = new Blob([text], { type: "application/json" });
			var url = URL.createObjectURL(blob);
			var anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = "自建武将.json";
			anchor.click();
			setTimeout(() => URL.revokeObjectURL(url), 10000);
		} catch (error) {
			hintLine.innerHTML = `导出失败：${error instanceof Error ? error.message : String(error)}`;
		}
	};

	var importLabel = ui.create.node("label", "导入", buttonRow);
	importLabel.style.cssText = "margin-left:6px;position:relative;overflow:hidden;display:inline-block;";
	var importInput = document.createElement("input");
	importInput.type = "file";
	importInput.accept = ".json,application/json";
	importInput.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;opacity:0;";
	importLabel.appendChild(importInput);
	importInput.onchange = async function () {
		var file = importInput.files[0];
		if (!file) {
			return;
		}
		try {
			var count = await importDiyCharacters(await file.text());
			for (const record of await loadDiyList()) {
				await injectOne(record.name);
			}
			await refreshList();
			hintLine.innerHTML = `已导入 ${count} 个武将`;
		} catch (error) {
			hintLine.innerHTML = `导入失败：${error instanceof Error ? error.message : String(error)}`;
		}
		importInput.value = "";
	};

	// —— 已捏好的武将列表 ——
	// 建在表单之后（变量在文件顶部声明），空列表连标题一起收起
	listTitle = ui.create.div("", "已创建", page);
	block(listTitle, "padding:8px 12px 2px 12px;text-align:left;font-size:15px;opacity:0.6;");
	characterList = ui.create.div(page);
	block(characterList, "padding:0 12px;text-align:left;");
	refreshList();

	// —— 说明 ——
	// 放最后：可视区只有 262 高，说明放头部会把「保存」按钮顶出首屏。
	// 详细说明默认收起：摊开有三四十行，一直占着会把「已创建」列表推得离表单很远。
	var helpLine = ui.create.div(".menu-help", page);
	helpLine.innerHTML = '用现成技能捏武将，只存数据不存代码，重启不丢，不用联网。<span style="opacity:0.7">联机模式不生效。</span> ';
	block(helpLine, "padding:2px 12px 4px 12px;font-size:13px;line-height:18px;opacity:0.55;text-align:left;");
	var helpToggle = document.createElement("button");
	helpToggle.innerHTML = "详细说明";
	helpLine.appendChild(helpToggle);

	var help = ui.create.div(".menu-help", page);
	help.innerHTML = HELP_HTML;
	block(help, "padding:0 12px 10px 12px;font-size:13px;line-height:19px;opacity:0.6;text-align:left;");
	help.style.display = "none";
	helpToggle.onclick = function () {
		var open = help.style.display === "none";
		help.style.display = open ? "block" : "none";
		helpToggle.innerHTML = open ? "收起说明" : "详细说明";
	};

	// 【不要在这里调 lib.setScroll(page)】面板本身永远不是滚动容器（.menu-buttons 没有 overflow，
	// 高度随内容长，scrollHeight 恒等于 offsetHeight），真正滚的是外面的 .right.pane
	// （menu/index.js:143 已给它 setScroll）。而 touchScroll 有条 iOS 专属分支
	// （ui/click/index.js:4660）：`scrollHeight <= offsetHeight+5` 就 e.preventDefault()。
	// 挂在面板上必然命中 → touchmove 被取消 → 连带把 .right.pane 的原生滚动一起废掉，
	// 表现就是 iOS 上整个面板拖不动（实测 preventDefault=true）。
	// 底部留白：绝对定位的面板贴着 pane 底，最后一行容易被切。
	page.style.paddingBottom = "10px";
	resetForm();
	return page;
}
