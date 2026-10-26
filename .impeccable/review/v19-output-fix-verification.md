# 自评输出格式及错误处理修复

日期：2026-10-20。实际模型 ID 保持 qwen-max / text-embedding-v4 / qwen3-rerank。

## 已确认原因及修复

真实返回结构探测发现旧的嵌套输出中，citations 多次变成异常字符串 `:[{`，引用字段落到根对象或混入parts。仅增加提示规则与一次重试仍未解决。最终将模型输出改为 requirements 与 citations 两个平行数组，程序按 requirementId 关联，拒绝重复判断编号、孤立引用、错误状态与无效字段。

- qwen-max 采用 JSON Object、显式字段规则、本地结构与原文双重校验；实际型号在官方支持列表中的百炼模型使用严格 JSON Schema。显示名称不决定请求模式。其他服务商未进行真实云端验证。
- JSON/结构、引用或长度截断最多纠正重试一次（首轮3500 tokens、纠正轮7000）；仍失败则显示具体字段或引用位置。鉴权、限流、接口、请求、超时及服务异常分别编码，不当作无信息，也不进入格式纠正。
- 仅对明确的引用对象转数组、旧的平铺引用字段、missing的空引用做无损兼容；不根据引用序号猜出处，不拼接或编造原文。仍执行逐字C列候选原文校验。
- 最终失败记录保存 errorCode/errorStage/errorIssues/attempts；生成总览直接显示具体错误。安全日志只记录程序生成的字段位置、规则、错误码和尝试次数，不保存密钥、请求头或模型完整响应。
- 原任务、答案、来源、模型配置及索引保持原样；失败项需通过现有重试入口另行生成。

## 验证

- 语法检查通过，50项自动测试通过。新增覆盖平行列表关联、结构纠正、非法JSON、截断、原文拒绝、缺失依据、严格Schema请求及鉴权/限流不重复调用，隔离API覆盖诊断字段持久化。
- 隔离浏览器链路通过：上传、生成、失败重试、来源查看、导出、历史、进度及总览，桌面1440×1000和手机390×844无脚本错误或横向溢出。
- 真实百炼抽查6题，结果见 [抽样记录](v19-output-fix-real.json)：原失败第2行 partial、3行 direct、4行 direct、88行 partial、120行 missing；另抽第7行 partial。5题首轮通过；第120行一次纠正后通过。6题最终均无调用失败。状态是依据原文做出的有效判断，不表示所有要求均满足。
- 抽样使用原任务 ac85a09e-162d-4607-a144-181f5dcedc94 的检索快照，检索调用当前本地API，生成调用修复后的同一客户端；未创建真实验收任务、未重新执行183项整表，也未改写原失败记录。
- 已备份到 `.data/backups/20261020-output-fix-114604/qsa.sqlite`。重启后逐表完整数据指纹对比：assessment_tasks/results/item_details、result_sources、knowledge_projects/records/indexes、index_vectors及model_configs均一致。
- 当前服务由 PM2 的 QSA（编号0）托管；通过该托管进程重启加载修复，继续使用4173端口。

百炼能力依据：[官方结构化输出说明](https://www.alibabacloud.com/help/zh/model-studio/qwen-structured-output)。本地接口行为以实际安装的AI SDK 7源码及协议测试为准。
