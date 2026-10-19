import type { ReactNode, Ref } from 'react';
import { useIsMobile } from '../hooks/useMediaQuery';
import { Icon } from './Icon';

/**
 * Master/detail pane pair. Desktop shows both side by side. A phone shows one at a time, the way the iOS spec
 * goes from the chats list to a thread: the list, or the detail under a green header with a back arrow.
 */
export function MasterDetail({
  list,
  detail,
  showDetail,
  title,
  subtitle,
  onBack,
  detailRef,
  busy,
}: {
  list: ReactNode;
  detail: ReactNode;
  /** On a phone, true shows the detail instead of the list. Ignored on desktop. */
  showDetail: boolean;
  title?: ReactNode;
  subtitle?: ReactNode;
  onBack?: () => void;
  detailRef?: Ref<HTMLDivElement>;
  busy?: boolean;
}) {
  const mobile = useIsMobile();
  if (mobile && !showDetail) {
    return (
      <div className="two one" aria-busy={busy || undefined}>
        {list}
      </div>
    );
  }
  if (mobile) {
    return (
      <div className="two one" aria-busy={busy || undefined}>
        <div className="mhead">
          <button type="button" className="back" onClick={onBack} aria-label="Back to the list">
            <Icon name="back" size={26} strokeWidth={2.4} />
          </button>
          <div className="meta">
            <div className="name">{title}</div>
            {subtitle ? <div className="status">{subtitle}</div> : null}
          </div>
        </div>
        <div className="detail" ref={detailRef}>
          {detail}
        </div>
      </div>
    );
  }
  return (
    <div className="two" aria-busy={busy || undefined}>
      {list}
      <div className="detail" ref={detailRef}>
        {detail}
      </div>
    </div>
  );
}
