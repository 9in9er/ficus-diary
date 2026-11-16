import titlePic from '../i/title_pic.png';

function Header({
  showCount,
  count,
  compact = false
}) {
  const lastDigit = count % 10;
  const lastTwoDigits = count % 100;
  const countLabel = lastDigit === 1 && lastTwoDigits !== 11
    ? 'растение'
    : lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14)
      ? 'растения'
      : 'растений';

  return (
    <header>
      <h1 className='appTitle'>
        <img src={titlePic} className='titlePic' alt='logo' />
        Фикус{showCount && typeof count === 'number' && (compact
          ? <span className='plantCount'>{count}<span className='plantCountLabel'> {countLabel}</span></span>
          : ` (${count})`)}
      </h1>
    </header>
  );
}

export default Header;
