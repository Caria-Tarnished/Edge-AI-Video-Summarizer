import type { ReactNode } from 'react'

type BaseStateProps = {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  compact?: boolean
}

export function EmptyState({ title, description, actions, compact }: BaseStateProps) {
  return (
    <div className={compact ? 'state compact' : 'state'}>
      {title ? <div className="state-title">{title}</div> : null}
      {description ? <div className="state-desc">{description}</div> : null}
      {actions ? <div className="state-actions">{actions}</div> : null}
    </div>
  )
}

export function LoadingState({ title, description, actions, compact }: BaseStateProps) {
  return (
    <div className={compact ? 'state compact' : 'state'}>
      <div className="spinner" aria-label="loading" />
      {title ? <div className="state-title">{title}</div> : null}
      {description ? <div className="state-desc">{description}</div> : null}
      {actions ? <div className="state-actions">{actions}</div> : null}
    </div>
  )
}
