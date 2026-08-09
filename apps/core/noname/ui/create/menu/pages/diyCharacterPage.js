/**
 * 「扩展」tab 下的「网页扩展」面板：在纯静态 PWA 里捏武将
 *
 * 和「制作扩展」的区别：不生成 extension.js 源码（那条路在 CDN 上重启即失效），
 * 武将定义直接以 JSON 存 IndexedDB，启动时由 util/diyCharacter.js 注入运行期。
 * 技能只能挑现成的，所以不需要 eval/sandbox，也不用担心代码注入。
 */
import { ui, lib, get } from "noname";
import { loadDiyList, loadDiyImage, saveDiyCharacter, deleteDiyCharacter, injectDiyCharacter, exportDiyCharacters, importDiyCharacters } from "@/util/diyCharacter.js";

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

	ui.create.div(".indent", '姓名：<input class="diy_name" type="text" placeholder="英文id">', form);
	ui.create.div(".indent", '显示：<input class="diy_translate" type="text" placeholder="中文名">', form);
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
	var hpInput = form.querySelector("input.diy_hp");

	// —— 技能挑选：先选一个现有武将，再从它的技能里挑 ——
	// 放到 form 外面的全宽段：.new_character > .indent 有 123px 左缩进（给头像让位），
	// 塞两个 select + 按钮在手机上宽度不够。
	var wide = ui.create.div(page);
	block(wide, "padding:2px 12px 0 12px;text-align:left;");

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
		hpInput.value = "";
		sexes.value = "male";
		groups.value = grouplist[0]?.[0] || "wei";
		pickedSkills.innerHTML = "";
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
				{
					name: name,
					translate: translateInput.value.trim() || name,
					sex: sexes.value,
					group: groups.value,
					hp: hpInput.value.trim() || "4",
					skills: skills,
				},
				pickedImage
			);
			await injectOne(name);
			await refreshList();
			resetForm();
			hintLine.innerHTML = lib.config.mode === "connect" ? "已保存，联机模式下不会出现，换单机模式重开生效" : "已保存，本局即可选到";
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
		hpInput.value = record.hp || "";
		sexes.value = record.sex || "male";
		groups.value = record.group || grouplist[0]?.[0];
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

	// —— 说明脚注 ——
	// 放最后：可视区只有 262 高，说明放头部会把「保存」按钮顶出首屏
	var help = ui.create.div(".menu-help", page);
	help.innerHTML = '用现成技能捏武将，只存数据不存代码，重启不丢（「制作扩展」在网页版重启即失效）。<span style="opacity:0.7">联机模式不生效。</span>';
	block(help, "padding:2px 12px 10px 12px;font-size:13px;line-height:18px;opacity:0.55;text-align:left;");

	lib.setScroll(page);
	resetForm();
	return page;
}
