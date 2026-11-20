# AGENTS.md

AIエージェント向けの作業基準。詳細は各ドキュメントを参照。

## 参照ドキュメント

| ドキュメント                                                 | 内容                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| [docs/development-workflow.md](docs/development-workflow.md) | 開発フロー、Subagentレビュー、ドキュメント規約                  |
| [docs/implementation-plan.md](docs/implementation-plan.md)   | Phase 1〜3 のIssue分割マップ、依存順、受け入れ条件トレース      |
| [docs/architecture.md](docs/architecture.md)                 | 技術スタック、レイヤー境界、ディレクトリ構成、自動検証コマンド  |
| [docs/data-and-state.md](docs/data-and-state.md)             | DBスキーマ、`Task` / `DecisionCard` 状態遷移、5秒取消・排他制御 |
| [docs/bot-integration.md](docs/bot-integration.md)           | Bot接続方針、MCPツール / Human API 契約、ワーカー・認可境界     |
| [docs/concept.md](docs/concept.md)                           | 企画、UI要件、MVP、受け入れ条件（`UX-*` / `DEC-*` / `BOT-*`）   |

## 必須ルール

| 項目             | ルール                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 進行順序         | `Issue作成・設計` → `UI変更時はArtifact作成` → `Human合意` → `docs/ と実装更新` → `Subagentレビュー反復` → `PR`                      |
| Human確認ゲート  | Issue設計（UI変更時は＋Artifact）の合意前に本実装へ進まない。Issues無効時は先にHumanへ有効化を依頼する                               |
| 機械化ラチェット | レビュー指摘・不具合修正は `docs/` 追記だけで完了させず、原則 `bun lint` / 型 / `scripts/` / `bun test` へ変換し同一PRでCI強制する   |
| Subagentレビュー | 別コンテキストのSubagentで `Spec / Security / Test / UX` と機械的再発防止の同梱を検証し、`Blocker / Major = 0` でPR化する（最大3回） |
| ドキュメント記述 | **結論・状況・1行ガードレール（末尾に `（強制: ...）` 明記）のみ**。変更経緯・議論ログ・長文説明は書かない                           |
| 視覚化優先       | 日本語散文を最小化し、Mermaid（`flowchart` / `sequenceDiagram` / `stateDiagram-v2`）とMarkdown表を使う                               |
