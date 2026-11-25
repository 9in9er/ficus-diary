import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatDate, getDaysSinceLastAction } from '../utils/plantDates';
import closeIcon from '../i/icons/close.svg';
import deleteIcon from '../i/icons/trash.svg';

const HISTORY_OPEN_EVENT = 'plant-care-history-open';
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const POPOVER_GAP = 8;
const VIEWPORT_MARGIN = 8;

function calendarDayNumber(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_IN_MS;
}

export function getCareHistoryStats(log) {
  const entries = (Array.isArray(log) ? log : [])
    .map((value) => ({ value, day: calendarDayNumber(value) }))
    .filter(({ day }) => day !== null)
    .sort((a, b) => b.day - a.day);

  const rows = entries.map((entry, index) => ({
    ...entry,
    interval: index === entries.length - 1 ? null : entry.day - entries[index + 1].day,
  }));
  const intervals = rows.map(({ interval }) => interval).filter((interval) => interval !== null);

  return {
    rows,
    average: intervals.length
      ? intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length
      : null,
  };
}

function formatAverage(value) {
  return Number(value.toFixed(1)).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

function pluralizeDays(value) {
  if (!Number.isInteger(value)) return 'дня';
  const lastTwo = Math.abs(value) % 100;
  const last = lastTwo % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return 'дней';
  if (last === 1) return 'день';
  if (last >= 2 && last <= 4) return 'дня';
  return 'дней';
}

export default function PlantCareHistory({
  plantId, log, title, historyTitle, emptyMessage, icon, iconAlt,
  actionClassName, listClassName, isTrash, isPending, onAction, onDelete,
}) {
  const popupId = useId();
  const anchorRef = useRef(null);
  const popupRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 300, visibility: 'hidden' });
  const daysSinceLast = getDaysSinceLastAction(log);
  const elapsed = daysSinceLast === 0 ? 'сегодня' : `${daysSinceLast} дн. назад`;
  const { rows, average } = getCareHistoryStats(log);
  const careType = actionClassName === 'btnWatering' ? 'watering' : 'fertilizing';

  const close = useCallback(() => setIsOpen(false), []);

  const updatePosition = useCallback(() => {
    if (!anchorRef.current || !popupRef.current) return;
    const anchorRect = anchorRef.current.getBoundingClientRect();
    const popupRect = popupRef.current.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - VIEWPORT_MARGIN * 2);
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, anchorRect.left),
      window.innerWidth - width - VIEWPORT_MARGIN
    );
    const below = anchorRect.bottom + POPOVER_GAP;
    const above = anchorRect.top - popupRect.height - POPOVER_GAP;
    const top = below + popupRect.height <= window.innerHeight - VIEWPORT_MARGIN
      ? below
      : Math.max(VIEWPORT_MARGIN, above);

    setPosition({ top, left, width, visibility: 'visible' });
  }, []);

  useLayoutEffect(() => {
    if (isOpen) updatePosition();
  }, [isOpen, rows.length, updatePosition]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handlePointerDown = (event) => {
      if (!popupRef.current?.contains(event.target) && !anchorRef.current?.contains(event.target)) close();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') close();
    };
    const handleOtherPopup = (event) => {
      if (event.detail !== popupId) close();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener(HISTORY_OPEN_EVENT, handleOtherPopup);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener(HISTORY_OPEN_EVENT, handleOtherPopup);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [close, isOpen, popupId, updatePosition]);

  const toggleHistory = () => {
    if (isOpen) {
      close();
      return;
    }
    document.dispatchEvent(new CustomEvent(HISTORY_OPEN_EVENT, { detail: popupId }));
    setPosition((current) => ({ ...current, visibility: 'hidden' }));
    setIsOpen(true);
  };

  const popup = isOpen && createPortal(
    <div
      ref={popupRef}
      className={`plantCarePopover plantCarePopover--${careType}`}
      style={position}
      role='dialog'
      aria-label={historyTitle}
    >
      <div className='plantCarePopoverHeader'>
        <strong>{historyTitle}</strong>
        <button className='plantCarePopoverClose' type='button' aria-label='Закрыть историю' onClick={close}>
          <img src={closeIcon} alt='' />
        </button>
      </div>
      <ul className={`plantCarePopoverList ${listClassName}`}>
        {rows.map(({ value, interval }, index) => (
          <li key={`${value}-${index}`}>
            <span className='plantCareDot' aria-hidden='true' />
            <time dateTime={value}>{formatDate(value)}</time>
            <span className='plantCareInterval'>{interval === null ? '—' : `+${interval} дн.`}</span>
            {!isTrash && (
              <button
                className='plantCareDelete'
                type='button'
                disabled={isPending}
                aria-label={`Удалить запись: ${historyTitle.toLowerCase()}, ${formatDate(value)}`}
                onClick={() => onDelete(plantId, log, value)}
              >
                <img src={deleteIcon} alt='' />
              </button>
            )}
          </li>
        ))}
      </ul>
      {average !== null && (
        <div className='plantCareAverage'>
          <span>Средний интервал между {careType === 'watering' ? 'поливами' : 'удобрениями'}</span>
          <strong>{formatAverage(average)} {pluralizeDays(Number(average.toFixed(1)))}</strong>
          <small>По последним {rows.length} записям</small>
        </div>
      )}
    </div>,
    document.body
  );

  return (
    <div className='plantCareRow'>
      {!isTrash && (
        <button className={`btn plantCareAction ${actionClassName}`} type='button' disabled={isPending} aria-label={iconAlt} onClick={onAction}>
          <img src={icon} alt='' />
        </button>
      )}
      <div className='plantCareContent'>
        {log.length > 0 ? (
          <button
            ref={anchorRef}
            className='plantCareSummary plantCareSummary--interactive'
            type='button'
            aria-haspopup='dialog'
            aria-expanded={isOpen}
            disabled={isPending}
            onClick={toggleHistory}
          >
            <span className='plantCareTitle'>{title}</span>
            <span className='plantCareElapsed'>{elapsed}</span>
          </button>
        ) : (
          <div className='plantCareSummary plantCareSummary--empty'>
            <span className='plantCareTitle'>{title}</span>
            <span className='plantCareElapsed'>{emptyMessage}</span>
          </div>
        )}
      </div>
      {popup}
    </div>
  );
}
