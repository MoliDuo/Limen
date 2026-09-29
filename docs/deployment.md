# 部署指南

## 数据库 (Neon)

### 创建数据库

1. 在 [Neon](https://neon.tech) 中选择**新加坡 (ap-southeast-1)** 区域创建项目
2. 在项目仪表盘获取连接串，格式：`postgresql://user:password@ep-xxx.ap-southeast-1.aws.neon.tech/limen?sslmode=require`

### 执行迁移

Vercel 项目的 Build Command 是 `npm run db:migrate && npm run build`，**迁移会在每次
部署构建时自动执行**，使用该环境配置的 `DATABASE_URL`。本地手动执行同一命令：

```bash
npm run db:migrate
```

修改 schema 后：

```bash
npm run db:generate   # 生成迁移文件
npm run db:migrate    # 执行迁移
```

提交生成的迁移文件到版本控制。

## Vercel 部署

### 构建配置

Vercel 的 Build and Output Settings 使用以下默认设置即可：

- **Framework Preset**: `Next.js`
- **Build Command**: 保持默认（`next build`，项目脚本等价于 `npm run build`）
- **Output Directory**: 保持默认（Next.js 使用 `.next`）
- **Install Command**: 保持默认（`npm install`）
- **Root Directory**: 仓库根目录

`package.json` 的 `engines.node` 已固定为 `24.x`，Vercel 会据此选择 Node.js 24。

### 环境变量

在 Vercel 项目设置中配置以下环境变量：

| 变量            | 必须 | 说明                                                           |
| --------------- | ---- | -------------------------------------------------------------- |
| `DATABASE_URL`  | 是   | Neon Postgres 连接串，推荐通过 Vercel Marketplace 连接 Neon    |
| `AUTH_PASSWORD` | 是   | Web 登录和 Bearer API 共用的明文密码，也是日记内容的加密主密码 |
| `AI_API_KEY`    | 是   | OpenAI API Key                                                 |

**可选变量:**

| 变量                  | 说明                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ALLOWED_DEV_ORIGINS` | 仅用于本地开发，配置允许跨域访问的开发地址。取值以逗号分隔（如 `localhost,dev.example.test`）。在生产环境（Vercel）无需配置 |
| `AI_BASE_URL`         | OpenAI API 基础 URL，默认 `https://api.openai.com/v1`                                                                       |
| `AI_MODEL`            | AI 模型名称，默认 `gpt-4o-mini`                                                                                             |

请参考 `.env.example` 获取完整的变量格式说明。

### 部署步骤

1. 在 Neon 新加坡区域创建数据库，并通过 Vercel Marketplace 连接或手动配置 `DATABASE_URL`
2. 对目标数据库执行 `npm run db:migrate`
3. 将同一个明文 `AUTH_PASSWORD` 写入 Vercel 环境变量，并同步到 Web 登录和所有 API 客户端
4. 配置 `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`
5. 部署应用
6. 验证部署（见下文）

## 凭证轮换

`AUTH_PASSWORD` 同时是日记内容的加密主密码，**不能直接修改**，否则新密码解不开数据密钥，应用会报错。请按 [encryption.md](encryption.md#更换主密码) 的三步流程操作：先用 `npm run crypto -- add-password` 添加新密码，再修改 Vercel 环境变量并重新部署，最后执行 `remove-other-slots`。轮换会同时注销现有浏览器会话并使旧 Bearer 凭证失效。

升级旧部署时，删除 `AUTH_PASSWORD_HASH`、`API_TOKEN_HASH` 和 `SESSION_SECRET`，避免继续维护互相不同步的凭证。

## 部署验证

部署后验证以下功能是否正常：

1. **登录**: 使用已配置密码登录 Web 界面
2. **创建条目**: 在 Web 界面或通过 API 创建新条目
3. **搜索**: 搜索创建的条目
4. **AI 回写**: 等待 AI 处理完成，确认条目生成标题、摘要和标签
5. **删除条目**: 删除条目确认
6. **退出登录**: 退出后会话应失效

### API 验证示例

```bash
# 创建条目
curl -X POST https://your-app.vercel.app/api/entries \
  -H "Authorization: Bearer <AUTH_PASSWORD>" \
  -H "Content-Type: application/json" \
  -d '{"content":"测试条目内容","createdAt":"2026-07-24"}'

# 列条目
curl "https://your-app.vercel.app/api/entries?limit=5" \
  -H "Authorization: Bearer <AUTH_PASSWORD>"

# 获取详情
curl "https://your-app.vercel.app/api/entries/<id>" \
  -H "Authorization: Bearer <AUTH_PASSWORD>"
```

## 运行时说明

- **区域**: Functions (sin1) 与 Neon (ap-southeast-1) 均使用新加坡区域以降低延迟
- **超时**: AI 后台任务最长运行 60 秒 (`maxDuration = 60`)
- **迁移**: 数据库迁移不自动执行，需手动运行 `npm run db:migrate`
- **构建**: Vercel Framework Preset 为 `Next.js`，Build Command 使用默认值

## 内容加密上线

迁移 `0009` 新增 `encryption_key_slots` 表，改造 `tags` 表，并删除早先推迟的旧列 `entries.tags`。加密之后，旧版本代码读不懂新写入的密文，所以**这次部署无法靠重新部署旧版本回滚**：

1. 部署前在 Neon 为生产库开一个 branch，作为回滚点；
2. 部署后打开时间线，旧数据会在后台逐步加密；也可以在本地执行 `npm run crypto -- encrypt-existing` 一次完成，再用 `npm run crypto -- status` 确认明文已经清零；
3. 确认一切正常后，删除这个 branch 和其他旧 branch，因为它们里面仍有明文。

威胁模型、存储格式和离线解密方法见 [encryption.md](encryption.md)。

## 安全注意事项

- 本应用为**单用户设计**，API 无用户层级权限控制
- `AUTH_PASSWORD` 是明文主凭证，只应存放在 Vercel 环境变量、密码管理器和受信任的 API 客户端中
- `AUTH_PASSWORD` 也是加密主密码：数据库泄露后，攻击者可以离线暴力猜测它，因此必须足够长、足够随机；一旦遗忘，日记就无法解密
- 部署后应验证安全响应头和 nonce CSP 是否正常工作
- 轮换 `AUTH_PASSWORD` 后必须同时验证 Web 登录和 API 写入
