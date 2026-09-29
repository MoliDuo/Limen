# 内容加密

日记正文、标题、摘要和标签名在数据库里只以密文存储。解密只需要两样东西：**数据库** 和 **主密码**。没有 pepper，也没有单独的密钥文件。

主密码只存在你的脑子和密码管理器里。服务器不保存它，也不保存任何能解密的秘密：每个请求都要用自己带来的凭证（浏览器的会话 cookie，或 API 令牌）当场解开数据密钥。

## 防什么、不防什么

| 场景                                                      | 能否看到日记                   |
| --------------------------------------------------------- | ------------------------------ |
| 拿到数据库：Neon 泄露、导出的备份、数据库控制台、SQL 日志 | 不能                           |
| 拿到 Vercel 项目的环境变量或日志                          | 不能                           |
| 能修改代码并重新部署的人                                  | 能（可在你下次登录时截获密码） |
| AI 服务商（`AI_BASE_URL`）                                | 能（正文照常发给它处理）       |
| 浏览器本地的未保存草稿（`localStorage`）                  | 能                             |

数据库里仍然是明文的只有元数据：日期、时间、条目数量、密文长度、AI 状态、来源，以及哪些条目共用同一个标签（但看不到标签写的是什么）。

**主密码的强度就是加密的强度。** 盐和被包裹的数据密钥都存在数据库里，拿到数据库的人可以离线暴力猜密码。scrypt 会让每次猜测变慢，但弱密码仍然守不住。请使用 20 位以上的随机字符，或 6 个以上的随机单词。

**忘记密码，日记就无法恢复。** 服务器上没有任何备份，也没有“重置密码”。请务必存进密码管理器。

## 密钥结构

```
主密码 ────────scrypt(salt)──▶ 包裹密钥 ──AES-256-GCM 解开──▶ 数据密钥 (32 字节随机数)
                                                              │
                                  ┌──── HKDF "limen/fields/v1" ──┴── HKDF "limen/tag-index/v1" ────┐
                                  ▼                                                                ▼
                        AES-256-GCM 加密各字段                                   HMAC-SHA256 标签索引
```

- 所有内容都由一把随机的 **数据密钥** 加密。它本身不直接存储，而是被“由密码派生的包裹密钥”加密后，存在 `encryption_key_slots` 表里。
- 表里的每一行是一个 **钥匙槽**：同一把数据密钥，被某样东西包裹一次。槽有三种（`kind` 列）：
  - `password`：主密码，经 scrypt 派生包裹密钥。**登录就是尝试打开这个槽**，所以不再另存密码哈希。
  - `session`：每次登录新建一个。秘密是 32 字节随机数，只存在浏览器的 cookie 里；有效期 7 天，活跃使用时自动续期。退出登录即删除。
  - `api_token`：在设置页生成，给快捷指令等外部客户端用。秘密只显示一次，撤销即删除。
- 会话和令牌的秘密本身熵足够，包裹密钥用 `HKDF-SHA256(秘密, salt, "limen/credential-slot/v1")` 派生，不需要慢哈希。
- 换密码只需要新增一个密码槽再删掉旧槽，不用重新加密任何日记。
- 应用只在库里一个槽都没有、也没有任何密文时，才会生成新的数据密钥（`npm run crypto -- init`）。如果表是空的、但库里已经有密文，会拒绝生成并报错，防止误删表之后悄悄换了一把新密钥。
- 撤销会话或令牌后，本实例立即失效；其他 Vercel 实例因为有 60 秒的验证缓存，最多延迟一分钟。

## 存储格式

以下内容足以在没有本应用的情况下自行解密。

**钥匙槽**（`encryption_key_slots`）：

| 列            | 内容                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `kind`        | `password`、`session` 或 `api_token`                                 |
| `kdf`         | 密码槽为 `scrypt`，会话和令牌槽为 `hkdf`                             |
| `kdf_params`  | JSON，如 `{"N":131072,"r":8,"p":1}`                                  |
| `salt`        | base64url，16 字节                                                   |
| `wrapped_key` | base64url：`iv(12) ‖ 密文(32) ‖ tag(16)`，AAD 为 `limen/data-key/v1` |

密码槽的包裹密钥 = `scrypt(NFC(主密码), salt, 32, kdf_params)`。

