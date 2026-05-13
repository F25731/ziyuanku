# API 调用示例

这个目录放下游对接的代码示例，方便你和合作方复制即用。

## test_api.py — Python 交互测试

最完整的一个，能直接验证你的资源库部署是否正常。

### 安装依赖

```bash
pip install requests
```

### 配置

**方式 A**：编辑文件顶部
```python
HOST = "https://ku.hstudy.xyz"
API_KEY = "lhk_xxxxxxxx"
```

**方式 B**：环境变量（推荐，避免误推到 Git）

PowerShell：
```powershell
$env:LRH_HOST = "https://ku.hstudy.xyz"
$env:LRH_API_KEY = "lhk_xxxxxxxx"
python test_api.py
```

Linux / macOS / WSL：
```bash
export LRH_HOST=https://ku.hstudy.xyz
export LRH_API_KEY=lhk_xxxxxxxx
python3 test_api.py
```

### 用法

**交互菜单（直接跑，逐项测）：**
```bash
python test_api.py
```

**命令行模式（写脚本时用）：**
```bash
python test_api.py me                # 查看 Key 配额
python test_api.py search python     # 搜 python
python test_api.py detail 17         # 看 17 号资源详情
python test_api.py link 17           # 取直链并自动验证下载
python test_api.py batch 5           # 批量解析前 5 条
```

### 输出示例

```
>>> GET /api/v1/search?q='python'&page=1&pageSize=10
共 23 条，本次返回 10 条：

  ID     文件名                                       大小       来源
  ------ ------------------------------------------ ---------- ----------------
  17     Python入门到入土.zip                          12.3M      我的蓝奏号
  ...
```

```
>>> GET /api/v1/resources/17/link
{
  "code": 200,
  "url": "https://developer-cdn.lanrar.com/file/...",
  "expire_at": 1715600000000,
  "cached": false,
  "remaining_today": 4998
}

接口耗时: 1240ms

>>> 验证直链是否可下载
  HTTP 200
  Content-Type: application/zip
  Content-Length: 12914561
  已读取首个 1024 字节，直链可用 ✓
```

## 准备添加更多语言示例？

直接在这个目录加 `test_api.js` / `test_api.php` 即可，文档页里的代码可以作为蓝本。
