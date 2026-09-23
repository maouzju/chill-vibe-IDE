import type { AppLanguage, Provider } from '../../../shared/schema'
import { getProviderLabel } from '../../../shared/i18n'
import { AppButton } from '../AppButton'
import { isEnvironmentHealthAllOk, type EnvironmentHealth, type HealthFix, type HealthLight } from './settings-model'
import { getSettingsPanelText } from './settings-text'

export type EnvironmentHealthCardProps = {
  language: AppLanguage
  health: EnvironmentHealth
  pending?: boolean
  onFix: (fix: HealthFix) => void
  onRefresh: () => void
}

const lightOrder = ['cli', 'account', 'version'] as const

const describe = (
  key: (typeof lightOrder)[number],
  light: HealthLight,
  language: AppLanguage,
  text: ReturnType<typeof getSettingsPanelText>['health'],
) => {
  if (light.state === 'unknown') {
    return text.detail.unknown
  }
  const names = (providers: Provider[]) =>
    providers.map((provider) => getProviderLabel(language, provider)).join(' / ')

  if (key === 'cli') {
    return light.state === 'ok'
      ? text.detail.cliOk
      : light.providers.length === 0
        ? text.detail.cliMissing
        : text.detail.cliPartial(names(light.providers))
  }
  if (key === 'account') {
    if (light.state !== 'ok') {
      return text.detail.accountMissing
    }
    return light.viaCliLogin ? text.detail.accountCliLogin : text.detail.accountOk
  }
  return light.state === 'ok'
    ? text.detail.versionOk
    : text.detail.versionMismatch(names(light.providers))
}

export function EnvironmentHealthCard({ language, health, pending, onFix, onRefresh }: EnvironmentHealthCardProps) {
  const text = getSettingsPanelText(language).health

  // 全绿只给一行结论；有灯不绿才展开三行明细和修复按钮。
  if (isEnvironmentHealthAllOk(health)) {
    return (
      <section className="settings-health-card is-compact" aria-label={text.title} data-testid="settings-health-card">
        <div className="settings-health-head">
          <span className="settings-health-item is-ok">
            <span className="settings-health-light" aria-hidden="true" />
          </span>
          <span className="settings-health-summary">{text.allOk}</span>
          <AppButton type="button" disabled={pending} onClick={onRefresh}>
            {text.refresh}
          </AppButton>
        </div>
      </section>
    )
  }

  return (
    <section className="settings-health-card" aria-label={text.title} data-testid="settings-health-card">
      <div className="settings-health-head">
        <h3 className="settings-group-title">{text.title}</h3>
        <AppButton type="button" disabled={pending} onClick={onRefresh}>
          {text.refresh}
        </AppButton>
      </div>
      <ul className="settings-health-list">
        {lightOrder.map((key) => {
          const light = health[key]
          return (
            <li key={key} className={`settings-health-item is-${light.state}`} data-health={key} data-state={light.state}>
              <span className="settings-health-light" aria-hidden="true" />
              <div className="settings-health-copy">
                <strong>{text[key]}</strong>
                <span className="settings-note">{describe(key, light, language, text)}</span>
              </div>
              <span className="settings-health-state">{text.state[light.state]}</span>
              {light.fix ? (
                <AppButton
                  tone="primary"
                  type="button"
                  disabled={pending}
                  onClick={() => onFix(light.fix as HealthFix)}
                >
                  {text.fix[light.fix.kind]}
                </AppButton>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
