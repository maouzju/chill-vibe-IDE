import { Component, type ErrorInfo, type ReactNode } from 'react'
import { BaseStyles, ThemeProvider } from '@primer/react'

import { type RecentCrashRecovery } from '../../shared/schema'
import { resetState } from '../api'
import { captureFatalRendererCrash, getLatestKnownAppPresentation } from '../renderer-crash-state'
import { AppButton } from './AppButton'

type AppFatalBoundaryProps = {
  children: ReactNode
}

type AppFatalBoundaryState = {
  error: Error | null
  componentStack: string
  recentCrash: RecentCrashRecovery | null
  actionError: string | null
  resetting: boolean
}

const getFatalBoundaryCopy = (language: 'zh-CN' | 'en') =>
  language === 'zh-CN'
    ? {
        eyebrow: 'Renderer Fatal Error',
        title: '\u754c\u9762\u5d29\u4e86\uff0c\u4f46\u6700\u8fd1\u4f1a\u8bdd\u5df2\u7ecf\u5f00\u59cb\u4fdd\u5e95\u5f52\u6863',
        reload: '\u91cd\u65b0\u52a0\u8f7d\u5e94\u7528',
        reset: '\u91cd\u7f6e\u672c\u5730\u72b6\u6001',
        resetPending: '\u6b63\u5728\u91cd\u7f6e...',
        errorLabel: '\u5d29\u4e86\u4ec0\u4e48',
        details: '\u6280\u672f\u7ec6\u8282',
        archived:
          '\u6700\u8fd1\u6253\u5f00\u7684\u4f1a\u8bdd\u5df2\u7ecf\u5f52\u6863\u8fdb Session History\u3002\u91cd\u65b0\u52a0\u8f7d\u540e\uff0c\u542f\u52a8\u9875\u4f1a\u7ed9\u4f60\u4e00\u4e2a\u201c\u4e00\u952e\u6062\u590d\u6700\u8fd1\u4f1a\u8bdd\u201d\u7684\u5165\u53e3\u3002',
        noArchive:
          '\u8fd9\u6b21\u6ca1\u6709\u6293\u5230\u53ef\u5f52\u6863\u7684\u6700\u8fd1\u4f1a\u8bdd\uff0c\u4f46\u9519\u8bef\u7ec6\u8282\u5df2\u7ecf\u8bb0\u4e0b\u6765\u4e86\u3002\u5efa\u8bae\u5148\u91cd\u65b0\u52a0\u8f7d\uff1b\u5982\u679c\u8fd8\u662f\u8fdb\u4e0d\u53bb\uff0c\u518d\u8003\u8651\u91cd\u7f6e\u672c\u5730\u72b6\u6001\u3002',
        resetFailed: '\u91cd\u7f6e\u672c\u5730\u72b6\u6001\u5931\u8d25\uff0c\u8bf7\u5148\u5c1d\u8bd5\u91cd\u65b0\u52a0\u8f7d\u5e94\u7528\u3002',
      }
    : {
        eyebrow: 'Renderer Fatal Error',
        title: 'The renderer crashed, but recent sessions are being preserved',
        reload: 'Reload app',
        reset: 'Reset local state',
        resetPending: 'Resetting...',
        errorLabel: 'What broke',
        details: 'Technical details',
        archived:
          'Recent open sessions were archived into Session History. After reload, the app will offer a one-click restore entry.',
        noArchive:
          'No recoverable recent sessions were found this time, but the error details were logged. Try a reload first, and only reset local state if the app still cannot open.',
        resetFailed: 'Resetting local state failed. Try reloading the app first.',
      }

export class AppFatalBoundary extends Component<AppFatalBoundaryProps, AppFatalBoundaryState> {
  state: AppFatalBoundaryState = {
    error: null,
    componentStack: '',
    recentCrash: null,
    actionError: null,
    resetting: false,
  }

  static getDerivedStateFromError(error: Error) {
    return {
      error,
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    const message = error.message || 'Unknown renderer error.'
    const stack = [error.stack ?? '', info.componentStack ?? ''].filter(Boolean).join('\n\n')

    this.setState({
      componentStack: info.componentStack ?? '',
      actionError: null,
    })

    void captureFatalRendererCrash({
      source: 'react-boundary',
      message,
      stack,
    }).then((recentCrash) => {
      if (recentCrash) {
        this.setState({ recentCrash })
      }
    }).catch(() => undefined)
  }

  private handleReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload()
    }
  }

  private handleReset = () => {
    this.setState({ resetting: true, actionError: null })
    void resetState().then(() => {
      this.handleReload()
    }).catch(() => {
      const { language } = getLatestKnownAppPresentation()
      this.setState({
        resetting: false,
        actionError: getFatalBoundaryCopy(language).resetFailed,
      })
    })
  }

  override render() {
    if (!this.state.error) {
      return this.props.children
    }

    const { language, theme } = getLatestKnownAppPresentation()
    const copy = getFatalBoundaryCopy(language)
    const detailStack = [this.state.error.stack ?? '', this.state.componentStack].filter(Boolean).join('\n\n')

    return (
      <ThemeProvider colorMode={theme}>
        <BaseStyles>
          <div className="loading-shell fatal-error-shell">
            <div className="loading-card fatal-error-card">
              <div className="eyebrow">{copy.eyebrow}</div>
              <h1>{copy.title}</h1>
              <div className="fatal-error-summary">
                <strong>{copy.errorLabel}</strong>
                <p>{this.state.error.message || String(this.state.error)}</p>
              </div>

              <div className="panel-alert" role="status">
                {this.state.recentCrash?.sessionHistoryEntryIds.length
                  ? copy.archived
                  : copy.noArchive}
              </div>

              {this.state.actionError ? (
                <div className="panel-alert" role="alert">
                  {this.state.actionError}
                </div>
              ) : null}

              {detailStack ? (
                <details className="fatal-error-details">
                  <summary>{copy.details}</summary>
                  <pre>{detailStack}</pre>
                </details>
              ) : null}

              <div className="loading-actions">
                <AppButton tone="primary" type="button" onClick={this.handleReload}>
                  {copy.reload}
                </AppButton>
                <AppButton type="button" disabled={this.state.resetting} onClick={this.handleReset}>
                  {this.state.resetting ? copy.resetPending : copy.reset}
                </AppButton>
              </div>
            </div>
          </div>
        </BaseStyles>
      </ThemeProvider>
    )
  }
}
