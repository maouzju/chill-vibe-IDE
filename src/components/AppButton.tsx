import { Button as PrimerButton, type ButtonProps as PrimerButtonProps } from '@primer/react'

type AppButtonProps = Omit<PrimerButtonProps, 'size' | 'variant'> & {
  tone?: 'primary' | 'ghost'
}

export const AppButton = ({ tone = 'ghost', className, children, ...props }: AppButtonProps) => (
  <PrimerButton
    size="small"
    variant={tone === 'primary' ? 'primary' : 'default'}
    className={`btn ${tone === 'primary' ? 'btn-primary' : 'btn-ghost'}${className ? ` ${className}` : ''}`}
    {...props}
  >
    {children}
  </PrimerButton>
)
