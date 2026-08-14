import { game, ui, _status, ai, lib, get } from "noname";

import { markGuessedGood, markInsight } from "./ai.js";

// 狼人杀的两条"规则技"。技能名以下划线开头 → game.finishSkill 会自动 addGlobalSkill，
// 无需给每个角色手动加技能；ruleSkill 只是把优先级压低(_priority -= 75)，让它排在角色技后面。
/**
 * 跳身份的台词池。
 *
 * 【真预言家和冒充的狼必须共用同一个池】如果两边措辞不同，措辞本身就成了破译线索 ——
 * 这跟"后跳的一定是假的"是同一类漏洞，只是从顺序换成了用词。所以这里按「说什么」分类，
 * 而不是按「谁在说」分类。
 * 首次/后续分开：第一次要自报身份（起跳），之后就不用每次都重复"我是预言家"了。
 */
const SW_TALK = {
	查杀首次: ["我是预言家，昨晚验了{0}，狼人", "起跳预言家，{0} 查杀", "我预言家，验的 {0}，是狼，别放过他", "跳个预言家，{0} 是狼"],
	查杀后续: ["昨晚验了 {0}，也是狼", "{0} 查杀", "我又验了 {0}，狼人", "昨晚的 {0}，狼"],
	金水首次: ["我是预言家，昨晚验了{0}，好人", "起跳预言家，{0} 金水", "我预言家，{0} 是好人，可以信", "跳预言家，{0} 金水"],
	金水后续: ["{0} 金水", "昨晚验的 {0}，好人", "我验了 {0}，是好人", "{0} 是好人，不用查了"],
};

/**
 * 冒充预言家时挑"查杀谁"用的威胁度。
 *
 * 【为什么不能直接用态度排序】rawAttitude 里的威胁项只是 (血 + 手牌/2) * 0.04，
 * 而开局所有人都是 4 血 4 牌 —— 完全同分，sort 退化成按座位取第一个，于是"狼总是点
 * 某个位置的人"又成了一条固定行为模式。
 * get.threaten 才是本体的威胁度口径：把目标身上每个技能声明的 ai.threaten 乘起来，
 * 也就是"武将技能有多强"。第三参不传 —— 传了它会把残血算成"更好打"（get.effect 用的是
 * 那个语义），而这里要的是"谁最该被除掉"，方向相反。
 * 最后加一点随机打散近似平手，免得同强度的人里又固定挑同一个。
 */
function swThreat(target, viewer) {
	return get.threaten(target, viewer) * 2 + target.hp * 0.3 + target.countCards("h") * 0.2 + Math.random() * 0.5;
}

/** 从池子里随机取一句并填名字。这里的随机是纯展示用，不影响任何判定 */
function swTalkLine(kind, first, name) {
	const pool = SW_TALK[kind + (first ? "首次" : "后续")];
	return pool.randomGet().replace("{0}", name);
}

