import type { IdeaView } from '../../api/types';
import { n2, strikeText } from '../../lib/format';
import { noSizeFits, ticketContracts, ticketText } from '../../lib/ticket';
import { useToast } from '../../state/toast';

/** The order ticket as one line, with copy and "I sold it". The app never places orders. */
export function TicketBar({ idea, onLogFill }: { idea: IdeaView; onLogFill: () => void }) {
  const toast = useToast();
  const { contract } = idea;
  const noSize = noSizeFits(idea);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ticketText(idea));
      toast.push('Ticket copied. Place it in your broker yourself: the app never trades.');
    } catch {
      toast.error('Could not reach the clipboard. Select the ticket text and copy it yourself; the app never trades.');
    }
  };

  return (
    <div className="ticket">
      <div className="t">
        {noSize ? (
          <>
            No size fits your limits: {idea.symbol} {contract.expiry} <em>{strikeText(contract.strike)}</em> PUT @
            &asymp;{n2(contract.premium)} <span className="src">({contract.priceSource})</span>
          </>
        ) : (
          <>
            SELL <em>{ticketContracts(idea)}</em> &times; {idea.symbol} {contract.expiry}{' '}
            <em>{strikeText(contract.strike)}</em> PUT @ &asymp;
            {n2(contract.premium)} <span className="src">({contract.priceSource})</span>
          </>
        )}
      </div>
      <div className="row">
        <button
          type="button"
          className="btn"
          onClick={copy}
          disabled={noSize}
          title={noSize ? 'Nothing to place: zero contracts fit' : undefined}
        >
          Copy ticket
        </button>
        <button type="button" className="btn primary" onClick={onLogFill}>
          I sold it: log fill
        </button>
      </div>
    </div>
  );
}
