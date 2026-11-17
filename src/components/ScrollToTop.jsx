import { useEffect, useState } from 'react';

function ScrollToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const toggleVisibility = () => {
      setVisible(window.pageYOffset > 400);
    };

    window.addEventListener('scroll', toggleVisibility);
    return () => window.removeEventListener('scroll', toggleVisibility);
  }, []);

  const handleClick = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <button
      type="button"
      className={`btnScrollTop ${visible ? 'visible' : ''}`}
      tabIndex={visible ? 0 : -1}
      aria-hidden={!visible}
      aria-label="Наверх"
      onClick={handleClick}
    >
      ↑
    </button>
  );
}

export default ScrollToTop;