export default {
	// 每轮开始的"夜晚"：所有人同时行动，30 秒限时，之后按 觉孤 → 狼刀 → 女巫 → 预言家 的顺序结算。
	_sw_roundSkill: {
		trigger: { global: "roundStart" },
		ruleSkill: true,
		charlotte: true,
		direct: true,
		slient: true,
		firstDo: true,
		filter(event, player, name) {
			// 全局技能每个角色身上都会触发一次，用轮次号去重，保证一轮只跑一遍
			return !_status.langrenshaRound || _status.langrenshaRound < game.roundNumber;
		},
		async content(event, trigger, player) {
			_status.langrenshaRound = game.roundNumber;
			// 本轮的狼刀记账（playerid → 已安排的伤害），供狼刀 AI 避免把刀叠在同一人身上浪费。
			// 每轮清空。只记 AI 狼的选择：真人是并行秘密选的，主机在他响应前拿不到，
			// 而且把真人的秘密选择透给 AI 队友也不合适。
			_status.swNightPlan = {};
			// 狼刀提示要带的队内信息，只推给狼（见 ① 之后那段推送）。
			// 【为什么在主机侧算总量、不让客户端现算】狼死后会把每轮狼刀转移给队友
			// （swState.langdao 变动），而客户端的 swState 只在 game.syncState() 时同步一次，
			// 客户端自己算会用过期数字。主机侧的 swState 才是权威。
			// 只统计 isLang() 的存活狼 —— 正好把隐狼排除在外，而狼队本来就看不见隐狼，
			// 所以这个总量恰好等于"狼队自己以为的总量"，不构成作弊。
			let swTeamDao = 0;
			for (const one of game.players) {
				if (one.isLang()) {
					swTeamDao += one?.swState?.langdao || 0;
				}
			}
			_status.swNightPlanText = swTeamDao ? `全队本轮共 ${swTeamDao} 点` : "";
			const targets = game.players.slice(0).sortBySeat();
			let answer_result = [[], []];
			let humans = targets.filter(current => current === game.me || current.isOnline()); // 真人
			let locals = targets.slice(0).randomSort(); // 本机托管的角色
			locals.removeArray(humans);
			// 【AI 狼排在真人之前决策】原来是"真人并行 → AI 顺序"，于是真人狼永远看不到 AI 队友
			// 刀了谁 —— 而真狼人杀里狼队是能互相看的（本模式只给了队内聊天，AI 又不会发言）。
			// 把 AI 狼提到最前面，它们决策完就往队内频道报一句、并汇总进 _status.swNightPlanText
			// 塞给真人狼的选择提示，真人于是能避开重复刀、或者一起集火收人头。
			// 决策顺序不影响结算：下面的结算是按 getAbility 遍历 answer_result 的，与顺序无关。
			const localLang = locals.filter(current => current.getAbility() === "lang");
			const localOther = locals.slice(0);
			localOther.removeArray(localLang);
			// 按身份给出对应的夜间选择。同一函数既在主机本地执行，也被 send 到客户端执行，
			// 故内部不能引用闭包外的变量。
			const send = current => {
				let next;
				switch (current.getAbility()) {
					case "lang":
						next = current.chooseTarget(get.prompt2("狼刀"));
						next.set("ai", target => {
							const player = get.player();
							const dmg = player?.swState?.langdao || 1;
							// _status.swNightPlan 记的是本轮已经由 AI 狼安排出去的刀（见下面 locals 循环）。
							// 狼刀同目标会累加，所以要区分三种情形，否则会出现"三头狼把 4 点全砸在
							// 1 血的人身上"这种纯浪费，或者"永远只挑没刀过的满血人、第二轮不去收残血"。
							const planned = (_status.swNightPlan && _status.swNightPlan[target.playerid]) || 0;
							let score = -get.attitude(player, target);
							if (planned >= target.hp) {
								score -= 4; // 队友的刀已经够收掉他了，再叠上去是纯浪费
							} else if (planned + dmg >= target.hp) {
								score += 3; // 这一刀正好能收人头 —— 最高优先
							} else {
								score += (5 - Math.min(5, target.hp)) * 0.3; // 收不掉就越残血越优先
							}
							return score;
						});
						// 提示里带上队内信息（_status.swNightPlanText，只推给狼，自带"全队本轮共 N 点｜
						// 队友已选：…"的标签）：免得真人狼盲选 —— 要么撞在同一个满血目标上浪费，
						// 要么该集火收人头时没集火。气泡会消失，但队内聊天里也报了一份，翻记录能查。
						next.set("prompt2", "选择一名角色，使其流失" + (current.swState.langdao || 1) + "点体力。（不触发技能）" + (_status.swNightPlanText ? '<br><span class="bluetext">' + _status.swNightPlanText + "</span>" : ""));
						next.set("_global_waiting", true);
						break;
					case "nvwu":
						next = current.chooseButtonTarget({
							createDialog: [
								`###${get.prompt2("巫术")}###<div class="text center">选择复活或者毒杀一名角色<br>（每局游戏仅能使用一次！首轮无法使用！）</div>`,
								[
									[
										["revive", "复活"],
										["kill", "毒杀"],
									],
									"tdnodes",
								],
							],
							filterButton(button) {
								// get.event("xxx") 是废弃写法，每次调用都会打一条 console 警告（compatible.js:191）
								if (!get.event().canuse) {
									return false;
								}
								if (button.link == "revive") {
									return game.dead.length;
								}
								return true;
							},
							filterTarget(card, player, target) {
								return true;
							},
							selectTarget() {
								// 复活只能选死人、毒杀只能选活人，故按选中的按钮动态改写 filterTarget
								if (ui.selected.buttons.length) {
									const link = ui.selected.buttons[0].link;
									if (link == "revive") {
										_status.event.deadTarget = true;
										_status.event.filterTarget = function (card, player, target) {
											return target.isDead();
										};
										return 1;
									} else {
										_status.event.deadTarget = false;
										_status.event.filterTarget = function (card, player, target) {
											return !target.isDead();
										};
										return 1;
									}
								}
								return 0;
							},
							ai1(button) {
								const player = get.player();
								if (button.link == "revive") {
									// 复活回来是 3 体力 + 3 张牌，很值，但只救自己真信得过的人
									let best = 0;
									for (const current of game.dead) {
										best = Math.max(best, get.attitude(player, current));
									}
									return best - 2;
								}
								// 毒是一局一次的一发子弹，只对已经咬定的狼放
								let worst = 0;
								for (const current of game.players) {
									if (current == player) {
										continue;
									}
									worst = Math.min(worst, get.attitude(player, current));
								}
								return -worst - 2;
							},
							ai2(target) {
								const player = get.player();
								// 上面的 selectTarget 已按选中的按钮把 filterTarget 切成"只能选死人/只能选活人"，
								// 这里跟着 deadTarget 取相反方向：救人挑最信的，下毒挑最恨的
								return get.event().deadTarget ? get.attitude(player, target) : -get.attitude(player, target);
							},
						});
						next.set("canuse", !current.swState.nvwu && game.roundNumber > 1);
						next.set("_global_waiting", true);
						break;
					case "yvyanjia":
						next = current.chooseTarget(get.prompt2("预言"), "选择一名未查验过的角色，查验其的身份。");
						// 【把自己以前的验人结果写回提示】原来结果只在查验那一刻闪 5 秒，之后人类玩家
						// 无处可查；而 AI 预言家的 ai.swInsight 永久记着，甚至人类托管后 AI 接手还能用
						// —— "AI 记得、人不记得"是纯粹的不对称，且是给 AI 加记忆时引入的。
						// 提示只发给本人，是天然的私有通道，不用新造 UI、也不会泄漏给别人。
						// 结果不必另存：get.insightResult 只依赖目标身份，客户端本地就能算；
						// "验过谁"在 storage 里（markAuto → markSkill 会同步给客户端，
						// 上面那条 filterTarget 也正是靠它去重的）。
						{
							const seen = current.getStorage("sw_yvyanjiaInsight");
							if (seen.length) {
								next.set("prompt2", '选择一名未查验过的角色。<br><span class="bluetext">已验：' + seen.map(one => get.translation(one) + "=" + (get.insightResult(current, one) === "huai" ? "狼人" : "好人")).join("、") + "</span>");
							}
						}
						next.set("filterTarget", (card, player, target) => {
							return target != player && !player.getStorage("sw_yvyanjiaInsight").includes(target);
						});
						next.set("ai", target => {
							const player = get.player();
							// 查验没有代价，不该空过——chooseTarget 的 AI 在最高分 <=0 时会放弃
							// （ai/basic.js:223），所以给个正基线，再按可疑度排序。
							// 已经很信任的人反过来不值得占掉这次查验
							return 3 - get.attitude(player, target);
						});
						next.set("_global_waiting", true);
						break;
					case "jx_gudushaonv":
						if (!current?.swState?.jx_anlian && game.roundNumber == 1) {
							next = current.chooseTarget(get.prompt2("书以寄情"), lib.filter.notMe);
							next.set("ai", target => {
								const player = get.player();
								// 认下偶像后自己就归平民阵营，而偶像死在自己手上直接判本局目标失败，
								// 所以挑一个看着最像好人、又最耐活的
								return get.attitude(player, target) + target.hp + target.countCards("h") / 2;
							});
							next.set("prompt2", "选择一名角色，使其成为你的偶像");
							next.set("forced", true);
							next.set("_global_waiting", true);
							break;
						}
						// 已认下偶像的觉孤：和平民一样只有空过一手，但提示里要报出偶像是谁。
						// 偶像死在自己手上直接判本局目标失败，而 AI 觉孤靠 swState.jx_anlian 永远记得，
						// 人类玩家几轮之后很可能忘 —— 同样是"AI 记得、人不记得"。
						// jx_anlian 是 broadcastAll 存的，客户端本地就有；提示只发给本人，不会泄漏。
						next = current.chooseBool(get.prompt2("空白"), "你没有能够在此时发动的技能，点哪个都一样~~~");
						if (current?.swState?.jx_anlian) {
							next.set("prompt2", '你没有能够在此时发动的技能。<br><span class="bluetext">你的偶像：' + get.translation(current.swState.jx_anlian) + "（死在你手上会直接判负）</span>");
						}
						next.set("_global_waiting", true);
						break;
					default:
						next = current.chooseBool(get.prompt2("空白"), "你没有能够在此时发动的技能，点哪个都一样~~~");
						next.set("_global_waiting", true);
						break;
				}
				if (game.online) {
					game.resume();
				}
				return next;
			};
			event._global_waiting = true;
			let time = 30000; // 30s 选择时间
			game.players.forEach(current => current.showTimer(time));
			game.broadcastAll(() => {
				_status.roundSkilling = true;
			});
			await game.delayx();
			// ── ① AI 狼先决策，结果播报给狼队 ──
			if (localLang.length > 0) {
				for (const current of localLang) {
					const result = await send(current).forResult();
					answer_result[0].push(current);
					answer_result[1].push(result);
					if (!result?.bool || !result.targets?.length) {
						continue;
					}
					const knifed = result.targets[0];
					const dmg = current?.swState?.langdao || 1;
					if (knifed?.playerid) {
						// 记账供后面的 AI 狼避免把刀叠在同一人身上浪费
						_status.swNightPlan[knifed.playerid] = (_status.swNightPlan[knifed.playerid] || 0) + dmg;
					}
					// 往队内频道报一句。chatTeamOnline 只发给狼（且只有 game.me / 在线真人狼收得到，
					// AI 之间互相不用看），并且会进 lib.SWchatHistory，气泡消失后还能翻聊天记录
					current.chatTeamOnline(`我刀 ${get.translation(knifed)}（${dmg}点）`);
					// 追加到提示串。开头已经是"全队本轮共 N 点"，第一条选择用「｜队友已选：」接上
					_status.swNightPlanText += `${/队友已选/.test(_status.swNightPlanText) ? "、" : "｜队友已选："}${get.translation(current)}→${get.translation(knifed)}(${dmg}点)`;
				}
			}
			// 把队内信息（全队夜刀总量 + AI 队友已选）推给狼，不 broadcastAll —— 没必要让非狼的
			// 客户端也拿到狼队计划。放在 ① 之外：就算一头 AI 狼都没有（狼队全是真人），
			// 全队总量那一句也该发出去。
			if (_status.swNightPlanText) {
				const wolves = game.filterPlayer2();
				for (let i = 0; i < wolves.length; i++) {
					if (!wolves[i].isLang()) {
						continue;
					}
					if (wolves[i] === game.me) {
						continue; // 主机侧 _status 已经是同一份
					}
					if (wolves[i].isOnline2()) {
						wolves[i].send(text => {
							_status.swNightPlanText = text;
						}, _status.swNightPlanText);
					}
				}
			}
			if (humans.length > 0) {
				const solve = function (resolve, reject) {
					return function (result, player) {
						answer_result[0].push(player);
						answer_result[1].push(result);
						resolve();
					};
				};
				// 真人并行等待：谁先选完谁先落袋，不按座位顺序阻塞
				await Promise.all(
					humans.map(current => {
						return new Promise((resolve, reject) => {
							if (current.isOnline()) {
								current.send(send, current);
								current.wait(solve(resolve, reject));
							} else {
								const next = send(current);
								const solver = solve(resolve, reject);
								if (_status.connectMode) {
									game.me.wait(solver);
								}
								return next.forResult().then(result => {
									if (_status.connectMode) {
										game.me.unwait(result, current);
									} else {
										solver(result, current);
									}
								});
							}
						});
					})
				).catch(() => {});
			}
			// ── ③ 其余 AI（预言家/女巫/猎人/觉孤）最后决策 ──
			if (localOther.length > 0) {
				for (const current of localOther) {
					const result = await send(current).forResult();
					answer_result[0].push(current);
					answer_result[1].push(result);
				}
			}
			delete event._global_waiting;
			game.players.forEach(current => current.hideTimer());
			game.broadcastAll(() => {
				_status.roundSkilling = false;
				// 队友刀谁的提示只在本轮夜里有意义，清掉免得下一轮/别处的提示里带出旧内容
				_status.swNightPlanText = "";
			});
			// 结算觉醒孤独少女：认下偶像并暂时归入平民阵营
			for (let i = 0; i < answer_result[0].length; i++) {
				const now = answer_result[0][i];
				const result = answer_result[1][i];
				if (!result?.bool) {
					continue;
				}
				if (now.getAbility() == "jx_gudushaonv" && result?.targets?.length) {
					const target = result.targets[0];
					game.broadcastAll(
						(player, target) => {
							player.swState ??= {};
							player.swState.jx_anlian = target;
							player.swState._trueCamp = "ren";
						},
						now,
						target
					);
				}
			}
			// 结算狼刀：同一目标被多把刀选中则伤害累加
			const langdao = [[], []];
			for (let i = 0; i < answer_result[0].length; i++) {
				const now = answer_result[0][i];
				const result = answer_result[1][i];
				if (!result?.bool) {
					continue;
				}
				if (now.getAbility() == "lang") {
					const target = result.targets[0];
					const index = langdao[0].indexOf(target);
					const dnum = now?.swState?.langdao || 1;
					if (index == -1) {
						langdao[0].push(target);
						langdao[1].push(dnum);
					} else {
						langdao[1][index] += dnum;
					}
				}
			}
			game.log("#b系统", "开始结算", "#y伤害类事件");
			for (let i = 0; i < langdao[0].length; i++) {
				const now = langdao[0][i];
				// 用 loseHp 而非 damage：狼刀不触发受伤类技能，_reason 供觉孤判定继承阵营
				await now.loseHp(langdao[1][i]).set("_triggered", null).set("_reason", "lang");
				// 被狼刀是公开可见的，而狼不会刀自己队友 → 全场推定他是好人。
				// 这是 AI 唯一的破冰信息源：开局所有人 ai.shown 都是 0，没有这一笔态度会全场归零
				markGuessedGood(now);
			}
			// 结算女巫
			for (let i = 0; i < answer_result[0].length; i++) {
				const now = answer_result[0][i];
				const result = answer_result[1][i];
				if (!result?.bool) {
					continue;
				}
				if (now.getAbility() == "nvwu") {
					const target = result.targets[0];
					if (result.links == "revive") {
						if (!target.isDead()) {
							continue;
						}
						game.log(target, "因为", "#b女巫", "的", "#y神力", "复活了");
						await target.reviveEvent(3);
						await target.draw(3).set("_triggered", null).set("_reason", "nvwu");
						// 复活是全场可见的，女巫不会救狼 → 同狼刀，推定他是好人
						markGuessedGood(target);
					} else if (result.links == "kill") {
						if (!target.isIn()) {
							continue;
						}
						await target.loseHp(3).set("_triggered", null).set("_reason", "nvwu");
						// 毒杀不标记：掉体力的样子跟狼刀分不出来，而"女巫觉得他是狼"是女巫的私有判断，
						// 标出去就等于把女巫的想法广播给全场 AI
					}
					game.broadcastAll(player => {
						player.swState ??= {};
						player.swState.nvwu = true;
					}, now);
				}
			}
			// 结算预言家：查验结果只给预言家自己看 5 秒
			for (let i = 0; i < answer_result[0].length; i++) {
				const now = answer_result[0][i];
				const result = answer_result[1][i];
				if (!result?.bool) {
					continue;
				}
				if (now.getAbility() == "yvyanjia") {
					const target = result.targets[0];
					if (!target.isIn() || !now.isIn()) {
						continue;
					}
					const player = now;
					player.markAuto("sw_yvyanjiaInsight", [target]);
					event.videoId = lib.status.videoId++;
					const insightResult = get.insightResult(player, target);
					// 只记在预言家自己的 player.ai 上（不进 swState，swState 会被 syncState 广播给全场）。
					// 查出"狼"是铁证，查出"好人"只能算推定——隐狼的查验结果就是好人
					markInsight(player, target, insightResult);
					const send = (clientTarget, clientInsightResult, id) => {
						var classList = clientTarget.classList,
							nonStratagemInsightFlashing = classList.contains("flash-animation-iteration-count-infinite");
						if (nonStratagemInsightFlashing) {
							clientTarget.nonStratagemInsightFlashing = true;
						} else {
							classList.add("flash-animation-iteration-count-infinite");
						}
						var identity = get.translation(`${clientInsightResult}2`);
						var node;
						if (clientTarget.node.swPrompt) {
							node = clientTarget.node.swPrompt;
							node.innerHTML = "";
							node.className = "damage normal-font damageadded";
						} else {
							node = ui.create.div(".damage.normal-font", clientTarget);
							node.style.zIndex = 114515;
							clientTarget.node.swPrompt = node;
							ui.refresh(node);
							node.classList.add("damageadded");
						}
						node.innerHTML = identity;
						node.dataset.nature = clientInsightResult || "soil";
					};
					if (player == game.me) {
						send(target, insightResult, event.videoId);
					} else if (player.isOnline()) {
						player.send(send, target, insightResult, event.videoId);
					}
					const afterInsight = clientTarget => {
						if (clientTarget.node.swPrompt) {
							clientTarget.node.swPrompt.delete();
							delete clientTarget.node.swPrompt;
						}
						if (clientTarget.nonStratagemInsightFlashing) {
							delete clientTarget.nonStratagemInsightFlashing;
							return;
						}
						const classList = clientTarget.classList;
						if (classList.contains("flash-animation-iteration-count-infinite")) {
							classList.remove("flash-animation-iteration-count-infinite");
						}
					};
					setTimeout(() => {
						if (player == game.me) {
							afterInsight(target);
						} else if (player.isOnline()) {
							player.send(afterInsight, target);
						}
					}, 5000);
				}
			}
		},
	},
	// 死亡结算：先把狼刀伤害转移给存活狼队友，再让猎人/白狼开枪
	// 白天回合开始时的「跳身份」发言。只替 AI 托管的角色说 —— 真人自己会在公共聊天里说，
	// 不该被系统代言。
	//
	// 【为什么不上 LLM 也值得做】狼人杀的发言承载两类东西：
	//   ① 声明结构化事实（"我是预言家，昨晚验了X是狼"）—— 带槽位的模板就够，信息真实可验证
	//   ② 辩论/圆谎/读空气 —— 这个才需要语言能力，纯规则做不了，套模板只会露馅
	// ① 恰好是狼人杀里最关键的发言类型（跳预言家、报验人结果），做了就能让好人有可聚拢的
	// 信息源；而"谁真谁假"的判断交给人类玩家，AI 不需要会辩论。
	//
	// 发言同时写进 game.log（气泡 5 秒就没了，日志能回看）和 _status.swClaims
	// （公开声明的流水，将来要让 AI 之间互相采信/降权时从这里取，不必再造数据源）。
	// swClaims 里刻意不记"这条是不是假的"—— 那是主机独有的知识，留着会诱使后续代码作弊。
	_sw_talkSkill: {
		trigger: { player: "phaseBegin" },
		ruleSkill: true,
		charlotte: true,
		direct: true,
		nopop: true,
		popup: false,
		log: false,
		filter(event, player) {
			// 真人（本机的 game.me 或在线的）自己说，不代言；死人不说话
			if (player === game.me || player.isOnline() || !player.isAlive()) {
				return false;
			}
			const ability = player.getAbility();
			if (ability === "yvyanjia") {
				// 没有还没报过的新结果就不说话。已报条数记在 swState 上（一个计数，没有隐私）
				if (player.getStorage("sw_yvyanjiaInsight").length <= (player?.swState?._saidInsight || 0)) {
					return false;
				}
				// 已经起跳过了：之后天天报
				if (player?.swState?._saidInsight) {
					return true;
				}
				// 还没起跳。【为什么真预言家也要有晚跳】否则真预言家永远第一轮立刻跳，
				// "第一天最先开口的是真的"又成了铁律 —— 和狼那边的"后跳必假"是同一类漏洞，
				// 两边的时机逻辑必须都带随机才对称。骰子同样在 index.js 的 start 里掷。
				// 但有人抢跳了预言家就必须出来对冲，压着不说等于把话语权让给假的。
				if (Array.isArray(_status.swClaims) && _status.swClaims.some(one => one.player !== player)) {
					return true;
				}
				return game.roundNumber > (player.ai?.swSeerDelay || 0);
			}
			if (ability === "lang") {
				// 一局只有一头狼冒充：两头狼都跳预言家等于自曝
				if (_status.swFakeSeer && _status.swFakeSeer !== player) {
					return false;
				}
				// 【已经在冒充的那头要每天继续报】不然"跳了一次就再也不说话"本身就是破绽 ——
				// 真预言家每晚都有新结果、天天报，到第二天"还在持续报的那个"就必定是真的。
				// 这和"后跳必假"是同一类漏洞，只是从顺序换成了频率。
				if (_status.swFakeSeer === player) {
					return true;
				}
				// 开局被掷中「先手」的那头狼主动起跳，不等别人。
				// 【为什么要有先手】否则狼永远只能后跳，"后跳的一定是假的"就成了铁律，玩家一眼
				// 识破。骰子在 index.js 的 start 里掷（整局固定），不能放在 filter 里 ——
				// filter 会被调多次，随机值会让同一次触发前后不一致。
				if (player.ai?.swFakeSeerEarly) {
					return true;
				}
				// 没被掷中的：只在"已经有非队友跳过预言家"之后对冲，不然真预言家的话全场都信。
				// 用 isLang() 判队友是合法的 —— 狼阵营开局互亮身份，这是狼自己就有的知识。
				return Array.isArray(_status.swClaims) && _status.swClaims.some(one => one.player !== player && !one.player.isLang());
			}
			return false;
		},
		async content(event, trigger, player) {
			_status.swClaims ??= [];
			const ability = player.getAbility();
			let target;
			let kind;
			let first;
			if (ability === "yvyanjia") {
				const seen = player.getStorage("sw_yvyanjiaInsight");
				target = seen[seen.length - 1];
				if (!target) {
					return;
				}
				kind = get.insightResult(player, target) === "huai" ? "查杀" : "金水";
				first = !player?.swState?._saidInsight;
				player.swState ??= {};
				player.swState._saidInsight = seen.length;
			} else {
				// 狼冒充。两种打法轮着来，都是真牌局里的常规操作：
				//   · 查杀一个好人 —— 骗好人去针对他，正好是狼本来就想要的结果
				//   · 给队友发金水 —— 用假身份给队友洗白，比查杀更实用
				// 记在 player.ai 上（主机私有，不进 swState，后者会被 syncState 广播）
				player.ai.swFakeAccused ??= [];
				const mates = game.filterPlayer(one => one !== player && one.isLang() && !player.ai.swFakeAccused.includes(one));
				const others = game.filterPlayer(one => one !== player && !one.isLang() && !player.ai.swFakeAccused.includes(one));
				// 有队友可洗且掷中，就发金水；否则查杀。都没人可点就闭嘴
				if (mates.length && others.length && Math.random() < 0.35) {
					target = mates.randomGet();
					kind = "金水";
				} else if (others.length) {
					// 查杀挑威胁最大的（见 swThreat 的注释：不能用态度排，开局会同分）
					others.sort((x, y) => swThreat(y, player) - swThreat(x, player));
					target = others[0];
					kind = "查杀";
				} else if (mates.length) {
					target = mates.randomGet();
					kind = "金水";
				} else {
					return;
				}
				player.ai.swFakeAccused.push(target);
				first = !_status.swFakeSeer;
				_status.swFakeSeer = player;
			}
			const text = swTalkLine(kind, first, get.translation(target));
			// say 只在本地建气泡、不广播，故包一层 broadcastAll（单机下就是本地执行一次）
			game.broadcastAll(
				(one, str) => {
					one.say(str);
				},
				player,
				text
			);
			// 气泡 5 秒就没了，日志能回看
			game.log(player, first ? "起跳预言家，称" : "称", target, "是" + (kind === "查杀" ? "狼人" : "好人"));
			_status.swClaims.push({ player: player, target: target, kind: kind });
			await game.delay(1.5);
		},
	},

	_sw_dieSkill: {
		trigger: {
			player: ["dieAfter"],
		},
		ruleSkill: true,
		charlotte: true,
		forceDie: true,
		nopop: true,
		popup: false,
		log: false,
		async cost(event, trigger, player) {
			if (player?.swState?.langdao) {
				const target = game.filterPlayer(current => current.isLang() && current != player).randomGet();
				if (target) {
					target.swState ??= {};
					target.swState.langdao ??= 0;
					target.swState.langdao += player.swState.langdao;
					const str = "您的" + player.swState.langdao + "点狼刀伤害已经转移给了" + get.translation(target);
					const str2 = get.translation(player) + "的" + player.swState.langdao + "点狼刀伤害已经转移给了您";
					if (player == game.me) {
						game.createTip(str);
					} else if (player.isOnline()) {
						player.send(str => {
							game.createTip(str);
						}, str);
					}
					if (target == game.me) {
						game.createTip(str2);
					} else if (target.isOnline()) {
						target.send(str => {
							game.createTip(str);
						}, str2);
					}
				}
			}
			switch (player.identity) {
				case "lieren":
				case "bailang":
					event.result = await player
						.chooseTarget(get.prompt2("开枪"), lib.filter.notMe, "选择一名其他角色，对其造成" + player.maxHp + "点伤害")
						.set("ai", target => {
							const player = get.player();
							return -get.attitude(player, target);
						})
						.forResult();
					break;
				default:
					// 其他身份没有死亡技，走一个空询问保持各端节奏一致，再把 bool 抹掉不进 content
					event.result = await player.chooseBool(get.prompt2("空白"), "你没有能够在此时发动的技能，点哪个都一样~~~").forResult();
					event.result.bool = false;
					break;
			}
		},
		async content(event, trigger, player) {
			switch (player.identity) {
				case "lieren":
				case "bailang": {
					const target = event?.targets[0];
					game.log(player, "对", target, "发动了", "【开枪】");
					player.line(target);
					await target.damage(player, player.maxHp);
					break;
				}
				default:
					break;
			}
		},
	},
};
