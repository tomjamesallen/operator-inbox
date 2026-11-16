import {
  type InboxBoardDto,
  type InboxClashDto,
  inboxClashSentence,
  LOCAL_MACHINE,
  LOCAL_MACHINE_KEY,
} from '@operator-inbox/core/api';

// The inbox page's own wording for the board's machine fields. Only this page
// says them, so they live here, not in core. A refused clash still reads through core's
// `inboxClashSentence`, the one sentence serve's refusal and this notice share.

// The page's notice for a clash, either outcome. `refused` is the refusal's
// own sentence; `kept-on-local` names the machines whose claim is left out
// beside Local's.
export const inboxClashNotice = (clash: InboxClashDto): string => {
  if (clash.outcome === 'refused')
    return inboxClashSentence(
      clash.inboxId,
      clash.claims.map((c) => c.machine),
    );
  const others = clash.claims.filter(
    (c) => c.machine.key !== LOCAL_MACHINE_KEY,
  );
  return `the Inbox ${clash.inboxId} is ${LOCAL_MACHINE}'s, and ${others.map((c) => c.machine.label).join(' and ')} claims it too: ${LOCAL_MACHINE}'s is shown, and the other claim is left out`;
};

// A clash's heading: the name, since the sentence prints the raw id. Each
// machine may call it something else, so every name is given.
export const inboxClashHeading = (clash: InboxClashDto): string => {
  const names = [...new Set(clash.claims.map((c) => c.label))];
  return `${clash.claims.length === 2 ? 'Two' : clash.claims.length} machines claim ${names.join(' and ')}`;
};

// The page's banner when serve could not read `inboxMachines` (or
// config.json): a lead-in saying what serve kept, then serve's own sentence
// (`machinesOff`). Serve sets it at start-up, reading no machine, so
// `machines` holds Local alone, and on a re-read, keeping the machines it
// read before, still listed. Unset when serve read them.
export const machinesOffBanner = (
  board: Pick<InboxBoardDto, 'machines' | 'machinesOff'>,
): string | undefined => {
  if (board.machinesOff === undefined) return undefined;
  const lead = (board.machines ?? []).some((m) => m.status !== 'local')
    ? 'The Inbox machines could not be read again: '
    : `No other machine's Inboxes are read, so this page shows ${LOCAL_MACHINE}'s alone: `;
  return `${lead}${board.machinesOff}`;
};
