# 数据清理规则 DSL 字段参考

## 总体结构

```json
{
  "qualifier":      { ... },   // 哪些资源参与（不匹配的跳过）
  "key_extractor":  { ... },   // 怎么从文件名算出"分组键"
  "score_rules":    [ ... ],   // 同组冲突时怎么打分
  "format_score":   { ... },   // 按扩展名加分
  "tie_breaker":    "id_desc", // 分相同时谁留下
  "format_filter":  { ... }    // 直接按扩展名删（独立于去重）
}
```

未填的字段都有默认值：`qualifier` 不填 = 全部参与，`key_extractor` 不填 = 整个文件名小写当 key，`score_rules` 不填 = 全 0 分，`format_filter.mode = "off"` = 不按格式删。

## qualifier — 谁参与去重

```json
"qualifier": { "name_must_match": "正则" }
```

只有 `file_name` 命中这个正则的资源才进入去重。常用：

- 小说：`(?:作者|著)\\s*[:：]?|[《》]|(完结|全集|全本|精校版?|校对版|番外|典藏版|修订版|未删减版)`
- 全部：留空 / 不填

## key_extractor — 算分组键

把"看起来一样的资源"算出同一个 `group_key`。所有字段都可选：

| 字段 | 类型 | 作用 |
|---|---|---|
| `lowercase` | bool | 转小写（默认 true） |
| `strip_ext` | bool | 剥扩展名（`.txt` `.zip` 等） |
| `strip_brackets` | bool | 剥【】[]()（）和《》 |
| `strip_author` | bool | 剥 `作者: xxx` / `著 xxx` |
| `strip_keywords` | string[] | 用正则把这些词从名字里剔掉 |
| `strip_separators` | bool | 剥空格、`-`、`·`、`:`、`_` 等 |
| `include_author_in_key` | bool | 把作者拼到 key 末尾（不同作者算不同组） |

## score_rules — 谁留下来

```json
"score_rules": [
  { "pattern": "精校版?|校对版", "score": 50 },
  { "pattern": "全本|全集|完结", "score": 40 },
  { "pattern": "番外", "score": -20 }
]
```

每条规则是一个正则，命中就加分。**所有命中的分都会累加。**

## format_score — 格式偏好

```json
"format_score": { "txt": 3, "epub": 2, "azw3": 1, "mobi": 1, "pdf": 0 }
```

按文件名后缀加分（不区分大小写）。

## tie_breaker — 平局规则

- `id_desc`（默认）：分相同时留 id 最大的（最近扫到的）
- `id_asc`：留 id 最小的（最早入库的）

## format_filter — 直接按扩展名清理

独立于去重的功能，可以单独用一条规则就跑。

```json
"format_filter": {
  "mode": "whitelist",
  "extensions": ["zip","rar","7z","pdf","epub","txt","mp4","mkv","apk","exe","iso"]
}
```

- `mode: "off"`：不启用
- `mode: "whitelist"`：**只**保留 `extensions` 里的扩展名，其余软删除
- `mode: "blacklist"`：**只**删除 `extensions` 里的扩展名

## 安全机制

- 单次运行最多删除"活跃资源 × 50%"，超过会自动 abort + 回滚
- 所有删除都是 `is_deleted=1` 软删除，写入 `cleanup_deleted` 关联表
- 后台 → 数据清理 → 运行历史 → 撤销 一键恢复
- 默认走"试运行"，不真删

## 工作流推荐

1. 扫盘完毕
2. 先跑"仅保留常见格式"（whitelist）
3. 再跑"小说去重"（按需）
4. 跨多个网盘的话，开"跨库去重"再跑一次
5. 任何阶段觉得删错了，去运行历史撤销

## 完整示例

小说库一键去重 + 格式过滤：

```json
{
  "qualifier": { "name_must_match": "(?:作者|著)|《|》|完结|全集|精校" },
  "key_extractor": {
    "lowercase": true, "strip_ext": true, "strip_brackets": true,
    "strip_author": true, "include_author_in_key": true,
    "strip_keywords": ["完结","全集","全本","精校版?","番外","插图版","文字版","epub","txt","mobi","azw3"],
    "strip_separators": true
  },
  "score_rules": [
    { "pattern": "精校版?|校对版", "score": 50 },
    { "pattern": "全本|全集|完结", "score": 40 },
    { "pattern": "番外", "score": -20 }
  ],
  "format_score": { "txt": 3, "epub": 2, "azw3": 1, "mobi": 1, "pdf": 0 },
  "tie_breaker": "id_desc",
  "format_filter": {
    "mode": "blacklist",
    "extensions": ["url","lnk","tmp","db"]
  }
}
```
