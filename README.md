# QSA-RAG

![Version](https://img.shields.io/badge/version-0.7.0--beta.3-2563eb)
![Platform](https://img.shields.io/badge/platform-Windows-0078d4)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524-339933)
![Python](https://img.shields.io/badge/Python-%E2%89%A53.10-3776ab)

**用已有知识库辅助填写供应商自评 Excel，每题附上可追溯依据。**

导入问答知识库，检索相关原文，逐题生成自评结果并导出新表格。知识和任务保存在本机，模型通过 API 调用。

**Windows 本机运行 · 无需登录 · 提供桌面安装包**

[下载 Windows 安装包](https://github.com/jaqenhu/QSA-RAG/releases) · [快速开始](#快速开始) · [使用流程](#使用流程) · [详细说明](docs/usage.md)

> **建议直接下载 Release 安装包使用。** 前往 **[Releases 发布页面](https://github.com/jaqenhu/QSA-RAG/releases)**，展开对应版本的 **Assets**，下载文件名以 `-win-x64-setup.exe` 结尾的 Windows 安装程序。安装包已内置运行环境，无需另外安装 Node.js、Python 或 Excel。

桌面测试版适用于 Windows 10/11 x64，安装、自动更新及构建说明见 **[桌面版说明](docs/desktop.md)**。需要开发或自行部署时，可使用下方的源码运行方式。

## 能做什么

| 功能 | 说明 |
| --- | --- |
| 📚 知识库 | 多库、多文件 Excel 管理；预览、搜索、替换、删除、恢复与彻底删除 |
| 🔎 检索 | 关键词 / 向量 / 混合检索，可选重排，支持增量索引 |
| ✍️ 自评填表 | 逐题处理，核验引用，区分完整依据、部分依据、无信息和调用失败 |
| 📄 导出与历史 | 导出 Excel 副本，保留来源；任务可回看、重试和再次导出 |
| 🔐 本机保护 | 仅本机访问、API Key 加密保存、SQLite 持久化 |

> 答案正文由通过核验的知识库 C 列原文片段组成。缺少依据会明确标识，结果仍需人工审核。

## 快速开始

### 推荐：下载桌面安装包

1. 打开 **[Releases 发布页面](https://github.com/jaqenhu/QSA-RAG/releases)**，选择要安装的版本。
2. 展开 **Assets**，下载 `QSA-RAG-<版本>-win-x64-setup.exe`。`Source code` 是源码压缩包；`.blockmap`、`beta.yml` 和校验清单供更新或校验使用，普通用户下载 `.exe` 即可。
3. 双击安装程序，完成安装后，通过桌面快捷方式打开 **QSA-RAG**。
4. 在软件内配置自己的模型 API Key，然后按下方使用流程导入知识库并开始自评。

当前为 beta 测试版，安装包尚未配置 Windows 代码签名，Windows 可能提示发布者未知。使用云模型需要联网；用户无需另外安装运行环境或独立数据库。

### 开发者：从源码运行

**源码运行环境：Windows、Node.js ≥24、Python ≥3.10。** 无需安装 Excel 或独立数据库；使用云模型时无需独立显卡。

在 PowerShell 中执行：

```powershell
git clone https://github.com/jaqenhu/QSA-RAG.git
cd QSA-RAG

python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
npm ci

.\start.cmd
```

打开 **[http://127.0.0.1:4174](http://127.0.0.1:4174)**，直接进入工作台，无需账号或密码。已下载源码时，直接进入项目目录，从创建虚拟环境开始执行即可。

**部署完成后，双击项目根目录的 [`start.cmd`](start.cmd) 即可启动并自动打开浏览器。** 脚本自动识别 `.venv`，检查依赖；保持窗口开启，输入 `q` 后回车或按 `Ctrl+C` 停止。端口和数据目录说明见 [部署配置](docs/usage.md#可选配置)。

## 使用流程

**配置模型 → 新建知识库并上传文件 → 知识库训练 → 检索验证 → 上传待填表 → 验证前 5 项 → 审核并导出**

- 知识库：从“知识库”列表新建空库，可逐个上传多个文件；新上传文件的前三列表头必须依次为 A“序号”、B“审核项目”、C“自评说明”，在前 50 行识别，额外列忽略。既有已入库知识不重新解析，待填表的兼容别名规则不变。上传后需在库详情右上角进入“知识库训练”；版本、导入明细、重命名与删库位于“更多”。
- 模型：配置并测试生成模型、向量模型；重排模型可选。当前真实验证覆盖阿里云百炼，其他服务商入口尚未逐项实测。
- 文件：支持 `.xlsx`，单文件最大 20 MB。导出生成副本，不修改原文件。

> 当前供 **Windows 本机** 使用。云模型调用需要联网；局域网访问、多用户和完全离线部署需额外适配。仅部署静态网页无法运行本项目。

## 数据与开发

业务数据默认位于 `%LOCALAPPDATA%\QSA-RAG\data\`，与程序目录分开；启动窗口会显示实际路径。备份时先关闭服务，再复制完整数据目录；换电脑后需重新填写模型 API Key。已有 `QSA_DATA_DIR` 配置继续有效。

首次使用新版时，关闭原服务后启动，程序会校验并复制项目内旧 `.data/`，验证全部数据库记录和文件后启用新目录；旧目录保留为迁移前备份，此后不再同步。新旧目录已有独立数据时会停止并提示，不自动覆盖或合并。

旧版升级在下次启动时迁移单文件库为多文件清单，并清理旧账号及会话表；保留知识库、原文件、索引、模型配置和任务历史。建议升级前按上述方式备份，详见 [升级说明](docs/usage.md#升级说明)。

“已删除文件”可恢复或彻底删除。彻底删除不可撤销，立即排除后续检索；清理未被共用的上传原文件、无历史引用的知识记录及向量，保留历史自评引用快照和既有备份。文件暂不能清理时页面会提示，并在下次启动重试；进行中的该库训练或自评会阻止彻底删除。

```powershell
$env:PATH = (Resolve-Path '.\.venv\Scripts').Path + ';' + $env:PATH
npm run check
npm test
```

上述命令让测试使用已安装依赖的虚拟环境。自动测试使用隔离数据和模拟模型；浏览器测试需另配 Playwright。

更多内容：**[模型配置、Excel 规则、检索设置、备份迁移与测试](docs/usage.md)**。
