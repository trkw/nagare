# Nagare（流れ）

grokbot や muse などのエージェントが自分でフィードを登録できる、個人用の軽量RSSリーダーのサーバーとWeb版です。
iOS・iPadOS・macOS版は [nagare-apple](https://github.com/trkw/nagare-apple)、Android版は [nagare-android](https://github.com/trkw/nagare-android) にあります。

## 構成

1つの Cloudflare Worker（Hono）にすべてをまとめています。

| パス | 中身 |
| --- | --- |
| `/api/*` | アプリ・Web用のREST API |
| `/mcp` | エージェント用のMCPサーバー（Streamable HTTP、ステートレス） |
| Cron（15分ごと） | 更新時刻が来たフィードと見張っているページを巡回 |
| それ以外 | Web版（`apps/web` のビルド結果を静的配信） |

データは D1（SQLite）に保存します。スキーマは `apps/api/migrations/` にあります。

```
apps/api   Worker（API・MCP・巡回）
apps/web   Web版（React＋Vite）
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

Web版は別のターミナルで `bun run dev:web`（http://localhost:5173、`/api` は8787に転送）。
Workerから配信される形で確かめるときは `bun run build` のあと http://localhost:8787 を開きます。
ログイン画面ではアプリ用トークンを入力します（ブラウザに保存）。キー操作は j / k（移動）、s（あとで読む）、m（既読/未読）、v（元の記事）、r（再読み込み）。

ローカルでログイン情報を試すときは `apps/api/.dev.vars` に `CREDENTIALS_KEY="適当な文字列"` を書きます。

`bun run dev` はリモートのバインディングを使わない `--local` で動くため、ローカルではWorkers AIの翻訳は動きません（日本語記事の判定と全文取得は動きます）。

Cronは `curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"` で手動実行できます。

## デプロイ（初回）

```sh
cd apps/api
bunx wrangler login
bunx wrangler d1 create nagare      # 表示された database_id を wrangler.jsonc に書く
bun run db:migrate:remote
bun run deploy                      # Web版をビルドして nagare.trkw.dev に公開
bun run token:create --name me --kind app --remote
bun run token:create --name grokbot --kind agent --remote
```

`trkw.dev` のDNSが同じCloudflareアカウントにある必要があります。

翻訳は既定でWorkers AI（m2m100、無料枠あり）を使います。段落内のリンクや強調を保ったまま、より自然に訳したい場合はClaudeを使えます。

```sh
bunx wrangler secret put ANTHROPIC_API_KEY   # 設定するとClaudeで翻訳
# モデルを変えるときは wrangler.jsonc の vars に TRANSLATE_MODEL を追加（既定 claude-opus-5-5）
```

## RSSのないサイトとパスワード付きフィード

フィードが見つからないページは「このページを見張る」で登録できます。ページ内の記事（`article` 要素、なければ本文中のリンク）が新しい記事になります。フィードの設定でCSSセレクタを指定すると、合う要素が1件ずつ記事になります。リンクのない要素は、文章が変わるたびに新しい記事として届きます（「営業時間のお知らせ」の変化を見張る、など）。

会員限定のフィードやページは、サイドバー下の「ログイン情報」でID・パスワード（Basic認証）、ヘッダー、Cookieのいずれかを登録してから使います。ログイン情報は暗号化して保存し、登録したホスト以外には送りません（別のホストへのリダイレクトでも外します）。全文取得でも同じログイン情報を使います。暗号化の鍵を最初に設定してください。

```sh
openssl rand -base64 32 | bunx wrangler secret put CREDENTIALS_KEY
```

鍵を変えると保存済みのログイン情報は読めなくなるので、登録し直してください。

## プッシュ通知

フィードの設定で「新しい記事を通知する」をオンにすると、巡回やエージェントの書き込みで新着が入ったときに通知します（同じフィードの新着はまとめて1件）。エージェントは `notify` ツールで直接知らせることもできます（1時間に20件まで）。

使う通知の種類だけ設定します。設定していない種類の端末には送りません。

```sh
cd apps/api
# Web Push（ブラウザ）
bun run push:vapid                      # 表示された公開鍵を wrangler.jsonc の VAPID_PUBLIC_KEY に書く
bunx wrangler secret put VAPID_PRIVATE_KEY

# iPhone・iPad・Mac（APNs）。Apple Developer で作った .p8 キー
bunx wrangler secret put APNS_KEY < AuthKey_XXXXXXXXXX.p8   # キーIDとチームIDは wrangler.jsonc に書く

# Android（FCM）。Firebase のサービスアカウントJSON
bunx wrangler secret put FCM_SERVICE_ACCOUNT < service-account.json
```

Web版ではサイドバー下の「このブラウザで通知を受け取る」で登録し、「テスト」で届くか確かめられます。iPhoneのSafariでは、ホーム画面に追加したWebアプリでだけ通知を受け取れます。

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
| `subscribe_feed` / `unsubscribe_feed` | 購読・解除（エージェントは自分が登録したものだけ解除可）。`credential` で保存済みのログインを使える |
| `create_web_feed` | RSSのないページを見張る。`selector` で対象を指定、`dry_run` で何が拾えるか確認 |
| `list_credentials` | 使えるログイン情報の名前とホスト（中身は見えない。登録はアプリからのみ） |
| `list_feeds` | 購読一覧 |
| `create_agent_feed` / `add_items` | X・InstagramなどRSSのない情報源を、エージェントが記事として書き込む |
| `get_entries` / `get_entry` / `search_entries` | 記事の取得と全文検索（日本語対応）。`get_entry` は `full_text: true` で元ページから全文を取得 |
| `translate_entry` | 記事を翻訳（既定は日本語、結果はキャッシュ） |
| `mark_read` / `star_entry` | 既読・スター |
| `get_handoffs` | 「エージェントに送る」で渡された記事とメモを受け取る |
| `notify` | 持ち主の端末にプッシュ通知を送る（1時間に20件まで） |

エージェント用トークンは既定で100フィードまで登録できます（`--max-feeds` で変更）。

## REST API

すべて `Authorization: Bearer <token>` が必要です。

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/me` | トークンの情報 |
| GET / POST | `/api/feeds` | 一覧 / 購読（`{url, folder?, reason?, credential?}`） |
| PATCH | `/api/feeds/:id` | `{title?, folder?, selector?, credential?, notify?, auto_translate?}` |
| DELETE | `/api/feeds/:id` | 解除 |
| POST | `/api/web-feeds` | ページを見張る（`{url, selector?, title?, folder?, reason?, credential?, dry_run?}`） |
| GET / POST | `/api/credentials` | ログイン情報の一覧 / 追加（アプリ用トークンのみ。`{name, host, kind: basic\|header\|cookie, ...}`） |
| DELETE | `/api/credentials/:id` | ログイン情報の削除 |
| POST | `/api/feeds/:id/refresh` | すぐに再取得 |
| POST | `/api/agent-feeds`、`/api/agent-feeds/:id/items` | 仮想フィードの作成と書き込み |
| GET | `/api/entries` | `feed` `folder` `unread` `starred` `q` `limit` `content` で絞り込み。次ページは最後の記事の `before`（published_at）と `before_id` |
| GET | `/api/entries/:id` | 記事本文 |
| POST | `/api/entries/:id/fulltext` | 元ページから本文を抽出して保存 |
| POST | `/api/entries/:id/translate?lang=ja` | 翻訳（キャッシュあり。日本語の記事はそのまま返す） |
| POST | `/api/entries/state` | `{ids, read?, starred?}` |
| GET | `/api/sync?cursor=<前回のcursor>` | 前回以降の差分（フィード・記事・既読状態）。`has_more` が true の間は返ってきた `cursor` で続けて呼ぶ |
| POST | `/api/handoffs` | エージェントに送る（`{entry_ids, note?, to_agent?}`） |
| GET / POST | `/api/opml` | OPMLの書き出し / 取り込み |
| GET | `/api/push/config` | 設定済みの通知の種類と、Web Push用の公開鍵 |
| GET / POST / DELETE | `/api/push/targets` | 通知を受け取る端末の一覧 / 登録（`{platform: apns\|fcm\|webpush, token, keys?, name?, sandbox?}`、アプリ用トークンのみ） / 解除（`{token}`） |
| POST | `/api/push/test` | テスト通知 |
| GET | `/api/notifications` | 送った通知の履歴（最新50件） |
