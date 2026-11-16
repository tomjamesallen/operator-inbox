import { InboxPage } from './components/inbox/page';

// The app is one page: the inbox. `/`, `/inbox` and `/inbox/<inboxId>` all
// draw it, and it reads its own selection from the path (`selectedInboxAtom`
// in `./inbox`). `operator-inbox serve` answers each of those paths with this
// shell, so there is no router.
export const App = () => <InboxPage />;
