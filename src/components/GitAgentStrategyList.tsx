import type { AnalysisResult, CommitStrategy } from './git-agent-panel-utils'

type GitAgentStrategyListProps = {
  data: AnalysisResult
  title: string
  commitAllLabel: string
  commitPartialLabel: string
  onExecute: (strategy: CommitStrategy, index: number) => void
}

export const GitAgentStrategyList = ({
  data,
  title,
  commitAllLabel,
  commitPartialLabel,
  onExecute,
}: GitAgentStrategyListProps) => (
  <div className="git-agent-strategies">
    {data.strategies.length > 0 ? (
      <>
        <strong className="git-agent-strategies-title">{title}</strong>
        {data.strategies.map((strategy, index) => (
          <div key={index} className="git-strategy-row">
            <div className="git-strategy-row-info">
              <strong>{strategy.label}</strong>
              <span>{strategy.description}</span>
            </div>
            <button
              type="button"
              className={`git-tool-button${index === 0 ? ' is-primary git-strategy-btn-all' : ' git-strategy-btn-partial'}`}
              onClick={() => onExecute(strategy, index)}
            >
              {index === 0 ? commitAllLabel : commitPartialLabel}
            </button>
          </div>
        ))}
      </>
    ) : null}
  </div>
)
