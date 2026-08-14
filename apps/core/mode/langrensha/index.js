import { lib, game, ui, get, ai, _status } from "noname";

import skill from "./config/skill.js";
import translate from "./config/translate.js";
import { rawAttitude, logAi, swConfig } from "./config/ai.js";

export const type = "mode";

// 身份角标的发光配色。狼人杀的身份是自定义的（狼/民/预/巫/猎/觉孤），
// 核心样式表里没有对应的 data-color，只能整局开始时往 head 里塞一段。
const identityCSS = `
.player .identity[data-color="yvyanjia"] {
	text-shadow: rgba(148, 0, 211, 1) 0 0 2px, rgba(148, 0, 211, 1) 0 0 5px, rgba(148, 0, 211, 1) 0 0 10px, rgba(148, 0, 211, 1) 0 0 15px, black 0 0 1px;
}
.player .identity[data-color="nvwu"] {
	text-shadow: rgba(148, 0, 211, 1) 0 0 2px, rgba(222, 89, 255, 1) 0 0 5px, rgba(222, 89, 255, 1) 0 0 10px, rgba(222, 89, 255, 1) 0 0 15px, black 0 0 1px;
}
.player .identity[data-color="lieren"] {
	text-shadow: rgba(102, 204, 102, 1) 0 0 2px, rgba(102, 204, 102, 1) 0 0 5px, rgba(102, 204, 102, 1) 0 0 10px, rgba(102, 204, 102, 1) 0 0 15px, black 0 0 1px;
}
.player [data-nature="hao"],
.player .identity[data-color="pingmin"] {
	text-shadow: black 0 0 1px, rgba(255, 225, 100, 1) 0 0 2px, rgba(255, 225, 100, 1) 0 0 5px, rgba(255, 225, 100, 1) 0 0 10px, rgba(255, 225, 100, 1) 0 0 15px;
}
.player .identity[data-color="lang"],
.player .identity[data-color="langwang"],
.player .identity[data-color="bailang"],
.player [data-nature="huai"],
.player .identity[data-color="yinlang"] {
	text-shadow: black 0 0 1px, rgba(191, 0, 0, 1) 0 0 2px, rgba(191, 0, 0, 1) 0 0 5px, rgba(191, 0, 0, 1) 0 0 10px, rgba(191, 0, 0, 1) 0 0 15px;
}
.player .identity[data-color="jx_gudushaonv"] {
	text-shadow: black 0 0 1px, rgba(255, 65, 194, 1) 0 0 2px, rgba(255, 65, 194, 1) 0 0 5px, rgba(255, 65, 194, 1) 0 0 10px, rgba(255, 65, 194, 1) 0 0 15px;
}
/* "觉醒孤独少女"这种长身份名要缩字号并挪位置，否则会糊出头像框 */
.player .identity[data-sw-scale="scale1"] {
	left: 70px !important;
	right: -20px !important;
	transition: none !important;
}
.player .identity[data-sw-scale="scale1"] div {
	transition: none !important;
	font-size: 15px !important;
	text-align: center !important;
	line-height: 1 !important;
}
`;

/** 规则说明，房间信息栏和"游戏规则"按钮共用 */
function getRule() {
	return (
		`<div class="text center">` +
		`普通板（8人）：2狼1狼王 / 2民1预1女1猎` +
		`<br>觉孤板：10人为 2狼1狼王1白狼 / 2民1预1女1猎1觉孤；8人则去掉白狼和1民` +
		`<br>身份全程不公开。` +
		`<br>屠城：好人全部阵亡则狼人获胜。屠边：神职（预/女/猎）或平民，任一类全灭即狼人获胜。` +
		`<br>预言家：每轮开始时，你可以查看一名未以此法查看过的其他玩家的阵营。` +
		`<br>猎人：死亡后可以对一名其他角色造成等同于猎人体力上限点伤害。` +
		`<br>女巫：每局游戏限一次，非首轮游戏开始时，可以选择复活/毒杀一名其他角色。（均为3体力）` +
		`<br>觉醒孤独少女：首轮开始时须选择一名其他角色成为自己的偶像并加入平民阵营。偶像若因为狼刀或者狼人击杀死亡，则你继承偶像的阵营和技能；偶像若因为你击杀死亡，则你变为中立阵营且视为游戏目标失败；其他原因死亡，你加入狼人阵营且初始狼刀伤害为0。` +
		`<br>平民：可以摸鱼。` +
		`<br>狼人阵营：游戏开始前知晓其他狼人的身份，每轮开始时可以暗中选择一名玩家，使其流失X点体力（不触发技能）。` +
		`<br>狼人死亡后会随机将每轮狼刀伤害转移增加给队友。` +
		`<br>狼人：每轮1狼刀伤害。` +
		`<br>狼王：每轮1狼刀伤害。游戏开始前，若狼刀总数小于4，则改为2狼刀伤害。` +
		`<br>白狼：每轮1狼刀伤害。死亡后可以对一名其他角色造成等同于白狼体力上限点伤害。` +
		`<br>隐狼：被查验结果为好人，和狼人队友互相不可见。每轮1狼刀伤害，在其他狼人全部死亡前无法获得转移狼刀。（现有两个板子都不含隐狼，实战不会出现）</div>`
	);
}

/** 屏幕中央飘一条提示（同时只显示一条，后来的排队 2 秒后再放） */
function createTip(text) {
	if (_status.swClog) {
		setTimeout(() => {
			game.createTip(text);
		}, 2000);
		return null;
	}
	// 样式全靠下面的 css() 内联，类名只用来标识
	const clog = ui.create.div(".olskilllog", text, ui.arena);
	_status.swClog = clog;
	clog.css({
		left: "50%",
		transform: "translateX(-50%)",
		zIndex: "100",
		fontSize: "20px",
		backgroundColor: "rgba(0,0,0,.3)",
		padding: "10px",
		top: "25%",
		borderRadius: "5px",
		textShadow: "1px 1px black",
	});
	setTimeout(() => {
		clog.style.opacity = "0";
		delete _status.swClog;
	}, 4000);
	setTimeout(() => {
		clog.remove();
	}, 6000);
	return clog;
}

/** 右上角"游戏规则"按钮 */
function createInfoUI() {
	if (!ui.gameRule) {
		ui.gameRule = ui.create.system("游戏规则", null, true, true);
	}
	lib.setPopped(
		ui.gameRule,
		function () {
			const uiintro = ui.create.dialog("hidden");
			uiintro.add("游戏规则");
			uiintro.add(game.getRule());
			uiintro.add(ui.create.div(".placeholder.slim"));
			return uiintro;
		},
		360
	);
}

