# Supabase 根证书

`supabase-root-2021.crt` 是 Supabase 控制台 Database Settings → SSL Configuration 提供的公开 CA 证书，不含私钥。

- 官方下载地址：https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
- SHA-256 指纹：`80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`
- 有效期至：2031-04-26（UTC）。轮换时应重新从官方控制台下载并核验。

`pnpm dev`、`pnpm start`、`pnpm db:check` 通过 `scripts/with-ca.mjs` 在子 Node 进程启动前设置 `NODE_EXTRA_CA_CERTS`，保留证书链与主机名校验，不修改系统证书库。显式设置的外部 `NODE_EXTRA_CA_CERTS` 优先；若覆盖它，提供的证书包应包含所需 Supabase CA。

部署编译产物时同时携带 `scripts/with-ca.mjs` 与本目录；只复制 `dist` 不足以使用 `pnpm start`。
