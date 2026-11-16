import { formatDate, getDaysSinceLastAction } from '../utils/plantDates';

export default function PlantCareHistory({ plantId, log, title, emptyMessage, className, listClassName, isTrash, onDelete }) {
  const daysSinceLast = getDaysSinceLastAction(log);
  const label = <strong>{title}: <br /></strong>;

  return (
    <div className={className}>
      {log.length > 0 && !isTrash ? (
        <details>
          <summary>
            {label}
            <span>{daysSinceLast === 0 ? 'сегодня' : `${daysSinceLast} дн. назад`}</span>
          </summary>
          <ul className={listClassName}>
            {[...log].reverse().map((date) => (
              <li key={date}>
                {formatDate(date)}
                <button className='btn btnDelete' type='button' aria-label={`Удалить запись: ${title.toLowerCase()}, ${formatDate(date)}`} onClick={() => onDelete(plantId, log, date)}>✖</button>
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p>{label}<span>{emptyMessage}</span></p>
      )}
    </div>
  );
}
