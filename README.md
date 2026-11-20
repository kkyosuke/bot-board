# bot-board

Botがタスクを管理し、人は判断カードをスワイプして選択する、スマートフォン中心のカンバンアプリ。

現在は `S0`〜`S8`（全6画面SPA・Cloudflare/Pulumi IaC・D1スキーマ・Better Auth/OAuth 2.1・Human API 13本・MCP 12ツール・Queue/DLQ/Cron自律ワーカー・マルチプロバイダアダプター（`grok.ts` / `gemini.ts` / `meta-muse.ts`）・全12件AC自動縦通しE2E）が実装済です。Cloudflare 検証/本番環境への実デプロイ（`#13`・`#21`）および外部 Bot 実機接続実証（`#17` ChatGPT / `#20` Claude / `#33` Meta Muse / `#34` Google Gemini / `#18` Grok）は認証情報設定後に実施します。

## ドキュメント

- [企画・要件書](docs/concept.md)：体験、画面構成、MVP、受け入れ条件
- [システム構成・技術スタック仕様](docs/architecture.md)：採用技術、レイヤー境界、ディレクトリ、検証コマンド
- [データモデル・状態遷移・排他制御仕様](docs/data-and-state.md)：DBテーブル、状態遷移、5秒取消・候補排他制御
- [Bot連携・状態設計](docs/bot-integration.md)：対象Bot、MCP / Human API契約、ワーカー・認可境界
- [Cloudflare デプロイ・外部プラグイン接続ランブック](docs/deploy-and-plugins.md)：GitHub Secrets→Actions→Cloudflare Secrets 同期、自動デプロイ・D1マイグレーション・スモーク検証、外部プラグイン接続パラメータ
- [実装計画・Issue分割マップ](docs/implementation-plan.md)：Phase 1〜3 のIssue分割と受け入れ条件トレース
- [AI開発フロー・ドキュメント規約](docs/development-workflow.md)：Issue駆動手順、Subagentレビュー、記述基準
- [AIエージェント作業基準](AGENTS.md)：エージェント向け参照先と必須ガードレール

## ローカル実行・自動検証・デプロイコマンド

| コマンド                                        | 内容                                                                                                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun run verify`                                | 整形・Lint・型検査・docsガードレール・単体/結合テスト・UI/Worker/IaCビルド・静的検証                                                                                                                                                       |
| `bun run test:e2e`                              | Playwright UI E2E（SP 360px/320px・PC 全6画面）                                                                                                                                                                                            |
| `bun run test:e2e:fullstack`                    | Playwright フルスタック縦通しE2E（実SPA・Auth・Human API・MCP・SQLite・Queue/DLQ：SP 360/320px・PC）                                                                                                                                       |
| `bun run dev:full`                              | ローカルフルスタック起動（`http://127.0.0.1:4174`・背景Queue/Cron実行付・実ログインには `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `OWNER_GITHUB_ID`、自律ワーカーには `GEMINI_API_KEY` / `XAI_API_KEY` / `META_MODEL_API_KEY` を設定） |
| `bun run deploy -- --stack staging`（/ `prod`） | ビルド → Pulumi デプロイ → リモート D1 マイグレーション → 実環境 17 項目スモーク検証を一括実行（GitHub Actions からも実行可：[ランブック](docs/deploy-and-plugins.md)）                                                                    |

対象は ChatGPT / Claude / Meta Muse / Google Gemini / Grok。Meta Muse は特定済（`#19`完了）、各外部Bot実機接続（`#17`・`#18`・`#20`・`#33`・`#34`）は未実施です。