/** 结算时公开所有人身份：角标点亮 + 头像上盖一个大字身份牌 */
function showIdentity() {
	const me = game.me._trueMe || game.me;
	const players = game.filterPlayer2();
	for (let i = 0; i < players.length; i++) {
		players[i].node.identity.classList.remove("guessing");
		players[i].identityShown = true;
		players[i].ai.shown = 1;
		players[i].setIdentity(players[i].identity);
		if (players[i] == me) {
			continue;
		}
		if (players[i].node.dieidentity) {
			players[i].node.dieidentity.delete();
			delete players[i].node.dieidentity;
		}
		let str = get.translation(players[i].identity + "2");
		if (str.length >= 5) {
			str = str.slice(0, 2) + `<br>` + str.slice(2);
		}
		const node = ui.create.div(".damage.dieidentity", str, players[i]);
		if (str.length == 3) {
			node.style.fontSize = "40px";
		} else if (str.length > 3) {
			node.style.fontSize = "28px";
		}
		const trans = players[i].style.transform;
		if (trans) {
			if (trans.indexOf("rotateY") != -1) {
				node.style.transform = "rotateY(180deg)";
			} else if (trans.indexOf("rotateX") != -1) {
				node.style.transform = "rotateX(180deg)";
			} else {
				node.style.transform = "";
			}
		} else {
			node.style.transform = "";
		}
		ui.refresh(node);
		node.style.opacity = 1;
		players[i].node.dieidentity = node;
	}
	if (_status.clickingidentity) {
		for (let i = 0; i < _status.clickingidentity[1].length; i++) {
			_status.clickingidentity[1][i].delete();
			_status.clickingidentity[1][i].style.transform = "";
		}
		delete _status.clickingidentity;
	}
}

/**
 * 超过 8 人时重排座位。核心版按 6/人数 缩放，十人局会挤在一起，
 * 这里按实际人数缩放并在手机布局下再整体缩小到 80%。
 */
function updatePlayerPositions(numberOfPlayers) {
	if (typeof numberOfPlayers != "number") {
		numberOfPlayers = ui.arena.dataset.number;
	}
	if (!numberOfPlayers || numberOfPlayers <= 8) {
		return;
	}
	if (get.is.phoneLayout()) {
		game.documentZoom = (game.deviceZoom * 80) / 100;
		ui.updatez();
		if (Array.isArray(lib.onresize)) {
			lib.onresize.forEach(fun => {
				if (typeof fun === "function") {
					fun();
				}
			});
		}
	}
	const playerPositions = ui.playerPositions;
	playerPositions.forEach(position => {
		game.dynamicStyle.remove(position);
	});
	playerPositions.length = 0;
	const temporaryPlayer = ui.create.div(".player", ui.arena).hide();
	const computedStyle = getComputedStyle(temporaryPlayer);
	const scale = (game.players.concat(game.dead).length || 10) / numberOfPlayers;
	const quarterHeight = (parseFloat(computedStyle.height) / 4) * scale;
	const halfWidth = parseFloat(computedStyle.width) / 2;
	temporaryPlayer.remove();
	const columnCount = numberOfPlayers - 1;
	const percentage = 90 / (columnCount - 1);
	for (let ordinal = 1; ordinal < numberOfPlayers; ordinal++) {
		const reversedOrdinal = columnCount - ordinal;
		const top = Math.max(0, Math.round(numberOfPlayers / 5) - Math.min(Math.abs(ordinal - 1), Math.abs(reversedOrdinal))) * quarterHeight;
		const selector = `#arena[data-number='${numberOfPlayers}']>.player[data-position='${ordinal}']`;
		game.dynamicStyle.add(selector, {
			left: `calc(${percentage * reversedOrdinal + 5}% - ${halfWidth}px)`,
			top: `${top}px`,
			transform: `scale(${scale})`,
		});
		playerPositions.push(selector);
	}
}

/** 狼队专属聊天入口，只有狼人才会创建 */
function createChatTeam() {
	const chat = ui.create.system("队内聊天", null, true);
	ui.SWchatButton = chat;
	lib.setPopped(chat, ui.click.chatTeam, 260);
}

/** 队内聊天面板，抄自核心的 ui.click.chat，只把发送走向改成 chatTeam */
function clickChatTeam() {
	ui.system1.classList.add("shown");
	ui.system2.classList.add("shown");

	const uiintro = ui.create.dialog("hidden");
	uiintro.listen(function (e) {
		e.stopPropagation();
	});

	const list = ui.create.div(".caption");
	if (get.is.phoneLayout()) {
		list.style.maxHeight = "110px";
	} else {
		list.style.maxHeight = "220px";
	}
	list.style.overflow = "scroll";
	lib.setScroll(list);
	uiintro.contentContainer.style.overflow = "hidden";

	const addEntry = function (info, clear) {
		if (list._chatempty) {
			list.innerHTML = "";
			delete list._chatempty;
		}
		const node = ui.create.div(".text.chat");
		node.innerHTML = info[0] + ": " + info[1];
		list.appendChild(node);
		list.scrollTop = list.scrollHeight;
		uiintro.style.height = uiintro.content.scrollHeight + "px";
	};
	_status.SWaddChatEntry = addEntry;
	_status.SWaddChatEntry._origin = uiintro;
	lib.SWchatHistory ??= [];
	if (lib.SWchatHistory.length) {
		for (let i = 0; i < lib.SWchatHistory.length; i++) {
			addEntry(lib.SWchatHistory[i]);
		}
	} else {
		list._chatempty = true;
		list.appendChild(ui.create.div(".text.center", "无聊天记录"));
	}
	uiintro.add(list);
	uiintro.style.height = uiintro.content.offsetHeight + "px";
	list.scrollTop = list.scrollHeight;

	if (!_status.SWchatValue) {
		_status.SWchatValue = "";
	}
	const node = uiintro.add('<input type="text" value="' + _status.SWchatValue + '">');
	node.style.paddingTop = 0;
	node.style.marginBottom = "16px";
	const input = node.firstChild;
	input.style.width = "calc(100% - 20px)";
	input.onchange = function () {
		_status.SWchatValue = input.value;
	};
	input.onkeydown = function (e) {
		if (e.key == "Enter" && input.value) {
			let player = game.me;
			const str = input.value;
			if (!player && game.connectPlayers) {
				if (game.online) {
					for (let i = 0; i < game.connectPlayers.length; i++) {
						if (game.connectPlayers[i].playerid == game.onlineID) {
							player = game.connectPlayers[i];
							break;
						}
					}
				} else {
					player = game.connectPlayers[0];
				}
			}
			if (!player) {
				return;
			}
			if (get.is.banWords(input.value)) {
				// 违禁词直接当公开发言处理，不进狼队频道
				player.say(input.value);
			} else if (game.online) {
				game.send("chatTeam", game.onlineID, str);
			} else {
				player.chatTeamOnline(str);
			}
			input.value = "";
			_status.SWchatValue = "";
		}
		e.stopPropagation();
	};
	uiintro._onopen = function () {
		input.focus();
		list.scrollTop = list.scrollHeight;
	};
	uiintro._heightfixed = true;
	uiintro.style.height = uiintro.content.scrollHeight + "px";
	return uiintro;
}