**字段密文**：`enc:v1:` + base64url(`iv(12) ‖ 密文 ‖ tag(16)`)，算法是 AES-256-GCM，密钥为 `HKDF-SHA256(数据密钥, salt=空, info="limen/fields/v1", 32)`。AAD 用来把密文绑定到具体位置：

| 位置              | AAD                          |
| ----------------- | ---------------------------- |
| `entries.content` | `entries.content:<entry id>` |
| `entries.title`   | `entries.title:<entry id>`   |
| `entries.summary` | `entries.summary:<entry id>` |
| `tags.name`       | `tags.name`                  |

`tags.name_hmac` = base64url(`HMAC-SHA256(HKDF(数据密钥, info="limen/tag-index/v1"), 标签名)`)，用于唯一性约束和按标签筛选。

不带 `enc:v1:` 前缀的值是加密上线之前写入的旧数据，按原样读取，并由后台逐步加密（见下文）。

### 离线解密示例

```js
// LIMEN_PASSWORD='主密码' node decrypt.mjs —— 还需要 DATABASE_URL
import { createDecipheriv, hkdfSync, scryptSync } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const open = (key, b64, aad) => {
  const buf = Buffer.from(b64, 'base64url');
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(buf.subarray(-16));
  return Buffer.concat([d.update(buf.subarray(12, -16)), d.final()]);
};
let dataKey;
for (const slot of await sql`select * from encryption_key_slots where kind = 'password'`) {
  const { N, r, p } = JSON.parse(slot.kdf_params);
  const kek = scryptSync(
    process.env.LIMEN_PASSWORD.normalize('NFC'),
    Buffer.from(slot.salt, 'base64url'),
    32,
    { N, r, p, maxmem: 256 * N * r },
  );
  try {
    dataKey = open(kek, slot.wrapped_key, 'limen/data-key/v1');
    break;
  } catch {}
}
const fieldKey = Buffer.from(
  hkdfSync('sha256', dataKey, Buffer.alloc(0), 'limen/fields/v1', 32),
);
const read = (v, aad) =>
  v?.startsWith('enc:v1:') ? open(fieldKey, v.slice(7), aad).toString() : v;
for (const e of await sql`select id, created_at, content from entries`) {
  console.log(e.created_at, read(e.content, `entries.content:${e.id}`));
}
```

日常备份不需要这样做：设置页的导出功能输出的就是解密后的 Markdown 或 JSON。

## 旧数据的加密

加密上线之前写入的行会自动加密：每次打开时间线，后台最多花 20 秒处理一批，每分钟至多一次。全部处理完之后就不再运行。也可以手动一次性完成：

```bash
npm run crypto -- status             # 还剩多少明文
npm run crypto -- encrypt-existing   # 立即全部加密
```

每一步都可以中断、可以重跑，也不会覆盖同时发生的编辑。

## 更换主密码

在 **设置 → 主密码** 里修改：输入当前密码和新密码（至少 12 位）即可。修改后：

- 旧密码立即失效；
- 除当前设备外，所有已登录的浏览器都会被退出；
- API 令牌不受影响，快捷指令无需更新。

不用重新加密任何日记，也不用改任何环境变量。服务器上也可以用命令行完成：

```bash
npm run crypto -- change-password   # 交互输入当前密码和新密码，所有设备都会退出
npm run crypto -- revoke-sessions   # 只让所有设备退出登录
```

## 初始化

全新部署的数据库还没有主密码，先在本地（`.env.local` 的 `DATABASE_URL` 指向生产库）设置：

```bash
npm run crypto -- init
```

从旧版本升级的数据库已经有密码槽（上一版用 `AUTH_PASSWORD` 自动创建的），不需要这一步。如果升级时库里还没有任何密码槽、而 Vercel 上的 `AUTH_PASSWORD` 仍在，第一次用它登录就会自动建好密码槽；之后就可以删掉这个环境变量。

## 残留的明文

加密只影响之后写入的数据。上线之前的明文仍然可能留在：

- Neon 的时间点恢复（PITR）历史中，保留期过后才会清除；
- 上线前创建的 Neon branch 和导出的备份中，确认新版本工作正常后应当删除它们。
