import {
  assertModelTimeoutWithinLease,
  type BoundedModelStepOptions,
  type ModelAdapter,
  type ModelStepContext,
  type ModelStepOutput,
  modelStepOutputSchema,
} from "./types";

export type ScriptedStepHandler = (
  context: ModelStepContext,
  options: BoundedModelStepOptions,
) => Promise<ModelStepOutput> | ModelStepOutput;

export function createScriptedModelAdapter(
  name: string,
  handler: ScriptedStepHandler,
): ModelAdapter {
  return {
    name,
    async executeStep(
      context: ModelStepContext,
      options: BoundedModelStepOptions,
    ): Promise<ModelStepOutput> {
      assertModelTimeoutWithinLease(options);
      const output = await handler(context, options);
      return modelStepOutputSchema.parse(output);
    },
  };
}

/**
 * Deterministic bounded scenario adapter used for local full-stack E2E and demo runs:
 * "アプリ企画・競合調査タスク分解 → 方針判断 → 成果提出"
 */
export function createLocalScenarioModelAdapter(): ModelAdapter {
  return createScriptedModelAdapter("local-scenario-adapter", (context) => {
    const decision = context.triggerDecision;

    if (decision !== undefined && decision.result === "declined") {
      return {
        action: "submit_proposal",
        artifact: {
          title: `${context.task.title}（改訂案）`,
          kind: "markdown",
          summary: "見送りを受けて、より最小構成の代替案を作成しました。",
          content_or_url: `# 代替方針案\n\n前回の提案「${decision.proposalTitle}」の見送りを受け、スマホ1画面完結の軽量検証案を作成しました。`,
        },
        proposals: [
          {
            card_type: "policy",
            selection_mode: "binary",
            title: "代替案：最小SP検証スコープで進める？",
            summary: "前回の見送りを受け、機能数を半減した最小構成で次ステップへ進みます。",
            on_accept_effect: "代替方針で調査・成果作成を自動再開",
            on_decline_effect: "タスクを停止し再設計待ちへ移動",
            on_decline_policy: "block",
            factors: [
              { label: "対象", value: "SP 360px 最小構成" },
              { label: "再提案", value: "見送り理由入力なし自動改訂" },
            ],
          },
        ],
        estimated_cost_cents: 1,
      };
    }

    if (decision !== undefined && decision.result === "accepted") {
      const selectedSummary =
        decision.selectedOptionIds.length > 0
          ? `選択結果: ${decision.selectedOptionIds.join(", ")}`
          : "承認済み方針";
      if (!context.task.requiresApproval) {
        return {
          action: "record_result",
          outcome: "success",
          summary: `承認方針（${selectedSummary}）に従い自動実行を完了しました。`,
          artifact: {
            title: `${context.task.title} 実行レポート`,
            kind: "markdown",
            summary: `自動実行完了（${selectedSummary}）`,
            content_or_url: `# 完了レポート\n\n- タスク: ${context.task.title}\n- 採用決定: ${decision.proposalTitle}\n- ${selectedSummary}`,
          },
          estimated_cost_cents: 1,
        };
      }

      return {
        action: "submit_proposal",
        artifact: {
          title: `${context.task.title} 成果ドラフト`,
          kind: "markdown",
          summary: `採用された方針（${selectedSummary}）に基づき最終成果を作成しました。`,
          content_or_url: `# 成果レポート：${context.task.title}\n\n## 採用方針\n- ${decision.proposalTitle}（${selectedSummary}）\n\n## 調査・企画サマリー\n1. モバイル片手スワイプ操作でタスク編集ゼロを実現\n2. 5秒取消＋排他ロックで誤操作を防止\n3. 判断確定後に Queue ワーカーが自律再開して本成果を生成`,
        },
        proposals: [
          {
            card_type: "deliverable",
            selection_mode: "binary",
            title: `成果「${context.task.title} 成果ドラフト」を受け入れて完了する？`,
            summary: `採用方針（${selectedSummary}）に基づき作成した最終成果です。右スワイプでタスク完了（done）へ進みます。`,
            on_accept_effect: "成果を受入確定しタスクを done へ完了",
            on_decline_effect: "成果を差し戻して Bot が修正案を作成",
            on_decline_policy: "revise",
            factors: [
              { label: "生成元", value: "Queue 自動再開ワーカー" },
              { label: "方針", value: selectedSummary },
            ],
          },
        ],
        estimated_cost_cents: 2,
      };
    }

    return {
      action: "submit_proposal",
      proposals: [
        {
          card_type: "policy",
          selection_mode: "binary",
          title: `「${context.task.title}」をスマホ優先MVP方針で進める？`,
          summary: "初期調査に基づき、最小機能で検証を進める方針案を提出します。",
          on_accept_effect: "承認方針で成果ドラフト作成へ自動進行",
          on_decline_effect: "別案を再検討",
          on_decline_policy: "revise",
          factors: [{ label: "スコープ", value: context.allowedScope || "MVP検証" }],
        },
      ],
      estimated_cost_cents: 1,
    };
  });
}