/**
 * 把本模式追加的 game.* / ui.* 成员装到当前端上。
 *
 * 【为什么要有这么个函数】主机侧 game.switchMode 会把模式的 game/ui 整块合并进来，
 * 但客户端 lib.message.client.init / reinit 只挑了 getIdentityList、updateState、
 * getRoomInfo 等几个名字，ui 一个都不拿。客户端要执行主机广播过来的回调
 * （里面会调 game.createTip / ui.create.chatTeam），少一个就报 undefined。
 * 广播的回调会被序列化、丢掉闭包，所以不能直接广播上面那些函数；
 * 但客户端自己 import 过本模块，于是把这个装载器挂在 mode.get 上
 * （get 是客户端会整块复制的），广播时只需要 `() => get.swInstallLangrensha()`。
 */
function swInstallLangrensha() {
	game.createTip = createTip;
	game.createInfoUI = createInfoUI;
	game.getRule = getRule;
	game.showIdentity = showIdentity;
	ui.updatePlayerPositions = updatePlayerPositions;
	ui.create.chatTeam = createChatTeam;
	ui.click.chatTeam = clickChatTeam;
}

/** 每人的选将框数量，读 langrensha_listNum */
function getSelectNum() {
	const mode = get.mode();
	let num = swConfig(mode + "_listNum") || 5;
	if (num === "normal" || num === "dianjiang") {
		return 5;
	}
	num = parseInt(num) || 5;
	return num;
}

/** 往当前端 head 里塞身份角标样式。广播用，故不引用任何闭包变量 */
function installStyle(innerHTML) {
	const style = document.createElement("style");
	style.innerHTML = innerHTML;
	document.head.appendChild(style);
}

/** 客户端补装模式成员。广播用，故只引用 get 这个全局 */
function installClientMembers() {
	get.swInstallLangrensha();
}

/** 客户端建信息栏。广播用，故只引用 game 这个全局 */
function clientCreateInfoUI() {
	game.createInfoUI();
}

/** 队内聊天的服务端转发。抄自核心 lib.message.server.chat，落点改成 chatTeamOnline */
function serverChatTeam(id, str) {
	if (lib.node.observing.includes(this)) {
		return;
	}
	const senderId = this.id;
	const isKnownClient =
		senderId &&
		(lib.playerOL[senderId] ||
			(game.connectPlayers &&
				game.connectPlayers.some(function (current) {
					return current.playerid == senderId;
				})));
	if (!isKnownClient) {
		return;
	}
	let player = lib.playerOL[id];
	if (!player && game.connectPlayers) {
		player = game.connectPlayers.find(function (current) {
			return current.playerid == id;
		});
	}
	if (player) {
		player.chatTeamOnline(str);
	}
}

