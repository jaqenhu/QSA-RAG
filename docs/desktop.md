# Windows 桌面版

桌面应用名称为 QSA-RAG，当前测试版为 `0.7.0-beta.3`，面向 Windows 10/11 x64。此版修复退出时残留网页连接导致的卡住，并保留 beta.2 对缺少 zod 依赖导致启动失败的修复；旧版用户直接安装新版覆盖升级，保留业务数据。当前使用由项目 favicon 转换的临时图标；正式图标可在发布前提供 `desktop/icon.svg`，构建时会优先使用它生成多尺寸 ICO 和 PNG。没有正式图标时从 `favicon.svg` 生成。

## 安装与数据

安装包包含 Electron 的 Node.js、精简 Python 3.13 及 `openpyxl`、`defusedxml`、`et_xmlfile`。用户无需安装 Node.js、Python、Excel 或独立数据库；云模型调用仍需要联网和自己的 API Key。

数据继续保存在 `%LOCALAPPDATA%\QSA-RAG\data\`，桌面偏好和日志保存在 `%APPDATA%\QSA-RAG\`。菜单“应用 → 打开数据目录”可定位业务数据。关闭窗口会安全关闭服务；训练或自评期间会先询问是否停止，已完成结果保留。启动时使用系统分配的本机端口，不依赖源码版的 4174。

同一数据目录仅能被一个服务使用；运行桌面版前关闭已启动的源码服务。升级和卸载均不清理业务数据。旧源码数据的迁移、备份和恢复见 [使用说明](usage.md#从项目内旧目录迁移)。桌面安装包不能自行猜测未迁移的源码所在位置；已有源码用户先运行新版源码迁移，或明确设置 `QSA_DATA_DIR`。

### 同一程序打开后历史为空

Windows 的 MSIX 桌面宿主可能把子进程对 AppData 的访问重定向到宿主包的 `LocalCache`。例如，从 Codex 启动的服务可能实际读取 `%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\QSA-RAG\data`，而从资源管理器双击的服务读取普通的 `%LOCALAPPDATA%\QSA-RAG\data`。两者输出的逻辑路径可能完全相同；仅看路径、在同一宿主内检查 SQLite 或重新启动验收，都不足以确认用户实际看见的数据。

排查时保留用户正在运行的实例，从其页面地址检查模型及任务列表接口，再用“应用 → 打开数据目录”在资源管理器核对数据库大小和文件。必要时比较当前后台进程持有的数据库句柄的实际路径、文件标识和大小。请勿因为列表为空就删除数据、重新配置模型或覆盖已有非空数据库。

恢复前关闭相关服务，完整备份历史目录并校验数据库和原文件；确认目标确为空库后，先将目标目录另存保留，再通过普通资源管理器复制完整历史目录到正常用户数据位置。不要仅复制 SQLite 主文件而遗漏 WAL、上传文件或备份。最终必须从普通资源管理器双击安装位置的 EXE，核对界面和该实例接口，并退出、重开确认持久化。若两份目录都有新业务数据，应先单独备份和核对，不自动合并或覆盖。

微软对该重定向行为的说明见 [打包桌面应用的 AppData 操作](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes#appdata-operations-on-windows-10-version-1903-and-later)。本问题属于启动宿主的数据视图差异，恢复数据不需要重新安装运行环境。

## 本地构建

开发/构建机器需要 Node.js ≥24 和可运行标准库脚本的 Python ≥3.10：

```powershell
npm ci
npm run desktop:prepare
npm run desktop
```

创建可直接测试的目录及完整 NSIS 安装包：

```powershell
npm run desktop:pack
npm run desktop:build
npm run desktop:test
```

产物位于 `release/`。构建脚本从官方源下载运行环境并核对 SHA-256；Python 和 wheel 版本/哈希固定在 `desktop/runtime-lock.json`，Electron 版本及官方校验值来自锁定的 npm 包。构建缓存位于 `.build-cache/`，运行环境暂存于 `.build/`，均不入库。

打包采用明确的程序文件清单；数据库、上传文件、测试数据、备份、虚拟环境、缓存和凭据均不包含在内。Python 脚本位于 `resources/python-scripts/`，供独立 Python 读取；其余代码位于 ASAR。构建后检查所有必需运行依赖及 peer dependencies 都已入包；zod 显式列入生产依赖。桌面验收把程序复制到系统临时目录，在源码项目之外运行，并移除 Node/Python/模块搜索路径，防止意外借用开发依赖。

## 自动更新与发布

使用 `electron-updater` 和 NSIS，更新源为 `jaqenhu/QSA-RAG` 的 GitHub Releases。启动后后台检查，可通过“应用 → 检查更新”手动检查。下载时可继续工作；安装前后台会再次原子检查任务和请求是否空闲，安全关闭数据库后才启动安装器。下载完也不会在普通退出时绕过检查自动安装。

测试版本使用 beta 通道，并允许 GitHub prerelease；正式版本仅使用稳定通道且禁止降级。每次发布必须包含安装器、对应 `.blockmap` 及生成的更新 YAML（如 `beta.yml`、`latest.yml`）。差异下载不可用时会回退至完整包。GitHub 在目标网络的可达性仍需实际确认。

`.github/workflows/desktop-release.yml` 支持手动构建；推送与 `package.json` 一致的 `v*` 标签后，会测试、构建、验收并创建 **Draft Release**。审核产物后再发布 Draft，客户端才能发现更新。客户端不包含 GitHub token；工作流使用仓库自带的短期 token。

当前 beta 包按用户决定暂不签名，更新也不验证发布者签名，仅进行下载完整性校验，因此只用于测试。无签名构建被限制为带预发布版本号的版本。正式构建使用 `npm run desktop:build:signed`，强制要求签名凭据，并开启更新发布者签名验证；未配置签名时构建会失败。证书/密码通过构建环境或 GitHub Secrets `WINDOWS_CSC_LINK`、`WINDOWS_CSC_KEY_PASSWORD` 提供，不提交仓库或聊天。

还需在正式发布前确定正式图标、签名方式，并完成 GitHub 实际发布版本之间的联网升级验收。CI 只会创建待审核草稿，不自动把草稿设为公开发布。
