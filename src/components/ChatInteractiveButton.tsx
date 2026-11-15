import React from 'react';
import {
  AlertTriangle,
  CornerDownRight,
  Cpu,
  RefreshCw,
  Terminal,
  Users,
  Zap,
} from 'lucide-react';
import { Button } from '@vector-im/compound-web';

interface ChatInteractiveButtonProps {
  label: string;
  action: string;
  onAction?: (actionValue: string, label?: string) => void;
  disabled?: boolean;
}

export const ChatInteractiveButton: React.FC<ChatInteractiveButtonProps> = ({
  label,
  action,
  onAction,
  disabled = false,
}) => {
  const normalizedAction = action.trim().toLowerCase();
  const icon = normalizedAction.startsWith('tab:terminals')
    ? <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
    : normalizedAction.startsWith('tab:agents')
      ? <Users className="w-3.5 h-3.5" aria-hidden="true" />
      : normalizedAction.startsWith('tab:kernel')
        ? <Cpu className="w-3.5 h-3.5" aria-hidden="true" />
        : normalizedAction.startsWith('tab:linux')
          ? <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
          : normalizedAction === 'action:connect_ai' || normalizedAction === 'connect_ai'
            ? <Zap className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
            : normalizedAction === 'action:sync' || normalizedAction === 'sync'
              ? <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              : disabled
                ? <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                : <CornerDownRight className="w-3.5 h-3.5" aria-hidden="true" />;

  return (
    <Button
      type="button"
      kind="secondary"
      size="md"
      onClick={() => onAction?.(action, label)}
      disabled={disabled}
      title={disabled ? 'Przyciski czatu nie mogą uruchamiać poleceń powłoki.' : undefined}
      className="my-1 mr-2 active:scale-95"
    >
      {icon}
      {label}
    </Button>
  );
};