export default () => ({
	name: "langrensha",

	onreinit() {
		// 重连/旁观进来时 mode.get 已经复制好了，但 game.*/ui.* 还没装，先补上再建信息栏
		swInstallLangrensha();
		createInfoUI();
	},

	// 用"数组 + async 函数"而非老式 "step 0" 写法：老写法会被 StepCompiler 反编译再重编，
	// 重编时只注入 lib/game/ui/get/ai/_status 六个变量，本文件的模块级函数在里面全都取不到。
	// 数组写法走 ArrayCompiler（Reflect.apply 原函数），闭包完整保留。
	start: [
		async (event, trigger, player) => {
			if (!_status.connectMode) {
				// 单机：照身份模式的做法自己摆场（identity.js:61-71 的 game.prepareArena()），
				// 人数由 ui.create.players → get.playerNumber() 读单机的 player_number 配置。
				// 不能走 game.randomMapOL()：那个要 lib.node.clients 排座位、还读 lib.configOL。
				game.prepareArena();
				game.delay();
				// 【这一句删不得】lib.onfree 是个"等游戏就绪再执行"的队列，选项菜单的构建
				// （ui/create/index.js:3139 的 ui.create.menu()）和牌堆卡片实体的创建
				// （同文件 :3866 的 cardsAsync）都排在里面，只有 lib.init.onfree() 会把它排空。
				// 自动兜底只给扩展模式（game/index.js:8041 判 fromextension），内置模式必须自己调：
				// 身份模式是在后面的步骤里调 game.showChangeLog()（其末尾即 lib.init.onfree()）
				// 或直接调 onfree。少了它的后果不是"少个菜单"——选项点不动、切不了模式、
				// 牌堆是空的，而且 window.resetGameTimeout 不会被清，30 秒后弹「是否重置」。
				lib.init.onfree();
				return;
			}
			game.waitForPlayer(function () {
				lib.configOL.number = lib.configOL.player_number;
			});
		},
		async (event, trigger, player) => {
			_status.mode = swConfig("langrensha_mode");
			if (_status.connectMode && lib.configOL.number < 2) {
				lib.configOL.number = 2;
			}
			game.broadcastAll(installStyle, identityCSS);
			game.broadcastAll(installClientMembers);
			// 重连的客户端要重新补样式和这批 game.*/ui.* 成员
			if (!_status.postReconnect.langrenshaStyle) {
				_status.postReconnect.langrenshaStyle = [installStyle, identityCSS];
			}
			if (!_status.postReconnect.langrenshaInstall) {
				_status.postReconnect.langrenshaInstall = [installClientMembers];
			}
			// 狼队频道：客户端把消息发给主机，主机再分发给所有狼人。单机没有客户端，不用装
			if (_status.connectMode) {
				lib.message.server.chatTeam = serverChatTeam;
			}
		},
		async (event, trigger, player) => {
			game.broadcastAll(clientCreateInfoUI);
			if (_status.connectMode) {
				// randomMapOL 里排完座位就会调 game.chooseCharacterOL()
				game.randomMapOL();
				return;
			}
			// 单机：把 randomMapOL 里跟客户端无关的那部分自己补上。
			// lib.playerOL 只在 game.createServer()/客户端 init 里初始化过，单机是 undefined，
			// 而 chooseButtonOL 按 playerid 索引结果、chooseCharacterOL 又要靠 lib.playerOL[id]
			// 反查回玩家（还有 getState/updateState），所以这两样必须先备好。
			// player.getId() 在 connectMode 下会直接 return，且它填的是 game.playerMap，
			// 不是这里要的 lib.playerOL，故手动发号。
			lib.playerOL ??= {};
			for (const current of game.players) {
				current.playerid ??= get.id();
				lib.playerOL[current.playerid] = current;
			}
			game.chooseCharacterOL();
		},
		async (event, trigger, player) => {
			for (let i = 0; i < game.players.length; i++) {
				game.players[i].ai.shown = 0;
			}
			if (!_status.firstAct) {
				_status.firstAct = game.players.randomGet();
				// 从首位开始顺时针编座位号（原扩展的 swTool.setPlayersSeat，广播会丢闭包所以内联）
				game.broadcastAll(first => {
					_status.seatNumSettled = true;
					let seat = 1;
					while (!first.next.seatNum || !first.seatNum) {
						first.seatNum = seat;
						seat++;
						first = first.next;
					}
				}, _status.firstAct);
			}
			// 发狼刀：每头狼 1 点；狼刀总数不足 4 时狼王补 1 点
			let langdaoCount = 0;
			for (let i = 0; i < game.players.length; i++) {
				game.players[i].swState ??= {};
				if (game.players[i].isLang()) {
					game.players[i].swState.langdao = 1;
					langdaoCount++;
				}
			}
			for (let i = 0; i < game.players.length; i++) {
				if (game.players[i].identity == "langwang" && langdaoCount < 4) {
					game.players[i].swState.langdao++;
				}
			}

			game.syncState();

			event.trigger("gameStart");
		},
		async (event, trigger, player) => {
			const players = get.players(lib.sort.position);
			const info = [];
			for (let i = 0; i < players.length; i++) {
				info.push({
					name: players[i].name1,
					name2: players[i].name2,
					identity: players[i].identity,
					nickname: players[i].node.nameol.innerHTML,
				});
			}
			_status.videoInited = true;
			game.addVideo("init", null, info);
		},
		async (event, trigger, player) => {
			event.beginner = _status.firstAct2 || _status.firstAct || game.boss || game.me;
			game.gameDraw(event.beginner, function (player) {
				return 4;
			});
			// 换牌是联机房的选项，单机菜单里没有（身份模式 identity.js:466 也是这么门的），
			// 而 lib.configOL 在单机是 undefined，不加这道门会直接抛
			if (_status.connectMode && lib.configOL.change_card) {
				game.replaceHandcards(game.players.slice(0));
			}
		},
		async (event, trigger, player) => {
			game.phaseLoop(event.beginner);
		},
	],

	game: {
		getRule,
		createTip,
		createInfoUI,
		showIdentity,
		getState() {
			const state = {};
			for (const i in lib.playerOL) {
				const player = lib.playerOL[i];
				state[i] = { identity: player.identity };
				state[i].swState = player.swState;
				state[i].shown = player.ai.shown;
			}
			state.identityList = _status.identityList;
			return state;
		},
		updateState(state) {
			_status.identityList = state.identityList;
			for (const i in state) {
				const player = lib.playerOL[i];
				if (player) {
					player.identity = state[i].identity;
					player.swState = state[i].swState;
					player.ai.shown = state[i].shown;
					// 狼队友互相可见（旁观者除外）
					if (game.me.isLang() && player.isLang() && !game.observe) {
						player.showIdentitySelf();
					}
				}
			}
			if (game.me.isLang() && !ui.SWchatButton && !game.observe) {
				ui.create.chatTeam();
			}
		},
		checkOnlineResult(player) {
			if (get.campPopulation("lang") == 0) {
				return player.getCamp() == "ren";
			} else if (swConfig("langrensha_victoryMode") == "tucheng" ? get.campPopulation("ren") == 0 : get.campPopulation("ren", true) == 0 || get.campPopulation("shen", true) == 0) {
				return player.isLang();
			}
			return false;
		},
		checkResult() {
			const me = game.me._trueMe || game.me;
			if (_status.brawl && _status.brawl.checkResult) {
				_status.brawl.checkResult();
				return;
			}
			// 屠城：好人全灭才算狼胜；屠边：神或民一类全灭即算狼胜
			if (swConfig("langrensha_victoryMode") == "tucheng") {
				if (get.campPopulation("lang") > 0 && get.campPopulation("ren") > 0) {
					return;
				}
			} else {
				if (get.campPopulation("lang") > 0 && get.campPopulation("ren", true) > 0 && get.campPopulation("shen", true) > 0) {
					return;
				}
			}
			game.broadcastAll(() => {
				game.showIdentity();
			});
			if (get.campPopulation("lang") == 0) {
				if (me.isLang()) {
					game.over(false);
				} else if (me.getCamp() == "ren") {
					game.over(true);
				} else {
					game.over(false);
				}
			} else if (swConfig("langrensha_victoryMode") == "tucheng" ? get.campPopulation("ren") == 0 : get.campPopulation("ren", true) == 0 || get.campPopulation("shen", true) == 0) {
				if (me.getCamp() == "ren") {
					game.over(false);
				} else if (me.isLang()) {
					game.over(true);
				} else {
					game.over(false);
				}
			} else {
				game.over(false);
			}
		},
		// 点身份角标时能标记的选项：只列出本局真实存在的身份
		getIdentityList(player) {
			if (player.identityShown) {
				return;
			}
			if (player == game.me) {
				return;
			}
			const identityList = _status.identityList || [];
			const obj = {
				lang: "狼",
				yinlang: "隐",
				langwang: "狼王",
				bailang: "白狼",
				pingmin: "民",
				yvyanjia: "预",
				lieren: "猎",
				nvwu: "巫",
				jx_gudushaonv: "觉孤",
			};
			return Object.assign(Object.fromEntries(Object.entries(obj).filter(([key]) => identityList.includes(key))), {
				enemy: "敌",
				friend: "友",
				cai: "猜",
			});
		},
		getIdentityList2(list) {
			const map = {
				lang: "狼人",
				yinlang: "隐狼",
				langwang: "狼王",
				bailang: "白狼",
				nvwu: "女巫",
				pingmin: "平民",
				yvyanjia: "预言",
				jx_gudushaonv: "觉孤",
				lieren: "猎人",
				enemy: "敌方",
				friend: "友方",
			};
			for (const i in list) {
				if (map[i]) {
					list[i] = map[i];
				}
			}
		},
		getRoomInfo(uiintro) {
			uiintro.add('<div class="text chat">游戏模式：' + (swConfig("langrensha_mode") == "normal" ? "标准模式" : "无限火力"));
			uiintro.add(getRule());
		},
		// 分身份 + 各人自选武将。联机由核心的 randomMapOL 末尾直接调进来，单机由 start 手动调。
		// 名字留着 OL 后缀是因为 randomMapOL 硬编码了这个方法名，改名会断掉联机那条路；
		// 内部走 chooseButtonOL，而它本身就有 !_status.connectMode 分支（content.ts:7633），
		// 单机下会顺序跑每个人的 chooseButton，AI 座位由默认 ai(()=>1) 取候选列表第一个。
		chooseCharacterOL() {
			const next = game.createEvent("chooseCharacter");
			next.setContent(async event => {
				const playersAll = game.players.slice(0);
				// 按人数显式列板子。以前是一张定长表 + 从尾部截断，而尾部正好是猎人和白狼，
				// 于是 6/7 人局没有猎人、狼占比还偏高（7 人是 狼3 对 好人4）。
				// 【两条硬约束】① 每个板子至少 1 个平民 —— 屠边判定里
				// get.campPopulation("ren", true) == 0 即狼胜，而 getCamp(true) 只有 pingmin 算 "ren"
				// （觉孤要认下偶像后才算），民数为 0 会在开局第一次 checkResult 就直接判狼胜；
				// ② 8 人普通板和 10 人觉孤板是原设计，不要动。
				const BANZI = {
					normal: {
						6: ["lang", "langwang", "pingmin", "yvyanjia", "nvwu", "lieren"],
						7: ["lang", "langwang", "pingmin", "pingmin", "yvyanjia", "nvwu", "lieren"],
						8: ["lang", "lang", "langwang", "pingmin", "pingmin", "yvyanjia", "nvwu", "lieren"],
						9: ["lang", "lang", "langwang", "pingmin", "pingmin", "pingmin", "yvyanjia", "nvwu", "lieren"],
						10: ["lang", "lang", "langwang", "pingmin", "pingmin", "pingmin", "pingmin", "yvyanjia", "nvwu", "lieren"],
					},
					juegu: {
						6: ["lang", "langwang", "pingmin", "jx_gudushaonv", "yvyanjia", "nvwu"],
						7: ["lang", "langwang", "pingmin", "jx_gudushaonv", "yvyanjia", "nvwu", "lieren"],
						8: ["lang", "lang", "langwang", "pingmin", "jx_gudushaonv", "yvyanjia", "nvwu", "lieren"],
						9: ["lang", "lang", "langwang", "pingmin", "pingmin", "jx_gudushaonv", "yvyanjia", "nvwu", "lieren"],
						10: ["lang", "lang", "langwang", "bailang", "pingmin", "pingmin", "jx_gudushaonv", "yvyanjia", "nvwu", "lieren"],
					},
				};
				const banzi = swConfig("langrensha_banzi") === "juegu" ? BANZI.juegu : BANZI.normal;
				let identityList = (banzi[playersAll.length] || []).slice(0);
				// 人数落在表外（菜单只给 6~10，但联机房的人数选项是 2~10）时退回老办法：
				// 拿最大的那张表截断，再补平民。补平民这一步不能省 —— 少了它多出来的人
				// identity 会是 undefined，getCamp() 当好人、getCamp(true) 还算成"神职"，
				// 直接歪掉屠边判定，结算时身份牌也会显示成 "undefined2"。
				if (!identityList.length) {
					identityList = banzi[10].slice(0, playersAll.length);
				}
				while (identityList.length < playersAll.length) {
					identityList.push("pingmin");
				}
				identityList.randomSort();

				game.broadcastAll(
					(players, identityList) => {
						_status.identityList = identityList;
						for (let i = 0; i < players.length; i++) {
							players[i].identity = identityList[i];
							players[i].side = players[i].isLang();
							players[i].setIdentity("cai");
							players[i].node.identity.classList.add("guessing");
							players[i].identityShown = false;
						}
						game.me.setIdentity();
						game.me.node.identity.classList.remove("guessing");
						if (game.me.isLang() && !ui.SWchatButton) {
							ui.create.chatTeam();
						}
						ui.arena.classList.add("choose-character");
					},
					playersAll,
					identityList
				);
				// 狼人开局互相亮身份
				for (let i = 0; i < playersAll.length; i++) {
					if (!playersAll[i].isLang()) {
						continue;
					}
					if (playersAll[i] === game.me) {
						game.players.forEach(p => {
							if (p.isLang()) {
								p.showIdentitySelf();
							}
						});
					} else if (playersAll[i].isOnline2()) {
						playersAll[i].send(() => {
							game.players.forEach(p => {
								if (p.isLang()) {
									p.showIdentitySelf();
								}
							});
						});
					}
				}

				const list2 = [];
				const list3 = [];
				const list4 = [];
				event.list = [];
				event.list2 = [];

				const libCharacter = {};
				if (_status.connectMode) {
					// 联机：主机的 lib.character 可能含房间没开的包，只能按房间的 characterPack 取
					for (let i = 0; i < lib.configOL.characterPack.length; i++) {
						const pack = lib.characterPack[lib.configOL.characterPack[i]];
						for (const j in pack) {
							if (lib.character[j]) {
								libCharacter[j] = lib.character[j];
							}
						}
					}
				} else {
					// 单机：lib.character 本身就已经是"启用的包"，直接整个拿（identity.js:2179 同做法）
					for (const j in lib.character) {
						libCharacter[j] = lib.character[j];
					}
				}
				for (const i in lib.characterReplace) {
					const ix = lib.characterReplace[i];
					for (let j = 0; j < ix.length; j++) {
						if (!libCharacter[ix[j]] || lib.filter.characterDisabled(ix[j])) {
							ix.splice(j--, 1);
						}
					}
					if (ix.length) {
						event.list.push(i);
						event.list2.push(i);
						list4.addArray(ix);
						let bool = false;
						for (const j of ix) {
							if (libCharacter[j].isZhugong) {
								bool = true;
								break;
							}
						}
						(bool ? list2 : list3).push(i);
					}
				}
				game.broadcast(function (list) {
					for (const i in lib.characterReplace) {
						const ix = lib.characterReplace[i];
						for (let j = 0; j < ix.length; j++) {
							if (!list.includes(ix[j])) {
								ix.splice(j--, 1);
							}
						}
					}
				}, list4);
				for (const i in libCharacter) {
					if (list4.includes(i)) {
						continue;
					}
					if (lib.filter.characterDisabled(i, libCharacter)) {
						continue;
					}
					event.list.push(i);
					event.list2.push(i);
					list4.push(i);
					if (libCharacter[i].isZhugong) {
						list2.push(i);
					} else {
						list3.push(i);
					}
				}
				_status.characterlist = list4.slice(0);

				const chooseList = [];
				const selectButton = swConfig("double_character") ? 2 : 1;
				// 选将框数要卡住上限：每人 randomRemove(listNum) 是从同一个池里往外掏，
				// listNum × 人数 超过池子的话后面几个人会拿到空列表 → 选不出东西 →
				// result 没有 links → 下面 result[i].links 取下标直接抛。
				// 默认 20 框 × 10 人 = 200，禁将开得多或只启用少数武将包时够得着这条线
				const listNum = Math.max(1, Math.min(getSelectNum(), Math.floor(event.list.length / playersAll.length)));

				// 选将期间临时把出牌时限改成选将时限，选完还原。
				// 单机没有 configOL 也没有超时机制（chooseButton 就 game.pause() 等点击），跳过
				if (_status.connectMode) {
					event.useTime = lib.configOL.choose_timeout;
					game.broadcastAll(time => {
						lib.configOL.choose_timeout = time;
					}, parseInt(lib.configOL.chooseCharacter_moreTime));
				}

				for (let i = 0; i < playersAll.length; i++) {
					const identity = playersAll[i].identity;
					const str = "狼人三国杀：请选择你的角色。（" + get.translation(`${identity}2`) + "）";
					chooseList.push([playersAll[i], [str, [event.list.randomRemove(listNum), "characterx"]], selectButton, true]);
				}
				const result = await game.me
					.chooseButtonOL(chooseList, function (player, result) {
						// 没选出来的情况留给下面的兜底统一处理，别在回调里抛
						if ((game.online || player == game.me) && result && result.links) {
							player.init(result.links[0], result.links[1]);
						}
					})
					.forResult();
				const shen = [];
				let result2 = {};
				for (const i in result) {
					if (result[i] && result[i].links) {
						for (let j = 0; j < result[i].links.length; j++) {
							event.list2.remove(get.sourceCharacter(result[i].links[j]));
						}
					}
				}
				for (const i in result) {
					// "ai" 是超时未选；没有 links 则是压根没选出来（池子被掏空、或中途断线），
					// 两种都当"随机顶一个"处理，不然下面 result[i][0] 会抛
					if (result[i] == "ai" || !result[i] || !result[i].links) {
						result[i] = event.list2.randomRemove(selectButton);
						for (let j = 0; j < result[i].length; j++) {
							const listx = lib.characterReplace[result[i][j]];
							if (listx && listx.length) {
								result[i][j] = listx.randomGet();
							}
						}
					} else {
						result[i] = result[i].links;
					}
					if (get.is.double(result[i][0]) || (lib.character[result[i][0]] && (lib.character[result[i][0]].group == "shen" || lib.character[result[i][0]].group == "western") && !lib.character[result[i][0]].hasHiddenSkill)) {
						shen.push(lib.playerOL[i]);
					}
				}
				// 双将/神将要额外选一次势力
				if (shen.length) {
					const groupList = ["wei", "shu", "wu", "qun", "jin", "key"];
					for (let i = 0; i < groupList.length; i++) {
						if (!lib.group.includes(groupList[i])) {
							groupList.splice(i--, 1);
						} else {
							groupList[i] = ["", "", "group_" + groupList[i]];
						}
					}
					for (let i = 0; i < shen.length; i++) {
						if (get.is.double(result[shen[i].playerid][0])) {
							shen[i]._groupChosen = "double";
							shen[i] = [
								shen[i],
								[
									"请选择你的势力",
									[
										get.is.double(result[shen[i].playerid][0], true).map(function (i) {
											return ["", "", "group_" + i];
										}),
										"vcard",
									],
								],
								1,
								true,
							];
						} else {
							shen[i]._groupChosen = "kami";
							shen[i] = [shen[i], ["请选择你的势力", [groupList, "vcard"]], 1, true];
						}
					}
					result2 = await game.me
						.chooseButtonOL(shen, function (player, result) {
							if (player == game.me) {
								player.changeGroup(result.links[0][2].slice(6), false, false);
							}
						})
						.set("switchToAuto", function () {
							_status.event.result = "ai";
						})
						.set("processAI", function () {
							return {
								bool: true,
								links: [_status.event.dialog.buttons.randomGet().link],
							};
						})
						.forResult();
				}

				for (const i in result2) {
					if (result2[i] && result2[i].links) {
						result2[i] = result2[i].links[0][2].slice(6);
					} else if (result2[i] == "ai") {
						const groupList = ["wei", "shu", "wu", "qun", "jin", "key"];
						for (let ix = 0; ix < groupList.length; ix++) {
							if (!lib.group.includes(groupList[ix])) {
								groupList.splice(ix--, 1);
							}
						}
						result2[i] = groupList.randomGet();
					}
				}

				game.broadcastAll(
					function (result, result2) {
						for (const i in result) {
							if (!lib.playerOL[i].name) {
								lib.playerOL[i].init(result[i][0], result[i][1]);
							}
							if (result2[i] && result2[i].length) {
								lib.playerOL[i].changeGroup(result2[i], false, false);
							}
						}
					},
					result,
					result2
				);

				for (let i = 0; i < game.players.length; i++) {
					_status.characterlist.remove(game.players[i].name);
					_status.characterlist.remove(game.players[i].name1);
					_status.characterlist.remove(game.players[i].name2);
				}

				if (_status.connectMode) {
					game.broadcastAll(time => {
						lib.configOL.choose_timeout = time;
					}, event.useTime);
				}

				game.broadcastAll(() => {
					setTimeout(function () {
						ui.arena.classList.remove("choose-character");
					}, 500);
				});
			});
			return next;
		},
	},

	element: {
		player: {
			// 行为暴露度的更新入口，实现见 config/ai.js。core 只做
			// `typeof this.logAi == "function"` 判断，本体没有默认实现，各模式自己写一份
			logAi,
			// 狼人发言：客户端 → 主机 → 转发给全部存活狼人
			chatTeamOnline(str) {
				if (get.is.banWords(str) || !this.isLang()) {
					return;
				}
				const players = game.filterPlayer2();
				for (let i = 0; i < players.length; i++) {
					const current = players[i];
					if (!current.isLang()) {
						continue;
					}
					if (current == game.me) {
						this.chatTeam(str);
					} else if (current.isOnline2()) {
						current.send(
							function (id, str) {
								if (lib.playerOL[id]) {
									lib.playerOL[id].chatTeam(str);
								} else if (game.connectPlayers) {
									for (let i = 0; i < game.connectPlayers.length; i++) {
										if (game.connectPlayers[i].playerid == id) {
											game.connectPlayers[i].chatTeam(str);
											return;
										}
									}
								}
							},
							this.playerid,
							str
						);
					}
				}
			},
			// 在头像旁弹一个带"(队内)"前缀的气泡，并写进队内聊天记录
			chatTeam(str) {
				if (!get.is.emotion(str)) {
					str = get.plainText(str);
				}
				str = str.replace(/##assetURL##/g, lib.assetURL);
				const dialog = ui.create.dialog("hidden");
				dialog.classList.add("static");
				dialog.add('<div class="text" style="word-break:break-all;display:inline">' + `<span class="bluetext">(队内)</span>` + str + "</div>");
				dialog.classList.add("popped");
				ui.window.appendChild(dialog);
				const width = dialog.content.firstChild.firstChild.offsetWidth;
				if (width < 190) {
					dialog._mod_height = -16;
				} else {
					dialog.content.firstChild.style.textAlign = "left";
				}
				dialog.style.width = width + 16 + "px";
				let refnode;
				if (this.node && this.node.avatar && this.parentNode == ui.arena) {
					refnode = this.node.avatar;
				}
				if (refnode) {
					lib.placePoppedDialog(dialog, {
						clientX: (ui.arena.offsetLeft + this.getLeft() + refnode.offsetLeft + refnode.offsetWidth / 2) * game.documentZoom,
						clientY: (ui.arena.offsetTop + this.getTop() + refnode.offsetTop + refnode.offsetHeight / 4) * game.documentZoom,
					});
				} else {
					lib.placePoppedDialog(dialog, {
						clientX: (this.getLeft() + this.offsetWidth / 2) * game.documentZoom,
						clientY: (this.getTop() + this.offsetHeight / 4) * game.documentZoom,
					});
				}
				if (dialog._mod_height) {
					dialog.content.firstChild.style.padding = 0;
				}
				setTimeout(function () {
					dialog.delete();
				}, 5000);
				const identity = get.translation(this.identity + "2");
				const info = [`<span class="bluetext">(队内)</span>` + (identity ? this.nickname + "[" + identity + "]" : this.nickname), str];
				lib.SWchatHistory ??= [];
				lib.SWchatHistory.push(info);
				if (_status.SWaddChatEntry) {
					if (_status.SWaddChatEntry._origin.parentNode) {
						_status.SWaddChatEntry(info, false);
					} else {
						delete _status.SWaddChatEntry;
					}
				}
			},
			// 覆盖核心实现：身份名可能超过 4 个字（觉醒孤独少女），要折行并缩字号
			setIdentity(identity, nature) {
				if (!identity) {
					identity = this.identity;
				}
				let str = get.translation(identity);
				if (str.length >= 5) {
					str = str.slice(0, 2) + `<br>` + str.slice(2);
					this.node.identity.dataset.swScale = "scale1";
				} else {
					delete this.node.identity.dataset.swScale;
				}
				this.node.identity.firstChild.innerHTML = str;
				this.node.identity.dataset.color = nature || identity;
				return this;
			},
			// 只给自己（或队友）看的身份点亮，不设 identityShown，别人看还是"猜"
			showIdentitySelf() {
				this.node.identity.classList.remove("guessing");
				this.forceShown = true;
				this.setIdentity();
				if (_status.clickingidentity) {
					for (let i = 0; i < _status.clickingidentity[1].length; i++) {
						_status.clickingidentity[1][i].delete();
						_status.clickingidentity[1][i].style.transform = "";
					}
					delete _status.clickingidentity;
				}
			},
			// 夜间技能按"能力"走，觉孤继承偶像身份后能力会变（_ability）
			getAbility() {
				const ability = this?.swState?._ability || this.identity;
				switch (ability) {
					case "lang":
					case "yinlang":
					case "langwang":
					case "bailang":
						return "lang";
					default:
						return ability;
				}
			},
			// hidden=true 时把隐狼也算进来（隐狼与狼队友互相不可见）
			isLang(hidden) {
				return this.getCamp() == "lang" && (hidden ? true : this.identity != "yinlang");
			},
			// elobrate=true 时区分神/民，用于屠边判定
			getCamp(elobrate) {
				const identity = this.identity;
				if (this?.swState?._trueCamp) {
					const _trueCamp = this.swState._trueCamp;
					return elobrate ? _trueCamp : _trueCamp == "shen" ? "ren" : _trueCamp;
				}
				if (["lang", "yinlang", "langwang", "bailang"].includes(identity)) {
					return "lang";
				} else if (["jx_gudushaonv"].includes(identity)) {
					return "npc";
				}
				if (elobrate) {
					if (["pingmin"].includes(identity)) {
						return "ren";
					}
					return "shen";
				}
				return "ren";
			},
			// 死亡时先盖一张空白身份牌占位，真身份留到结算才公开
			$dieAfter() {
				if (_status.video) {
					return;
				}
				if (!this.node.dieidentity) {
					const node = ui.create.div(".damage.dieidentity", "", this);
					ui.refresh(node);
					node.style.opacity = 1;
					this.node.dieidentity = node;
				}
				const trans = this.style.transform;
				if (trans) {
					if (trans.indexOf("rotateY") != -1) {
						this.node.dieidentity.style.transform = "rotateY(180deg)";
					} else if (trans.indexOf("rotateX") != -1) {
						this.node.dieidentity.style.transform = "rotateX(180deg)";
					} else {
						this.node.dieidentity.style.transform = "";
					}
				} else {
					this.node.dieidentity.style.transform = "";
				}
			},
			dieAfter(source) {
				// 觉醒孤独少女的阵营转换：看偶像是怎么死的
				for (let i = 0; i < game.players.length; i++) {
					const player = game.players[i];
					if (player.identity != "jx_gudushaonv") {
						continue;
					}
					const jx_anlian = player?.swState?.jx_anlian;
					if (!jx_anlian || jx_anlian != this) {
						continue;
					}
					if (get.event()?.getParent("damage")?.source == player) {
						// 亲手杀了偶像：变中立，本局目标算失败
						game.broadcastAll(player => {
							player.swState ??= {};
							delete player.swState.jx_anlian;
							delete player.swState._ability;
							delete player.swState._trueCamp;
							if (player == game.me) {
								game.createTip("由于偶像因为你阵亡，你本局的游戏目标已失败且加入中立阵营");
							}
						}, player);
					} else if (get.event()?.getParent("loseHp")?._reason == "lang" || get.event()?.getParent("damage")?.source?.isLang()) {
						// 偶像被狼弄死：继承偶像的身份和阵营
						game.broadcastAll(
							(player, target) => {
								if (game.me.isLang() && target.isLang()) {
									game.createTip("由于偶像为狼人阵营，觉醒孤独少女已加入狼人阵营！");
									player.showIdentitySelf();
									player.setIdentity(player.identity, "lang");
								}
								player.swState ??= {};
								delete player.swState.jx_anlian;
								player.swState._ability = target.identity;
								player.swState._trueCamp = target.getCamp(true);
								if (player == game.me) {
									player.setIdentity(player.identity, target.identity);
									game.createTip("偶像由于狼人阵亡，你继承偶像的" + get.translation(target.identity + "2") + "身份和阵营！");
									if (target.isLang()) {
										if (!ui.SWchatButton) {
											ui.create.chatTeam();
										}
										const players = game.filterPlayer2();
										for (let i = 0; i < players.length; i++) {
											if (players[i].isLang()) {
												players[i].showIdentitySelf();
											}
										}
									}
								}
							},
							player,
							this
						);
					} else {
						// 其他死法：入狼阵营，但狼刀为 0
						game.broadcastAll(player => {
							if (game.me.isLang()) {
								game.createTip("由于偶像阵亡，觉醒孤独少女已加入狼人阵营！");
								player.showIdentitySelf();
								player.setIdentity(player.identity, "lang");
							}
							player.swState ??= {};
							delete player.swState.jx_anlian;
							player.swState._ability = "lang";
							player.swState._trueCamp = "lang";
							player.swState.langdao = 0;
							if (player == game.me) {
								game.createTip("由于偶像阵亡，你已加入狼人阵营！");
								player.setIdentity(player.identity, "lang");
								if (!ui.SWchatButton) {
									ui.create.chatTeam();
								}
								const players = game.filterPlayer2();
								for (let i = 0; i < players.length; i++) {
									if (players[i].isLang()) {
										players[i].showIdentitySelf();
									}
								}
							}
						}, player);
					}
				}
				game.checkResult();
				// 只剩一个人的阵营给个"投降"按钮，免得 1v1 拖着
				if (!_status.over) {
					let giveup;
					if (get.campPopulation("lang") == 1) {
						giveup = game.players.find(current => current.isLang());
					} else if (get.campPopulation("ren") == 1) {
						giveup = game.players.find(current => current.getCamp() == "ren");
					}
					if (giveup) {
						giveup.showGiveup();
					}
				}
			},
			// 重连时重建头像上的身份角标：自己看得见真身份，别人一律"猜"
			setModeState(info) {
				if (!info.name) {
					return;
				}
				this.init(info.name1, info.name2, false);
				this.name1 = info.name1;
				this.name = info.name;
				this.node.name_seat = ui.create.div(".name.name_seat", get.verticalStr(lib.translate[this.name].slice(0, 3)), this);
				if (info.identityShown) {
					this.setIdentity(info.identity);
					this.node.identity.classList.remove("guessing");
				} else if (this == game.me && !game.observe) {
					this.setIdentity(info.identity);
					this.node.identity.classList.remove("guessing");
					this.forceShown = true;
				} else {
					this.setIdentity("cai");
					this.node.identity.firstChild.innerHTML = "猜";
					this.node.identity.classList.add("guessing");
				}
			},
		},
	},

	ui: {
		updatePlayerPositions,
		create: {
			chatTeam: createChatTeam,
		},
		click: {
			chatTeam: clickChatTeam,
		},
	},

	get: {
		// 客户端的装载器入口，见 swInstallLangrensha 的注释
		swInstallLangrensha,
		campPopulation(camp, elobrate) {
			return camp == undefined ? game.players.length + game.dead.length : game.players.filter(current => current.getCamp(elobrate) == camp).length;
		},
		// 态度算法见 config/ai.js。只实现 rawAttitude 而不覆盖 attitude：
		// 外面那层 get.attitude（get/index.js:6547）还要处理 isMad 反转和
		// modAttitudeFrom/To，覆盖掉就全丢了
		rawAttitude,
		// 查验结果：隐狼查出来是好人
		insightResult(from, to) {
			const toCamp = to.getCamp();
			return toCamp !== "lang" || to.identity == "yinlang" ? "hao" : "huai";
		},
	},

	// 其它 → 帮助 里的条目。身份/谋攻等模式都是这么挂的（identity.js:5213），
	// switchMode 会把它合并进 lib.help（game/index.js 里那圈"其余字段并进 lib"的循环），
	// 而一次只加载一个模式，所以天然只在玩狼人杀时出现。
	// 内容直接复用 getRule()，不再另写一份 —— 本模式的规则文案已经有两处要手动同步
	// （getRule + library/index.js 的 getLangrenshaRule），别再添第三处。
	help: {
		狼人杀: getRule(),
	},

	skill,
	translate,
});
