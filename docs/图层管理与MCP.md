# 图层管理与 MCP

版式编辑器左侧图层面板支持搜索名称或 ID、Shift 多选、Alt 选择组内单层、双击名称重命名，以及置顶/置底/上移/下移。拖动图层到目标行会放到目标上方；画布与导出均使用同一元素顺序，列表上方覆盖下方。

组标题可选择整组、折叠组、切换整组显隐或锁定。工具栏支持批量显示、隐藏、锁定、解锁、组合与解组。锁定图层仍可从面板选择以解锁，但不允许直接重命名、排序或改组。当前为单级逻辑组，不支持嵌套组或独立组变换。所有面板操作沿用项目撤销/重做。

## 应用内 Agent

先用 `layer.list {deck,side}` 获取真实图层 ID，再调用：

```json
{"tool":"layer.manage","args":{"deck":"真实牌组ID","side":"front","operation":"front","ids":["真实标题图层ID"]}}
```

operation 支持 `front`、`back`、`up`、`down`、`above`、`below`、`order`、`rename`、`show`、`hide`、`lock`、`unlock`、`group`、`ungroup`。

默认 expandGroups=true，操作同组全部成员；单层操作可设 false。rename 固定要求单层和非空 name。above/below 需 target；order 需完整、不重复的全部图层 ID 数组，顺序为底层到顶层。以上均保持原有 ID、几何、字段绑定与单卡覆盖。

## 外部 MCP

重启 MCP 服务后可使用：

1. `list_layers(project_id, deck_id, side="front")`：返回 revision 和顶层到底层的图层列表。
2. `manage_layers(project_id, deck_id, side, operation, ids, target?, name?, order?, expand_groups=true, expected_revision?)`：执行图层操作。

建议将 list_layers 返回的 revision 传入 expected_revision；若版本变化，工具会拒绝写入，需重新查询。必须传真实 ID，front/back 指操作面时放在 side，指置顶/置底时放在 operation。

示例（使用实际查询结果替换 ID 与 revision）：

```json
{
  "project_id":"项目ID",
  "deck_id":"牌组ID",
  "side":"front",
  "operation":"above",
  "ids":["标题图层ID"],
  "target":"插图图层ID",
  "expected_revision":12
}
```

外部 MCP 修改后需在前端同步获取结果；本工具的锁定护栏不限制其他通用版式编辑工具。

## 验证

前端版式测试 18 项、Agent 回归检查与构建通过；后端图层测试 4 项通过，含 MCP 工具注册、版本校验和正背面隔离。独立浏览器验证排序/撤销、组合/折叠、批量显隐/锁定、重命名与内置 Agent 调用通过。
