# QSA-RAG

![Version](https://img.shields.io/badge/version-0.6.0-2563eb)
![Platform](https://img.shields.io/badge/platform-Windows-0078d4)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524-339933)
![Python](https://img.shields.io/badge/Python-%E2%89%A53.10-3776ab)

**用已有知识库辅助填写供应商自评 Excel，每题附上可追溯依据。**

导入问答知识库，检索相关原文，逐题生成自评结果并导出新表格。知识和任务保存在本机，模型通过 API 调用。

**Windows 本机运行 · 默认端口 4174 · 无需登录 · 支持双击启动**

[快速开始](#快速开始) · [使用流程](#使用流程) · [详细说明](docs/usage.md)

## 能做什么

| 功能 | 说明 |
| --- | --- |
| 📚 知识库 | Excel 导入、预览、搜索、版本替换与删除撤销 |
| 🔎 检索 | 关键词 / 向量 / 混合检索，可选重排，支持增量索引 |
| ✍️ 自评填表 | 逐题处理，核验引用，区分完整依据、部分依据、无信息和调用失败 |
| 📄 导出与历史 | 导出 Excel 副本，保留来源；任务可回看、重试和再次导出 |
| 🔐 本机保护 | 仅本机访问、API Key 加密保存、SQLite 持久化 |

> 答案正文由通过核验的知识库 C 列原文片段组成。缺少依据会明确标识，结果仍需人工审核。

## 快速开始

**环境：Windows、Node.js ≥24、Python ≥3.10。** 无需安装 Excel 或独立数据库；使用云模型时无需独立显卡。

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

**导入知识库 → 配置模型 → 建立索引 → 上传待填表 → 验证前 5 项 → 审核并导出**

- 知识库：B 列为问题，C 列为自评说明；D 列旧备注不参与判断。
- 模型：配置并测试生成模型、向量模型；重排模型可选。当前真实验证覆盖阿里云百炼，其他服务商入口尚未逐项实测。
- 文件：支持 `.xlsx`，单文件最大 20 MB。导出生成副本，不修改原文件。

> 当前供 **Windows 本机** 使用。云模型调用需要联网；局域网访问、多用户和完全离线部署需额外适配。仅部署静态网页无法运行本项目。

## 数据与开发

业务数据位于 `.data/`，已加入 `.gitignore`。备份时先关闭服务，再复制完整目录；换电脑后需重新填写模型 API Key。

从带账号体系的旧版升级时，下次启动会清理旧账号及会话表，保留知识库、模型配置和任务历史。建议升级前按上述方式备份。

```powershell
$env:PATH = (Resolve-Path '.\.venv\Scripts').Path + ';' + $env:PATH
npm run check
npm test
```

上述命令让测试使用已安装依赖的虚拟环境。自动测试使用隔离数据和模拟模型；浏览器测试需另配 Playwright。

更多内容：**[模型配置、Excel 规则、检索设置、备份迁移与测试](docs/usage.md)**。
