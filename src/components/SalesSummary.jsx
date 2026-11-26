import { formatMoney, formatDifference, salesSummary } from '../utils/plantSales';

export default function SalesSummary({ plants }) {
  const summary = salesSummary(plants);
  return <section className='salesSummary' aria-label='Сводка продаж'>
    <div className='salesSummaryMain'>
      <p>Получено с продаж<strong>{formatMoney(summary.revenue)}</strong></p>
      <p>Продано растений<strong>{summary.count}</strong></p>
    </div>
    <div className='salesSummaryDetails'>
      <span>Стоимость покупки: {formatMoney(summary.purchase)}</span>
      <span className={summary.difference < 0 ? 'saleDifference--negative' : 'saleDifference--positive'}>Разница: {formatDifference(summary.difference)}</span>
    </div>
    {summary.incomplete && <p className='saleHint'>Расчёт разницы неполный: учтены только растения с известной ценой покупки.</p>}
  </section>;
}
