# Nagare（流れ）

grokbot や muse などのエージェントが自分でフィードを登録できる、個人用の軽量RSSリーダーのサーバーとWeb版です。
iOS・iPadOS・macOS版は [nagare-apple](https://github.com/trkw/nagare-apple)、Android版は [nagare-android](https://github.com/trkw/nagare-android) にあります。

## 構成

1つの Cloudflare Worker（Hono）にすべてをまとめています。

| パス | 中身 |
| --- | --- |
| `/api/*` | アプリ・Web用のREST API |
| `/mcp` | エージェント用のMCPサーバー（Streamable HTTP、ステートレス） |
| Cron（15分ごと） | 更新時刻が来たRSSフィードを巡回 |

データは D1（SQLite）に保存します。スキーマは `apps/api/migrations/` にあります。

```
apps/api   Worker（API・MCP・巡回）
apps/web   Web版（React＋Vite、これから作成）
```

## 開発

```sh
bun install
cd apps/api
bun run db:migrate:local
bun run token:create --name me --kind app       # アプリ用トークン（表示は一度だけ）
bun run token:create --name grokbot --kind agent
bun run dev                                     # http://localhost:8787
bun test
bun run typecheck
```

Cronは `curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"` で手動実行できます。

## デプロイ（初回）

```sh
cd apps/api
bunx wrangler login
bunx wrangler d1 create nagare      # 表示された database_id を wrangler.jsonc に書く
bun run db:migrate:remote
bun run deploy                      # nagare.trkw.dev にカスタムドメインで公開
bun run token:create --name me --kind app --remote
bun run token:create --name grokbot --kind agent --remote
```

`trkw.dev` のDNSが同じCloudflareアカウントにある必要があります。

## エージェントからの接続

MCPクライアントに次のように登録します。トークンはエージェントごとに分けてください。

```json
{
  "mcpServers": {
    "nagare": {
      "type": "http",
      "url": "https://nagare.trkw.dev/mcp",
      "headers": { "Authorization": "Bearer ngr_..." }
    }
  }
}
```

| ツール | できること |
| --- | --- |
| `discover_feed` | ページURLからフィードを探す |
| `subscribe_feed` / `unsubscribe_feed` | 購読・解除（エージェントは自分が登録したものだけ解除可） |
| `list_feeds` | 購読一覧 |
| `create_agent_feed` / `add_items` | X・InstagramなどRSSのない情報源を、エージェントが記事として書き込む |
| `get_entries` / `get_entry` / `search_entries` | 記事の取得と全文検索（日本語対応） |
| `mark_read` / `star_entry` | 既読・スター |
| `get_handoffs` | 「エージェントに送る」で渡された記事とメモを受け取る |

エージェント用トークンは既定で100フィードまで登録できます（`--max-feeds` で変更）。

## REST API

すべて `Authorization: Bearer <token>` が必要です。

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/me` | トークンの情報 |
| GET / POST | `/api/feeds` | 一覧 / 購読（`{url, folder?, reason?}`） |
| DELETE | `/api/feeds/:id` | 解除 |
| POST | `/api/feeds/:id/refresh` | すぐに再取得 |
| POST | `/api/agent-feeds`、`/api/agent-feeds/:id/items` | 仮想フィードの作成と書き込み |
| GET | `/api/entries` | `feed` `folder` `unread` `starred` `q` `before` `limit` `content` で絞り込み |
| GET | `/api/entries/:id` | 記事本文 |
| POST | `/api/entries/state` | `{ids, read?, starred?}` |
| GET | `/api/sync?since=<ms>` | 前回以降の差分（フィード・記事・既読状態） |
| POST | `/api/handoffs` | エージェントに送る（`{entry_ids, note?, to_agent?}`） |
| GET / POST | `/api/opml` | OPMLの書き出し / 取り込み |
