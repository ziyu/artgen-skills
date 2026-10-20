# Artgen Skills

独立的 Agent Skill 与零运行时依赖的 Node.js 客户端，用于 Artgen 文生图和本地图片转换。**本仓库仅提供客户端，不提供图片生成后端或托管服务。** 你需要自行准备 Artgen 部署，并在该部署的 Dashboard 创建 API Key；客户端没有默认生产域名。

[English](README.md) · [Skill 指令](skills/artgen/SKILL.md) · [API 参考](skills/artgen/references/api.md)

## 安装

需要 Node.js **22.20 或更新版本**。

```sh
npx skills add ziyu/artgen-skills --skill artgen
```

Skill 自带 `scripts/artgen.mjs`，无需安装独立 npm 包或运行时依赖。Agent 必须相对于**已安装的 `SKILL.md`** 定位脚本和参考文件，而不是假设当前目录就是 Skill 目录。

若直接使用 CLI，请克隆仓库，并在仓库根目录运行示例：

```sh
git clone https://github.com/ziyu/artgen-skills.git
cd artgen-skills
node skills/artgen/scripts/artgen.mjs --help
```

## 安全配置

将 `ARTGEN_BASE_URL` 设置为部署的 HTTPS **源地址**（协议、主机以及可选端口），不得包含凭据、路径、查询参数或片段。没有默认地址。通过安全的环境变量注入方式或密钥管理器设置 `ARTGEN_API_KEY`；该密钥应在部署的 Dashboard 创建。

不要在聊天中粘贴密钥，不要把密钥放进命令行参数、Git 仓库或日志。模型提供商的凭据不是客户端 API Key，也不得公开。本客户端不管理密钥、管理员配置或账户余额。

仅本地开发允许 HTTP：主机必须严格为 `localhost`、`127.0.0.1` 或 `[::1]`，并且**每次**调用都需加 `--allow-local-http`。其他 HTTP 主机一律拒绝。不要向不可信的开发服务器发送生产密钥。

## 先查询模型，再确认消费

```sh
node skills/artgen/scripts/artgen.mjs models
```

该公开请求不需要也不会发送 API Key。从实时目录选择 `id`，检查 `supportsText` 或 `supportsTransfer`，并核对 `creditCost`、`sizes[].value` 和 `maxPromptLength`。模型与价格可能变化，不要根据示例猜测。提示词长度按 UTF-16 代码单元计算；每次生成命令都会重新获取目录。

下列示例要求先将 `MODEL_ID` 和 `SIZE` 设置为目录中真实存在的值。转换时应选择 `supportsTransfer: true` 的模型，不必与文生图使用同一模型。本客户端没有公开的风格目录；除非已核实当前部署支持的风格 ID，否则请省略 `--style`。

## 生成或转换

通过编辑器或文件写入工具将提示词保存为 UTF-8 文件。推荐 `--prompt-file`，不要将用户文本拼接进 shell 命令，更不要将提示词当作 shell 语法执行。下面的提示词文件和源图片需要预先在本地准备。

**每次生成请求都可能扣除积分。** 使用 `--yes` 前，应向用户说明所选模型、当前积分费用、操作、提示词/源图片和输出位置，并取得明确同意。`--yes` 是消费授权，不是试运行。未传入时，生成命令在发出任何网络请求之前返回 `confirmation_required`。

用户同意后生成图片：

```sh
node skills/artgen/scripts/artgen.mjs create \
  --model "$MODEL_ID" --size "$SIZE" \
  --prompt-file ./prompt.txt --output ./created.png --yes
```

另行获得授权后转换本地图片：

```sh
node skills/artgen/scripts/artgen.mjs convert \
  --model "$MODEL_ID" --size "$SIZE" \
  --input ./reference.png --prompt-file ./conversion.txt \
  --output ./converted.png --yes
```

`--input` 仅接受不超过 5 MiB 的本地 PNG、JPEG 或 WebP 普通文件，并校验文件魔数；不接受远程源图片 URL。`create` 不接受 `--input`。`--prompt` 和 `--prompt-file` 必须且只能提供一个。`--size` 和 `--style` 可选；`--timeout` 默认 120 秒，允许 1–600 秒。

输出路径必须尚不存在：客户端不会覆盖文件，会在付费 POST 前独占预留输出路径，下载结果时不会转发 API Key。保存的是实际图片字节，`.png` 后缀不会把 JPEG/WebP 转成 PNG；展示或命名时请参考返回的 `mimeType`。

## 结果与失败处理

成功时，标准输出为一个 JSON 结果。`models` 返回 `{ "models": [...] }`。生成返回 `success`、`requestId`、`data`（`path`、`model`、`modelId`、`mimeType`、`bytes`）和 `credits`（`consumed`、`remaining`）。向用户提供已保存文件与实际积分信息，不要在聊天中输出图片编码或密钥。

失败时退出码为 1，标准错误输出安全的 JSON，包含 `success: false`、`error`、`message`，以及可获取的 `requestId`、`status` 或 `generationMayHaveCompleted`。**绝不自动重试生成请求**，包括超时、响应格式异常、下载错误和保存失败：即使没有保存图片，服务端也可能已生成并扣费。保留请求 ID，说明状态不确定，并在再次发起付费请求前取得新的授权。API 不提供幂等键或任务状态查询。客户端拒绝 API 和下载重定向，也不会自动切换模型。

完整边界和安全限制见 [API 与 CLI 参考](skills/artgen/references/api.md)。目录中的能力声明不保证提供商当前可用，也不代表已完成真实转换验证。

## 开发

在仓库根目录运行：

```sh
npm test
npm run check
```

这些检查不需要密钥，也不会发起付费请求。首次发布前，本地 32 项测试及结构/语法检查通过；安装后的技能连接本地 Artgen 后端并实际调用 Cloudflare Workers AI，保存 1024×1024 JPEG，扣除 5 积分（30 → 25）。对同一只支持文字生成的模型，转换在扣费前被拒绝。尚未验证真实转换成功或公开生产部署。

## 许可证

[MIT](LICENSE) © 2026 ziyu。
