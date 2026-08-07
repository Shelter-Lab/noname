# 武将立绘补齐说明

上游 [libnoname/noname](https://github.com/libnoname/noname) 有一批武将**没有自己的立绘文件**，
游戏里会显示成性别剪影。本 fork 把它们全部补齐，2494 个武将条目现已**零剪影**。

这份文档记录：怎么发现的、补的什么、以及**以后新武将缺图时怎么快速定位和补**。

---

## 剪影是怎么来的

不是 bug，是上游的兜底设计。[polyfill.ts](../apps/core/noname/init/polyfill.ts) 里：

```js
this.setBackgroundImage([src, `${lib.characterDefaultPicturePath}${sex}${ext}`]);
```

给 `background-image` 塞了**两个 url**，第二个是 `image/character/default_silhouette_{male|female|double}.jpg`。
CSS 多背景语法下，第一个 404 就自动显示第二个 —— 所以缺图不会崩，只会变剪影。

**立绘的文件名 = 武将 id**（`image/character/<id>.jpg`），除非定义里写了 `img:` 覆盖。

---

## 补齐的三种手段

### 一、从上游下载真图（4 个）

我们 fork 的基点是 2026-08-04 的 `76e707a`，上游 08-06 的 PR #4170「素材补充」补了几张原画，
我们只是**晚了两天**。直接下载：

| 武将 | id | 上游来源 |
|---|---|---|
| 手杀崔琰毛玠 | `mb_cuimao` | PR #4170 |
| 手杀界严颜 | `re_yanyan` | PR #4170 |
| 雁翎徐晃 | `ylyg_xuhuang` | PR #4170 |
| 雁翎祝融 | `ylyg_zhurong` | PR #4170 |

以后同步上游时这类会自动带进来。

### 二、`img:` 引用同一人物的其它版本立绘（35 个）

三国杀一个历史人物常有多个版本（标准/界/手杀/OL/谋/势……），新版本没画新图时，
**引用同一人物旧版的图**。这是**上游自己的做法**，不是我们的发明 —— 例如上游的 `ol_jsrg_lvbu`
就写着 `img: "image/character/jsrg_lvbu.jpg"`。

写法（插在武将定义里）：

```js
pot_caoshuang: {
	sex: "male",
	group: "wei",
	hp: 4,
	skills: ["potdianyi", "potshequan", "potjianzhuan"],
	// 无自有立绘,复用同一人物的本体立绘(上游未提供 pot_caoshuang 的图)
	img: "image/character/caoshuang.jpg",
},
```

**完整映射表**（按武将包排序）：

| 武将 | id | 引用的立绘 | 该图原属 | 武将包 |
|---|---|---|---|---|
| 势曹爽 | `pot_caoshuang` | `caoshuang.jpg` | 曹爽 | bingshi |
| 势陈矫 | `pot_chenjiao` | `chenjiao.jpg` | 陈矫 | bingshi |
| 势陈群 | `pot_chenqun` | `chenqun.jpg` | 陈群 | bingshi |
| 势夏侯霸 | `pot_xiahouba` | `xiahouba.jpg` | 夏侯霸 | bingshi |
| 势张任 | `pot_zhangren` | `zhangren.jpg` | 张任 | bingshi |
| 族吴懿 | `clan_wuyi` | `wuyi.jpg` | 吴懿 | clan |
| 新杀费祎 | `dc_feiyi` | `feiyi.jpg` | 手杀费祎 | huicui |
| 新杀木鹿大王 | `dc_muludawang` | `muludawang.jpg` | 木鹿大王 | huicui |
| 手杀丁尚涴 | `mb_dingshangwan` | `dingshangwan.jpg` | 丁尚涴 | mobile |
| 手杀高翔 | `mb_gaoxiang` | `gaoxiang.jpg` | 高翔 | mobile |
| 手杀夏侯楙 | `mb_xiahoumao` | `xiahoumao.jpg` | 夏侯楙 | mobile |
| 手杀界王基 | `re_wangji` | `wangji.jpg` | 王基 | mobile |
| 爻袁术 | `yao_yuanshu` | `yuanshu.jpg` | SP袁术 | newjiang |
| OL界步练师 | `ol_bulianshi` | `bulianshi.jpg` | 步练师 | onlyOL |
| OL界曹休 | `ol_caoxiu` | `caoxiu.jpg` | 曹休 | onlyOL |
| OL界刘封 | `ol_liufeng` | `liufeng.jpg` | 刘封 | onlyOL |
| OL界全琮 | `ol_quancong` | `quancong.jpg` | 全琮 | onlyOL |
| OL谋沮授 | `ol_sb_jushou` | `dc_sb_jushou.jpg` | 新杀谋沮授 | onlyOL |
| OL谋张飞 | `ol_sb_zhangfei` | `zhangfei.jpg` | 张飞 | onlyOL |
| OL谋赵云 | `ol_sb_zhaoyun` | `zhaoyun.jpg` | 赵云 | onlyOL |
| OL界孙休 | `ol_sunxiu` | `sunxiu.jpg` | 孙休 | onlyOL |
| 界司马朗 | `re_simalang` | `simalang.jpg` | 司马朗 | refresh |
| 界张梁 | `xin_zhangliang` | `zhangliang.jpg` | SP张梁 | refresh |
| 谋陈泰 | `sb_chentai` | `chentai.jpg` | 陈泰 | sb |
| OL蔡贞姬 | `ol_caizhenji` | `caizhenji.jpg` | 蔡贞姬 | sp |
| OL樊氏 | `ol_fanyufeng` | `fanyufeng.jpg` | 樊玉凤 | sp |
| 张既 | `ol_tw_zhangji` | `mb_tw_zhangji.jpg` | 手杀张既 | sp |
| 新杀陈祗 | `dc_chenzhi` | `mb_chenzhi.jpg` | 势陈祗 | xianding |
| 新杀谋马谡 | `dc_sb_masu` | `masu.jpg` | 旧马谡 | xianding |
| 新杀谋王平 | `dc_sb_wangping` | `wangping.jpg` | 王平 | xianding |
| 新杀谋杨奉 | `dc_sb_yangfeng` | `yangfeng.jpg` | 杨奉 | xianding |
| 新杀谋诸葛亮 | `dc_sb_zhugeliang` | `zhugeliang.jpg` | 诸葛亮 | xianding |
| 王越 | `dc_xia_wangyue` | `ns_wangyue.jpg` | 王越 | xianding |
| 威关银屏 | `v_guanyinping` | `guanyinping.jpg` | 关银屏 | xianding |
| 武陆抗 | `wu_lukang` | `lukang.jpg` | 陆抗 | xianding |

### 三、外部找图 + 转码补入（6 个）

这 6 个全服**没有任何同人物立绘**可复用（本体版本压根不存在，上游也 404），只能外部找图：

| 武将 | id | 说明 |
|---|---|---|
| 势吕壹 | `pot_lvyi` | 「势」系列首发角色，无标准版 |
| 韩玄 | `hanxuan` | 长沙太守，黄忠旧主 |
| 逢纪 | `pangji` | 袁绍谋士 |
| 傅干 | `fugan` | 傅燮之子，曹操幕僚；称号「察策明谏」，**游戏内无生平介绍** |
| 张臶 | `zhangjian` | 隐士，`hp: 105`（就是他活的岁数）；技能名占位叫「技能A/B」，称号取自社区 DIY 作品 —— 未完工的彩蛋角色 |
| 环怀瑾 | `dc_huanhuaijin` | 新杀原创角色，非史实 |

---

## 上游主动下架的武将（不用管）

`key_umi2`（鹰原羽未）、`key_crow`（小空）—— Key 社联动角色，**带 `isUnseen: true`**。

`isUnseen` 不是"藏图"，是**整个武将从游戏里下架**，5 个作用点：

| 位置 | 效果 |
|---|---|
| [characterPackMenu.js:157](../apps/core/noname/ui/create/menu/pages/characterPackMenu.js#L157) | 武将包菜单里 `continue`，列表不出现 |
| [library/index.js:11195](../apps/core/noname/library/index.js#L11195) | `characterDisabled()` 返回 true |
| [library/index.js:11244](../apps/core/noname/library/index.js#L11244) | AI 也不选 |
| [get/index.js:4370](../apps/core/noname/get/index.js#L4370) / [:4417](../apps/core/noname/get/index.js#L4417) | 选将池遍历跳过，抽不到 |

这两个一个连 `skills` 字段都没有、一个是 `skills: []`，是上游的未实装占位。
**选将界面根本不出现，所以不需要图**，审计脚本也应排除它们。

> ⚠️ **别拿 `isUnseen` 当"消除剪影"的手段** —— 那等于把武将删了，技能也玩不到。

---

## 复查脚本（新武将缺图时用这个）

同步上游后跑一次，能列出所有缺图武将、并自动判断"有没有同人物的图可复用"：

```bash
node scripts/audit-character-images.cjs
```

输出分两类：**可再修**（有同人物立绘，加个 `img:` 就行）和**真无**（只能外部找图或等上游）。

### 写这个脚本时踩的坑（别重蹈）

1. **不能只按 id 剥前缀匹配** —— 前缀表永远列不全（我漏了 `ol_`，导致 `ol_caoxiu` 被误判成"无候选"，
   而 `caoxiu.jpg` 一直好好躺在那儿）。脚本改用**通用剥法** `/^[a-z0-9]{1,6}_(.+)$/` 循环剥，不维护前缀表。
2. **也不能只按中文名匹配** —— 同一人物可能改名：`ol_fanyufeng` 译名是「OL**樊氏**」，
   本体是「樊**玉凤**」，去掉「OL」后对不上。（它自己的 `names: "樊|玉凤"` 字段才是真相）
3. **`new RegExp("[^]")` 在 Node 里不合法** —— `[^]` 只在 JS 正则**字面量**里有效，
   用字符串构造会静默匹配 0 次。我因此得到过一次"0 缺失"的假结果并信了。
   脚本现在改用**手工按行切分条目**，不用跨行正则。
4. **判断 `img:` 字段前要先去注释** —— 否则我们插入的中文注释里的 "img" 字样会造成误判。
5. **同音不同人是真陷阱**，必须核对中文名：
   - `ol_tw_zhangji` 是**张既** → `mb_tw_zhangji.jpg`，不是 `zhangji.jpg`（那是**张济**）
   - `dc_xia_wangyue` 是**王越** → `ns_wangyue.jpg`，不是 `wangyue.jpg`（那是**王悦**）

---

## 补图规格（外部找图时照这个来）

**350×464 px JPEG，宽高比 0.754。** 全库 2605 张里 2533 张是这个尺寸（97.2%），是事实标准。

| 项 | 要求 | 原因 |
|---|---|---|
| **宽高比 ≈ 0.754** | 最关键 | 显示用 `background-size: cover`，比例不对会裁掉大半 |
| 尺寸 350×464 | 大一点行，别更小 | 小图被放大会明显发虚 |
| **构图：人物头肩在上部** | 重要 | `backgroundPositionX: center` 但**没设 positionY**，默认顶部对齐 → **裁脚不裁头** |
| 格式 JPEG 或 PNG | 扩展名一律 `.jpg` | 库里有 143 张内容是 PNG 却叫 `.jpg`，浏览器按内容嗅探，照常显示 |
| 体积 < 250KB | 建议 | 中位 141KB、p90 237KB；这些图会进离线缓存（约 1.2GB） |

转码脚本（Pillow，实现 `cover` 语义 + 纵向偏上裁切）：

```bash
python scripts/fit-character-image.py <输入图> <输出id>
```

搜索词建议用「**三国杀 <中文名> 立绘**」，直接搜人名会出一堆剧照和历史插画，画风尺寸都不搭。

---

## 影响面

- `dist` 文件数 15356 → **15366**（+10 张新图；CF Workers Static Assets 免费版上限 20000）
- 离线缓存清单 14284 → **14294**
- 35 个 `img:` 引用**不增加任何文件**（复用已有图）
- 引擎代码零改动，只改 `character/*/character.js` 的数据定义

## 同步上游时的注意

我们在 10 个 `character/*/character.js` 里插了 `img:` 字段。上游若也动了这些文件可能冲突。
判断方法：搜注释 `无自有立绘,复用同一人物的本体立绘` 就能找到全部 35 处。
**冲突时优先保留上游的真图** —— 上游哪天补了 `pot_caoshuang.jpg`，就该删掉我们的 `img:` 行，
因为同名文件优先级更高但留着引用只会造成误解。跑一次复查脚本即可确认。
