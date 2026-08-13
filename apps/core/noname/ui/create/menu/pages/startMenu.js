import { menuContainer, popupContainer, updateActive, setUpdateActive, updateActiveCard, setUpdateActiveCard, menux, menuxpages, menuUpdates, openMenu, clickToggle, clickSwitcher, clickContainer, clickMenuItem, createMenu, createConfig } from "../index.js";
import { ui, game, get, ai, lib, _status } from "noname";

export const startMenu = function (connectMenu) {
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

	/** 启动按钮 */
	let startButton = ui.create.div(".menubutton.round.highlight", "启", start, function () {
		if (this.animating || this.classList.contains("dim")) {
			return;
		}
		var active = this.parentNode.querySelector(".active");
		if (active) {
			if (connectMenu) {
				if (_status.waitingForPlayer) {
					var config = {};
					for (var i in lib.mode[lib.configOL.mode].connect) {
						if (i == "update") {
							continue;
						}
						config[i.slice(8)] = get.config(i, lib.configOL.mode);
					}
					config.zhinang_tricks = lib.config.connect_zhinang_tricks;
					if (game.online) {
						if (game.onlinezhu) {
							game.send("changeRoomConfig", config);
						}
					} else {
						game.broadcastAll(function (config) {
							for (var i in config) {
								lib.configOL[i] = config[i];
							}
						}, config);
						if (lib.configOL.mode == "identity" && lib.configOL.identity_mode == "zhong" && game.connectPlayers) {
							for (var i = 0; i < game.connectPlayers.length; i++) {
								game.connectPlayers[i].classList.remove("unselectable2");
							}
							lib.configOL.number = 8;
							game.updateWaiting();
						}
						if (game.onlineroom) {
							game.send("server", "config", lib.configOL);
						}
						game.connectPlayers[0].chat("房间设置已更改");
					}
				} else if (_status.enteringroom || _status.creatingroom) {
					lib.configOL.mode = active.mode;
					if (_status.enteringroomserver) {
						game.saveConfig("connect_mode", lib.configOL.mode);

						var config = {};
						for (var i in lib.mode[lib.configOL.mode].connect) {
							if (i == "update") {
								continue;
							}
							config[i.slice(8)] = get.config(i, lib.configOL.mode);
						}
						config.zhinang_tricks = lib.config.connect_zhinang_tricks;

						config.characterPack = lib.connectCharacterPack.slice(0);
						config.cardPack = lib.connectCardPack.slice(0);
						for (var i = 0; i < lib.config.connect_characters.length; i++) {
							config.characterPack.remove(lib.config.connect_characters[i]);
						}
						for (var i = 0; i < lib.config.connect_cards.length; i++) {
							config.cardPack.remove(lib.config.connect_cards[i]);
						}
						config.banned = lib.config["connect_" + active.mode + "_banned"];
						config.bannedcards = lib.config["connect_" + active.mode + "_bannedcards"];
						game.send("server", "create", game.onlineKey, get.connectNickname(), lib.config.connect_avatar, config, active.mode);
					} else {
						game.send("server", "create", game.onlineKey, get.connectNickname(), lib.config.connect_avatar);
					}
				} else {
					// directstart 只是"下次启动直接进这个模式"的快捷标记，写不进去无所谓；
					// 但 iOS standalone PWA 里 localStorage 会在运行期变成 null，抛出来会把整个
					// 「启」按钮打断（点了没反应或弹报错）。详见 game.reload() 里的同类注释。
					try {
						localStorage.setItem(lib.configprefix + "directstart", true);
					} catch (e) {
						console.warn("startMenu: 存储不可用，跳过 directstart 标记", e);
					}
					game.saveConfig("directstartmode", active.mode);
					game.saveConfig("mode", "connect");
					ui.exitroom = ui.create.system(
						"退出房间",
						function () {
							game.saveConfig("directstartmode");
							game.reload();
						},
						true
					);
					game.switchMode(active.mode);
					game.requireSandboxOn();
				}
				clickContainer.call(cacheMenuContainer, connectMenu);
			} else {
				game.saveConfig("mode", active.mode);
				// 同上：标记写不进去也要保证 game.reload() 一定执行，否则单机的「启」点了没反应
				try {
					localStorage.setItem(lib.configprefix + "directstart", true);
				} catch (e) {
					console.warn("startMenu: 存储不可用，跳过 directstart 标记", e);
				}
				game.reload();
			}
		}
	});

	var clickMode = function () {
		if (this.classList.contains("unselectable")) {
			return;
		}
		var active = this.parentNode.querySelector(".active");
		if (active === this) {
			return;
		}
		active.classList.remove("active");
		active.link.remove();
		active = this;
		this.classList.add("active");
		if (this.link) {
			rightPane.appendChild(this.link);
		} else {
			this._initLink();
			rightPane.appendChild(this.link);
		}
		if (connectMenu) {
			if (updateActive) {
				updateActive();
			}
			if (updateActiveCard) {
				updateActiveCard();
			}
		}
	};

	var createModeConfig = function (mode, position) {
		var info = lib.mode[mode];
		var page = ui.create.div("");
		var node = ui.create.div(".menubutton.large", info.name, position, clickMode);
		node.mode = mode;
		// 声明了 onlineOnly 的模式在单机列表里标一下，免得点进去才发现开不起来。
		// 仍允许点选——右侧栏会展示"为什么"和玩法说明。
		// （目前没有模式用它：狼人杀曾经是唯一一个，单机补齐后已摘掉标记。机制留着备用。）
		// 【不复用现成的 .disabled】那个类在 menu/index.js:40/55/161 被当成"拦截点击"的判据，
		// 加上去会连带禁掉点选。这里只要视觉暗示，故用自己的类名（样式见 layout.css）。
		if (!connectMenu && info.onlineOnly) {
			node.classList.add("onlineonly");
			node.innerHTML = `${info.name}<span class="onlineonlytag">仅联机</span>`;
		}
		var connectDisplayMap = {
			connect_player_number: null,
			connect_versus_mode: null,
		};
		var updateConnectDisplayMap = function () {
			if (_status.waitingForPlayer) {
				if (connectDisplayMap.connect_player_number) {
					connectDisplayMap.connect_player_number.style.display = "none";
				}
				if (connectDisplayMap.connect_versus_mode) {
					connectDisplayMap.connect_versus_mode.style.display = "none";
				}
			}
		};
		if (connectMenu) {
			menuUpdates.push(updateConnectDisplayMap);
			if (mode == lib.config.connect_mode) {
				node.classList.add("active");
			}
		} else {
			if (mode == lib.config.mode) {
				node.classList.add("active");
			}
		}
		node._initLink = function () {
			node.link = page;
			//“更多”下的内容
			var map = {};
			var infoconfig = connectMenu ? info.connect : info.config;
			if (infoconfig) {
				var hiddenNodes = [];
				var config = lib.config.mode_config[mode] || {};
				if (connectMenu) {
					infoconfig.connect_choose_timeout = {
						name: "出牌时限",
						init: "30",
						item: {
							10: "10秒",
							15: "15秒",
							30: "30秒",
							60: "60秒",
							90: "90秒",
						},
						connect: true,
						frequent: true,
					};
					infoconfig.connect_observe = {
						name: "允许旁观",
						init: true,
						connect: true,
					};
					infoconfig.connect_observe_handcard = {
						name: "允许观看手牌",
						init: false,
						connect: true,
					};
					infoconfig.connect_mount_combine = {
						name: "合并坐骑栏",
						init: false,
						connect: true,
					};
				}
				for (var j in infoconfig) {
					if (j === "update") {
						continue;
					}
					// 【非配置对象一律跳过】config 里理应每项都是 {name,init,...}，但写错成裸值
					// (如 dierestart: false)时，下面 cfg._name = j 会对布尔赋属性直接抛 TypeError，
					// 把整条启动链打断 → 撞 30s 看门狗弹「游戏似乎未正常载入」。一个模式的配置笔误
					// 不该让整个游戏起不来，故在这儿兜住。(狼人杀 config 曾踩过，见 library/index.js)
					if (!infoconfig[j] || typeof infoconfig[j] !== "object") {
						continue;
					}
					var cfg = get.copy(infoconfig[j]);
					cfg._name = j;
					cfg.mode = mode;
					if (j in config) {
						cfg.init = config[j];
					} else {
						game.saveConfig(j, cfg.init, mode);
					}
					if (!cfg.onclick) {
						cfg.onclick = function (result) {
							var cfg = this._link.config;
							game.saveConfig(cfg._name, result, mode);
							if (cfg.onsave) {
								cfg.onsave.call(this, result);
							}
							if (!_status.connectMode || game.online) {
								if (typeof cfg.restart == "function") {
									if (cfg.restart()) {
										startButton.classList.add("glowing");
									}
								} else if (cfg.restart) {
									startButton.classList.add("glowing");
								}
							}
						};
					}
					if (infoconfig.update) {
						cfg.update = function () {
							infoconfig.update(config, map);
						};
					}
					var cfgnode = createConfig(cfg);
					map[j] = cfgnode;
					if (cfg.frequent) {
						page.appendChild(cfgnode);
					} else {
						cfgnode.classList.add("auto-hide");
						hiddenNodes.push(cfgnode);
					}
				}
				if (!connectMenu) {
					var move = ui.create.div(".auto-hide.config", '<div style="margin-right:10px" class="pointerdiv">上移↑</div><div class="pointerdiv">下移↓</div>');
					move.firstChild.listen(function () {
						if (node.previousSibling) {
							node.parentNode.insertBefore(node, node.previousSibling);
							var order = [];
							for (var i = 0; i < node.parentNode.childNodes.length; i++) {
								order.push(node.parentNode.childNodes[i].mode);
							}
							game.saveConfig("modeorder", order);
						}
					});
					move.lastChild.listen(function () {
						if (node.nextSibling) {
							if (node.nextSibling.nextSibling) {
								node.parentNode.insertBefore(node, node.nextSibling.nextSibling);
							} else {
								node.parentNode.insertBefore(node.nextSibling, node);
							}
							var order = [];
							for (var i = 0; i < node.parentNode.childNodes.length; i++) {
								order.push(node.parentNode.childNodes[i].mode);
							}
							game.saveConfig("modeorder", order);
						}
					});
					hiddenNodes.push(move);
				}
				var expanded = false;
				var hasexpand = true;
				if (hiddenNodes.length) {
					if (lib.config.fold_mode) {
						var clickmore = function (type) {
							if (type === "expand" && expanded) {
								return;
							}
							if (type === "unexpand" && !expanded) {
								return;
							}
							if (expanded) {
								this.classList.remove("on");
								this.parentNode.classList.remove("expanded");
							} else {
								this.classList.add("on");
								this.parentNode.classList.add("expanded");
							}
							expanded = !expanded;
						};
						var morenodes = ui.create.div(".config.more", "更多 <div>&gt;</div>", page);
						morenodes.listen(clickmore);
						morenodes._onclick = clickmore;
						page.morenodes = morenodes;
					} else {
						page.classList.add("expanded");
						if (!connectMenu) {
							page.classList.add("expanded2");
						}
					}
					for (var k = 0; k < hiddenNodes.length; k++) {
						page.appendChild(hiddenNodes[k]);
					}
				} else {
					hasexpand = false;
				}
				if (!connectMenu) {
					var hidemode = ui.create.div(".config.pointerspan", "<span>隐藏此模式</span>", page, function () {
						if (this.firstChild.innerHTML == "隐藏此模式") {
							this.firstChild.innerHTML = "此模式将在重启后隐藏";
							lib.config.hiddenModePack.add(mode);
							if (!lib.config.prompt_hidepack) {
								alert("隐藏的扩展包可通过选项-其它-重置隐藏内容恢复");
								game.saveConfig("prompt_hidepack", true);
							}
						} else {
							this.firstChild.innerHTML = "隐藏此模式";
							lib.config.hiddenModePack.remove(mode);
						}
						game.saveConfig("hiddenModePack", lib.config.hiddenModePack);
					});
					if (hasexpand) {
						hidemode.classList.add("auto-hide");
					}
				}
				if (infoconfig.update) {
					infoconfig.update(config, map);
					node.update = function () {
						infoconfig.update(config, map);
					};
				}
			}
			if (connectMenu) {
				connectDisplayMap.connect_player_number = map.connect_player_number;
				connectDisplayMap.connect_versus_mode = map.connect_versus_mode;
				updateConnectDisplayMap();
			}
		};
		if (!get.config("menu_loadondemand")) {
			node._initLink();
		}
		return node;
	};
	var modeorder = lib.config.modeorder || [];
	for (var i in lib.mode) {
		modeorder.add(i);
	}
	for (var i = 0; i < modeorder.length; i++) {
		if (connectMenu) {
			if (!lib.mode[modeorder[i]].connect) {
				continue;
			}
			if (!lib.config["connect_" + modeorder[i] + "_banned"]) {
				lib.config["connect_" + modeorder[i] + "_banned"] = [];
			}
			if (!lib.config["connect_" + modeorder[i] + "_bannedcards"]) {
				lib.config["connect_" + modeorder[i] + "_bannedcards"] = [];
			}
		}
		if (lib.config.all.mode.includes(modeorder[i])) {
			createModeConfig(modeorder[i], start.firstChild);
		}
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
	if (lib.config.fold_mode) {
		rightPane.addEventListener(
			"mousewheel",
			function (e) {
				var morenodes = this.firstChild.morenodes;
				if (morenodes) {
					if (e.wheelDelta < 0) {
						morenodes._onclick.call(morenodes, "expand");
					} else if (this.scrollTop == 0) {
						morenodes._onclick.call(morenodes, "unexpand");
					}
				}
			},
			{ passive: true }
		);
	}

	return startButton;
};
