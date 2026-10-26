# 自评失败提示细分验收

- 引用错误码 MODEL_EVIDENCE_INVALID → 引用校验失败；连接故障 MODEL_NETWORK_ERROR → 网络连接异常；MODEL_TIMEOUT → 调用超时。
- 检查嵌套cause、lastError及聚合异常，区分连接故障、超时、主动取消、鉴权、限流与HTTP服务异常。含糊的历史服务错误不猜测为网络故障。
- resultPresentation统一派生依据、详细说明及带分类的错误正文，前端表格、证据面板、总览与Excel副本一致。失败筛选改为生成失败，保留其他失败类型及具体原因。
- 明确的历史引用错误动态使用新名称；原始数据库答案、来源和诊断保持不变，不触发重新生成。
- 语法检查通过；57项自动测试通过，含三类标签、网络分类、导出列和原文件保留验证。
- 隔离浏览器验证三类标签、详细说明、证据面板、总览、筛选；桌面1440×1000、手机390×844无横向溢出或脚本错误。截图在.test-data/failure-labels-desktop.png和failure-labels-mobile.png。
- 无真实模型调用。真实QSA通过既有PM2编号0重启。备份：.data/backups/20261021-failure-labels-143452/qsa.sqlite。历史任务、结果、来源、知识库、向量、模型及账户数据逐表指纹保持一致。
