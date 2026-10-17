/**
 * 知识包（Skill）——可勾选挂载进提示词前缀的领域知识。
 *
 * 借鉴 Claude Code 的两层结构：
 *   BUILTIN_SKILLS —— 产品内置的领域知识，随版本走，不可删；
 *   用户自定义       —— 存在项目 settings 里（AgentContext.customSkills），随项目同步。
 *
 * 与「项目文档」的区别：文档是内容，知识包是**做事方法 / 约束**。
 */
import type { SkillDef } from './types';

export const BUILTIN_SKILLS: SkillDef[] = [
  {
    key: 'card-balance',
    name: '卡牌数值平衡',
    desc: '费用曲线、攻防换算、稀有度与数量的配比经验',
    builtin: true,
    defaultOn: true,
    body: `## 卡牌数值平衡

### 费用—强度换算（以常见的"费用 / 攻击 / 生命"三件套为例）
- 基准：费用 N 的随从，攻+防 ≈ 2N+2。例如 3 费 ≈ 4/4 或 5/3。
- 1 费牌应当有强力的**节奏价值**（如 2/1 冲锋），而非单纯身材。
- 生命比攻击更"贵"：+1 生命 ≈ +0.8 费，+1 攻击 ≈ +1 费（因为攻击能主动换牌）。
- 关键字折算：冲锋 ≈ +1 费，嘲讽 ≈ +0.5 费，抽一张牌 ≈ +1.5 费，直伤 1 点 ≈ +0.5 费。

### 稀有度与数量
- 普通：数量 3，效果直白；
- 稀有：数量 2，有一个额外关键字或小联动；
- 史诗：数量 1，效果复杂或需要配合；
- 传说：数量 1，通常有唯一性限制与改变局势的能力。

### 曲线检查
做完后用 card.list 把所有牌按费用分组统计，曲线应满足：
- 1-2 费占 30%~40%（保证开局有事做）；
- 3-4 费占 35%（中坚）；
- 5 费以上占 25% 以内（否则卡手）。

### 改数值时的顺序
先用 card.find 定位目标 → card.update 单条改 → 改完用 card.list 复核一遍，不要直接批量覆盖。`,
  },
  {
    key: 'print-pnp',
    name: 'PnP 打印排版规范',
    desc: '出血、裁切线、双面翻转与纸张尺寸的实操要点',
    builtin: true,
    body: `## PnP（Print and Play）打印排版规范

### 尺寸
- 扑克牌 63.5 × 88.9 mm（300 DPI 下 750 × 1050 px）
- 桥牌 57.2 × 88.9 mm；塔罗 69.9 × 120.7 mm；迷你美式 41.3 × 63.5 mm；欧式 59 × 92 mm
- A4 = 210 × 297 mm，Letter = 216 × 279 mm

### 出血与安全区
- 出血 3 mm（每边），即设计稿四周各留 3 mm 会被裁掉
- 关键文字/图标距边缘至少 5 mm，否则容易被裁到
- 圆角半径建议 2~4 mm，太大不利裁切

### 双面打印
- flipOnBack=true 表示背面沿短边翻转（长边翻转为 false），A4 纵向打印用 true
- duplex=true 时背面对齐误差会累积，边距留够 5 mm
- 共用牌背（useSharedBack）能显著减少页数

### 用本工具落地
project.setExport {dpi:300, bleedMm:3, duplex:true, flipOnBack:true, cutLines:true, pageSize:"A4"}`,
  },
  {
    key: 'layout-spec',
    name: '版式规格与三大机制',
    desc: '元素属性、字段绑定、显示条件、数量展开的完整写法',
    builtin: true,
    body: `## 版式（Layout）规格

### 顶层结构
{ id, name, width, height, widthMm, heightMm, backgroundColor, borderColor, borderWidth, borderRadius, backgroundAssetId?, elements[] }

### 元素共有属性
id / kind / name / x / y / width / height / rotation / fill / color /
borderColor / borderWidth / borderStyle(solid|dashed|dotted) / borderRadius /
fillOpacity / textOpacity / borderOpacity / locked / hidden

kind 取值：text | image | icon | rectangle | ellipse | line

### 文本元素专有
fieldId（绑定字段）或 text（固定文案）、fontFamily / fontWeight / fontStyle /
fontSize / maxFontSize / minFontSize / autoFit / lineHeight / letterSpacing /
wrapMode(none|word|anywhere|keepWord) / horizontalAlign / verticalAlign

### 机制一：字段绑定
元素写 fieldId 即为绑定，渲染时替换成当前卡牌的字段值。
文本模板也支持 {字段id}，例如 fill 写 "{titleBackgroundColor}" 会按卡牌取值。

### 机制二：显示条件
displayCondition 可以是单条比较，也可以是嵌套条件组：
{ type:"comparison", fieldId:"type", operator:"equals", value:"随从" }
{ type:"group", operator:"all"|"any", conditions:[ ...上面这种，或再嵌一层 group ] }
运算符：equals / notEquals / gt / gte / lt / lte / contains / isEmpty / isNotEmpty

### 机制三：数量展开
countFieldId + countMax + countSpacing + countDirection(horizontal|vertical)
——按某字段的数值把同一元素重复绘制 N 份，常用于"这张牌放 3 张"的视觉表达。

### 编辑建议
改单个属性用 element.update {patch:{...}}，一次只改必要的键；
大改不如先 element.list 看清现有元素，再决定改还是删了重建。`,
  },
  {
    key: 'icon-usage',
    name: '图标用法（game-icons）',
    desc: '内置 4239 枚图标的检索与着色规范，禁止编造 id',
    builtin: true,
    body: `## game-icons 图标用法

- 内置 4239 枚 SVG 图标（CC BY 3.0），在「图标库」页按名称/作者搜索。
- **严禁编造 icon id**。要用图标必须先让用户在图标库里选，或从素材库取已加入的图标。
- 图标是单色 SVG，通过元素的 color 属性着色；着深色背景上用浅色，反之亦然。
- 典型尺寸：功能图标 48~96 px（300 DPI 下），装饰性大图标可到 200 px。
- 图标元素 kind="icon"，用 iconId 指定；若想跟随卡牌字段变化，用 fieldId 绑一个 select 字段，
  并把每个选项的图标配在字段的 optionIcons 上。
- 需要彩色插图时用 kind="image" + assetId 指向素材库里的图片，而不是图标。`,
  },
  {
    key: 'export-guide',
    name: '导出与交付',
    desc: 'PNG / PDF / 表格 / 打印页各自适合什么场景',
    builtin: true,
    body: `## 导出与交付

| 渠道 | 用途 |
| --- | --- |
| PNG（单张/整副） | 导入 Tabletop Simulator、做电子版预览 |
| PDF（A4 / Letter） | 发给玩家自己打印，最常用 |
| 打印页（浏览器） | 直接连打印机，省一步 |
| CSV / XLSX | 把卡牌数据交给别人改，或用 Excel 批量编辑 |
| JSON | 完整备份 / 迁移到另一个 CardArts 实例 |

### 参数建议
- 屏幕预览：dpi 150~200 足够；打印必须 300
- 出血：自己打印 0 mm，送去印厂 3 mm
- 双面：牌背图案不对称时 flipOnBack 要试打一张确认方向

### 交给别人继续改
导出 XLSX → 对方改完 → 用「文档」页上传回来（或直接导入卡牌），
比让人在网页里一张张点快得多。`,
  },
  {
    key: 'agent-etiquette',
    name: '助手工作守则',
    desc: '先读后写、小步验证、不臆造——默认开启',
    builtin: true,
    defaultOn: true,
    body: `## 助手工作守则

1. **先读后写**：任何改动前先 project.overview 或对应的 list / find，确认目标存在。
2. **小步验证**：批量改之前先拿一条试，确认参数对了再铺开；改完再读一遍复核。
3. **不臆造**：id、图标 id、字段选项都必须是读到的真实值，猜的一律先查。
4. **破坏性操作留余地**：删牌组 / 清空版式 / 删字段之前，先告诉用户会影响多少条数据。
5. **说人话**：回复用中文，结论先行，不要复述工具返回的原始 JSON。
6. **不确定就问**：需求有歧义时先用一句话确认，不要自作主张改一大片。`,
  },
];

export function builtinSkill(key: string): SkillDef | undefined {
  return BUILTIN_SKILLS.find((s) => s.key === key);
}

export function allSkills(custom: SkillDef[] = []): SkillDef[] {
  // 自定义包允许覆盖同名内置包（用 key 去重，自定义优先）
  const map = new Map<string, SkillDef>();
  for (const s of BUILTIN_SKILLS) map.set(s.key, s);
  for (const s of custom) map.set(s.key, { ...s, builtin: false });
  return [...map.values()];
}

export function defaultSkillKeys(): string[] {
  return BUILTIN_SKILLS.filter((s) => s.defaultOn).map((s) => s.key);
}
