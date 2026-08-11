import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { PlayerCareerSection } from './PlayerCareerSection';

interface PlayerCareerModalProps {
  playerName: string;
  /** stats.nba.com id. History rows already carry it, so no lookup is needed. */
  nbaPlayerId: string;
  onClose: () => void;
}

/**
 * One player's previous seasons, opened from a row on the Season History page.
 *
 * Portalled to `document.body` for the same reason `Rating2kModal` is: daisyUI
 * gives `.modal-box` a non-`none` scale, which would make any enclosing modal
 * box the containing block for this one's `position: fixed` and squeeze it.
 */
export const PlayerCareerModal = ({
  playerName,
  nbaPlayerId,
  onClose,
}: PlayerCareerModalProps): JSX.Element => {
  // escape closes it from anywhere, including while the request is in flight.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="modal modal-open" role="dialog" aria-label="Season history">
      <div className="modal-box max-w-3xl">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h3 className="font-bold text-xl truncate" title={playerName}>
              {playerName}
            </h3>
            <p className="text-sm opacity-60">Every season on record</p>
          </div>
          <button
            className="btn btn-sm btn-circle btn-ghost"
            onClick={onClose}
            aria-label="Close season history"
          >
            ✕
          </button>
        </div>

        <PlayerCareerSection
          nbaPlayerId={nbaPlayerId}
          emptyMessage="No season history for this player."
        />
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>,
    document.body
  );
};
