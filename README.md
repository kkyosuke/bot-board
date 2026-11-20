# bot-board

Botがタスクを管理し、人は判断カードをスワイプして選択する、スマートフォン中心のカンバンアプリ。

現在は `S0`〜`S8`（全6画面SPA・Cloudflare/Pulumi IaC・D1スキーマ・Better Auth/OAuth 2.1・Human API 13本・MCP 12ツール・Queue/DLQ/Cron自律ワーカー・`grok.ts` アダプター・全12件AC自動縦通しE2E）が実装済です。Cloudflare 検証/本番環境への実デプロイ（`#13`・`#21`）および外部 Bot 実機接続実証（`#17` ChatGPT / `#18` Grok / `#20` Claude）・Muse 特定（`#19`）は認証情報設定後に実施します。

## ドキュメント

- [企画・要件書](docs/concept.md)：体験、画面構成、MVP、受け入れ条件
- [システム構成・技術スタック仕様](docs/architecture.md)：採用技術、レイヤー境界、ディレクトリ、検証コマンド
- [データモデル・状態遷移・排他制御仕様](docs/data-and-state.md)：DBテーブル、状態遷移、5秒取消・候補排他制御
- [Bot連携・状態設計](docs/bot-integration.md)：対象Bot、MCP / Human API契約、ワーカー・認可境界
- [実装計画・Issue分割マップ](docs/implementation-plan.md)：Phase 1〜3 のIssue分割と受け入れ条件トレース
- [AI開発フロー・ドキュメント規約](docs/development-workflow.md)：Issue駆動手順、Subagentレビュー、記述基準
- [AIエージェント作業基準](AGENTS.md)：エージェント向け参照先と必須ガードレール

## ローカル実行・自動検証コマンド

| コマンド                     | 内容                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run verify`             | 整形・Lint・型検査・docsガードレール・単体/結合テスト・UI/Workerビルド・IaC静的検証                                                                                                         |
| `bun run test:e2e`           | Playwright UI E2E（SP 360px/320px・PC 全6画面）                                                                                                                                             |
| `bun run test:e2e:fullstack` | Playwright フルスタック縦通しE2E（実SPA・Auth・Human API・MCP・SQLite・Queue/DLQ：SP 360/320px・PC）                                                                                        |
| `bun run dev:full`           | ローカルフルスタック起動（`http://127.0.0.1:4174`・背景Queue/Cron実行付・実ログインには `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `OWNER_GITHUB_ID`、xAI実行には `XAI_API_KEY` を設定） |

対象は ChatGPT / Muse / Grok / Claude。Museの正式なサービスは確認待ち（`#19`）、各外部Bot実機接続は未実施です。
