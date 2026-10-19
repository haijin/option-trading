import { Modal } from '../components/Modal';
import { toHash } from '../lib/route';
import { useAuth } from '../state/auth';
import { useTheme } from '../state/theme';
import { Icon } from './Icon';
import { MORE_ITEMS } from './nav';

/** The pages that have no tab, plus the theme switch and sign-out. A bottom sheet on a phone, a dialog on a desktop. */
export function MoreSheet({ onClose }: { onClose: () => void }) {
  const { effective, toggle } = useTheme();
  const { session, user, signOut } = useAuth();
  return (
    <Modal
      title="More"
      onClose={onClose}
      className="more-sheet"
      footer={
        <>
          <button type="button" className="btn" onClick={toggle}>
            <Icon name={effective === 'dark' ? 'sun' : 'moon'} size={18} />
            {effective === 'dark' ? 'Light theme' : 'Dark theme'}
          </button>
          {session?.authRequired && user ? (
            <button type="button" className="btn" onClick={() => void signOut()}>
              <Icon name="logout" size={18} />
              Sign out {user.username}
            </button>
          ) : null}
        </>
      }
    >
      <nav className="more-list" aria-label="More pages">
        {MORE_ITEMS.map((item) => (
          <a key={item.id} className="more-row" href={toHash({ page: item.id })} onClick={onClose}>
            <Icon name={item.icon} size={22} />
            <span>
              <b>{item.label}</b>
              <span className="sub">{item.sub}</span>
            </span>
            <span className="go" aria-hidden="true">
              &rsaquo;
            </span>
          </a>
        ))}
      </nav>
    </Modal>
  );
}
