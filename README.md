# bot-board

Botがタスクを管理し、人は判断カードをスワイプして選択する、スマートフォン中心のカンバンアプリ。

現在は検証・CIガードレール基盤（`S0`）とメイン判断カードUI試作（`S5`：モック接続）が実装済です。バックエンドAPI・D1・Bot接続は未実装です。

- [企画・要件書](docs/concept.md)：体験、画面構成、MVP、受け入れ条件
- [システム構成・技術スタック仕様](docs/architecture.md)：採用技術、レイヤー境界、ディレクトリ、検証コマンド
- [データモデル・状態遷移・排他制御仕様](docs/data-and-state.md)：DBテーブル、状態遷移、5秒取消・候補排他制御
- [Bot連携・状態設計](docs/bot-integration.md)：対象Bot、MCP / Human API契約、ワーカー・認可境界
- [実装計画・Issue分割マップ](docs/implementation-plan.md)：Phase 1〜3 のIssue分割と受け入れ条件トレース
- [AI開発フロー・ドキュメント規約](docs/development-workflow.md)：Issue駆動手順、Subagentレビュー、記述基準
- [AIエージェント作業基準](AGENTS.md)：エージェント向け参照先と必須ガードレール

対象は ChatGPT / Muse / Grok / Claude。Museの正式なサービスは確認待ちです。
