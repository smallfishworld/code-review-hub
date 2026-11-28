import { useState, type InputHTMLAttributes } from 'react';
import { useI18n } from '../i18n';

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

/** Password field with a show/hide visibility toggle. */
export function PasswordInput(props: PasswordInputProps) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-field">
      <input {...props} type={visible ? 'text' : 'password'} />
      <button
        type="button"
        className="password-toggle"
        aria-label={visible ? t('password.hideLabel') : t('password.showLabel')}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
        tabIndex={-1}
      >
        {visible ? t('password.hide') : t('password.show')}
      </button>
    </div>
  );
}
